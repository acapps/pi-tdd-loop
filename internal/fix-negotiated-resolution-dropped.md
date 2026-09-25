# fix-negotiated-resolution-dropped

## Problem

Verified current state as of writing (2026-09-24):

When a **negotiate-phase** dispute is resolved by agreement and the loop
auto-advances to Phase B, the **negotiated resolution is not carried into the
Phase B prompt**. The resolution can therefore be silently dropped when it
names work that the Phase B role is structurally barred from doing (a test-file
change, which only the Tester may make).

This is proven by session `01a0d128` (spec
`internal/done-bug-role-context-mismatch.md`, the archived twin of the spec
this file supersedes). The verified event sequence:

- `02:42:31` `[NEGOTIATE] propose` — the **Writer** files a dispute: the new
  tests were written in a new file `test/events/b-phase-role-context.test.ts`,
  but the spec's Inventory / Test Strategy / Scope lines pin them to
  `test/events/before-agent.test.ts` ("No file added").
- `02:45:55` `[NEGOTIATE] review` — the **Tester** concedes, choosing
  **Option (a)**: *"move the new describes into `test/events/before-agent.test.ts`
  (Phase B block) and delete `test/events/b-phase-role-context.test.ts`."*
- `02:49:18` `[NEGOTIATE] propose: agree` → `Approved → Phase B`.
- `02:49:29` Writer message: *"Agreed — the tests match the spec. During
  implementation I will: 1. Move the new Phase B dispute-sub-flow describes
  into `test/events/before-agent.test.ts` … and delete
  `test/events/b-phase-role-context.test.ts`. 2. Add the two module-private
  helpers …"*
- `02:49:29` Phase B prompt sent: `promptNegotiateAutoAdvance()` →
  *"Advancing to Phase B without explicit approval. Write TypeScript source
  files. … Read *.test.ts and *.ts stubs. Implement the logic."* — the
  negotiated move+delete is **not in this prompt**.
- `02:54:16` `[TOOLERR] edit: Phase B/C: you may only write source files
  (non-test). Cannot modify test files.` — the Writer **refused** the test-file
  edit, because Phase B is the Writer role and the resolution is a Tester action.
- `02:56:14` gate **green** (the stray file *does* pass, so the gate cannot
  see the violation), loop advances to Phase C → done.

Result: the resolution was negotiated, agreed, and stated by the Writer — and
then never executed. `test/events/b-phase-role-context.test.ts` is still in the
tree and `test/events/before-agent.test.ts` carries none of the 15 tests. The
loop reported success.

The structural cause, verified in code:

- `src/events/agent-settled/negotiate.ts:151` `deliverAdvance` sends
  `lang.prompts.promptNegotiateAutoAdvance()` — a **generic** prompt
  (`src/languages/typescript.ts:65`, `go.ts:67`, `java.ts:66`) that says "write
  source files" and carries **none** of the agreement's content.
- The Writer's own "I will: 1. Move … 2. Add …" message is a *chat message*,
  not state. Nothing persists the resolution, so there is nothing to carry
  forward and nothing to verify against.
- The role boundary (`refusalMessage.phaseC` / the tool-call enforcer) correctly
  bars the Writer from editing `*.test.ts`. That boundary is **correct and must
  not be relaxed** — the bug is that the resolution has no delivery path to the
  only actor who can perform it.

This is a **failure class D ("all tests pass" lie)** at the negotiation layer:
the gate is green, the loop reports done, but a negotiated commitment was never
made and there is no assertion that it was.

## Target

After the change, when a negotiate dispute is resolved by agreement and the
loop advances to Phase B, the **agreed resolution is (1) persisted into state,
(2) delivered to the correct actor, and (3) verified before the loop is allowed
to report done.** Concretely:

- The negotiated resolution is captured as a first-class state field
  (`state.negotiateResolution`) when the Tester's review concedes, so it
  survives reload and is visible to the advance path.
- `deliverAdvance` appends the resolution to the Phase B prompt, **routed by
  what the resolution requires**: a test-file change is flagged as *Tester
  work the Writer must not perform*, and the loop either (a) routes it to a
  Tester turn, or (b) blocks the advance with an explicit, visible
  "resolution not executable in Phase B — escalating" outcome. The Writer is
  never silently left holding a commitment it cannot keep.
- A **done-effect gate check** refuses to report "All phases complete" while an
  unexecuted `negotiateResolution` is still open, so the spurious-green shape is
  impossible: the loop cannot claim done with an outstanding negotiated
  obligation.

The role boundary (Writer cannot write `*.test.ts`) is unchanged.

## Interface

New optional state field (optional/nullable extension, not a rewrite — the
`dispute` object at `src/types.ts:22` is the precedent for an optional
sub-object healed on restore):

```ts
// src/types.ts — LoopState
/** The agreed resolution of a negotiate dispute, captured at concession.
 *  Present when a negotiate dispute was resolved by agreement and the loop
 *  advanced to Phase B; cleared once the resolution is executed or the loop
 *  reports done. Absent → no open resolution (pre-change sessions are valid). */
negotiateResolution?: {
  /** Verbatim resolution text (the Tester's conceded option, or the agree). */
  text: string;
  /** True when the resolution requires a test-file change (Tester work). */
  touchesTests: boolean;
  /** True once the resolution has been executed. */
  executed: boolean;
};
```

`src/state-validation.ts`: `negotiateResolution` is **optional** at the shape
level (absent = no open resolution). When present, it is an object with the
three fields above. The session-start restore path heals absent → `undefined`
(no explicit default needed — absence is the valid "none" state, matching the
`dispute` field's restore behavior at `src/state-validation.ts:120`).

`src/transitions.ts` `computeNegotiateTransition`: the `advance` effect gains
the resolution so `deliverAdvance` can read it. No signature change to
`computeNegotiateTransition`'s inputs; the effect payload carries
`resolution?: { text: string; touchesTests: boolean }`.

No signature change to `handleNegotiateSettled`, `handleGateTransition`, or the
`applyDoneEffect` public entry — the change is in the effect payloads and the
delivery/verification helpers.

Persisted state: the new field is written by `commit(state, pi, debug)` at the
same points the `dispute` field is written (concession, advance, execution).
Pre-change session entries carry no `negotiateResolution` → restore as
`undefined` → no open resolution → the done gate does not fire. No migration.

## Behavior

### Where the resolution is captured (negotiate review → concede)

Decision table for the Tester's negotiate review outcome (first-match-wins):

| # | Condition | Action | `negotiateResolution` |
|---|-----------|--------|-----------------------|
| 1 | review is a concession that names a resolution (e.g. "Option (a): move … and delete …") | record resolution; proceed to agree/advance | `{ text: <verbatim>, touchesTests: <detected>, executed: false }` |
| 2 | review is a concession with no named resolution (plain "agree") | proceed to advance | `undefined` (nothing to enforce) |
| 3 | review is feedback / dispute (not a concession) | unchanged — no resolution captured | `undefined` |

`touchesTests` is detected by scanning the resolution text for a test-file
token (a backtick-quoted or plain path ending in `.test.ts` / `_test.go` /
`Test.java` / `.test.js` / `.spec.ts`, or the words "test file" / "test files").
This is a heuristic; a false negative (a test change not flagged) degrades to
the *current* behavior (no routing), never to a false block. A false positive
(blocks a non-test resolution) is a visible escalation, not a silent drop —
the safe direction.

### Where the resolution is delivered (deliverAdvance)

`deliverAdvance` (negotiate.ts) currently sends `promptNegotiateAutoAdvance()`.
After the change, it sends that prompt **plus** a resolution block when
`state.negotiateResolution` is present and not yet executed:

- `touchesTests === false` (or absent): append the resolution verbatim as
  "Agreed resolution to apply: <text>" — the Writer can do this (source-only).
- `touchesTests === true`: the resolution requires a test-file change the
  Writer cannot make. The advance is **blocked** and routed to a **Tester
  turn** that carries the resolution, with the Writer prompt explicitly noting
  the test change is *not* for it to make. The Tester turn is the only actor
  that may write `*.test.ts`. (See "open design decision" below — the
  minimal safe version is the escalate-and-notify path, not a new Tester
  sub-phase.)

Verbatim pins (the strings a user sees / a test asserts):

- Advance prompt with a source-only resolution appends, verbatim:
  `Agreed resolution to apply: <text>`
- Blocked advance (test-touching resolution) — the Writer prompt appends,
  verbatim: `The agreed resolution requires a test-file change, which Phase B (Writer) cannot make. Do NOT edit test files.`
- Blocked-advance notify (warning level):
  `Negotiated resolution requires test-file changes — routing to Tester; Phase B advance blocked.`
- Blocked-advance status: `Phase negotiate — resolution pending (Tester)`

### Where the resolution is verified (done gate)

`applyDoneEffect` (`src/events/agent-settled/effect-applicator.ts:149`) currently
reports done unconditionally (after the optional branch merge). After the
change, **before** `reportDone`, it checks:

| # | Condition | Action |
|---|-----------|--------|
| 1 | `state.negotiateResolution` present AND `executed === false` | do NOT report "All phases complete". Notify (warning): `Loop stopping with an unexecuted negotiated resolution: <text>`. Status: `done (resolution unexecuted)`. No "All phases complete" message. |
| 2 | `state.negotiateResolution` present AND `executed === true` (or absent) | report done as today (unchanged). |

The `executed` flag is set `true` when the resolution's required change is
verified present (the gate re-runs and the test file now contains the moved
content / the stray file is gone). For the minimal version, `executed` is set
when the Tester turn that performed the resolution settles green.

### Side-effect contract

- UI: two new `ctx.ui.notify` calls (blocked-advance warning; unexecuted-
  resolution warning) and two new `ctx.ui.setStatus` strings (pinned above).
- Messages: `deliverAdvance` sends one prompt (auto-advance, possibly with the
  resolution block appended); the blocked path sends a Tester prompt instead of
  advancing. No new `sendPrompt` on the happy source-only path beyond the
  existing one.
- State mutations: `negotiateResolution` set at concession (row 1), `executed`
  set at execution, field cleared (or left `executed: true`) at done. Order:
  set-before-send + persist-before-send, matching the `dispute` handlers'
  crash-safety contract (`src/events/agent-settled/dispute.ts` S2).
- Persistence: `commit` at the same points as `dispute`.

### Quirks list (current behavior, do not fix)

- The Writer's free-form "I will: 1. … 2. …" message is a chat message with no
  state backing. **Current behavior, do not fix** — the fix captures the
  *resolution* into state; it does not parse arbitrary Writer promises.
- `promptNegotiateAutoAdvance` is a generic "write source files" prompt shared
  by all three languages. **Current behavior** — the resolution block is
  *appended* to it, not a rewrite of the per-language prompt.
- The role boundary refusing Writer test-file edits is **correct, do not
  relax.** The bug is the missing delivery path, not the boundary.

### Intended shifts

- **Before:** a test-touching negotiated resolution advances to Phase B, the
  Writer cannot perform it, the gate goes green, the loop reports done.
  **After:** the same resolution blocks the advance, routes to the Tester, and
  the done gate refuses to report complete until it is executed. This is
  intended, not a quirk.
- **Before:** `negotiateResolution` absent from state. **After:** present when
  a negotiate concession names a resolution. Pre-change sessions (absent) are
  unaffected because absence is the "none" state.

### Ownership

- `src/events/agent-settled/negotiate.ts` owns capture-at-concession routing
  and `deliverAdvance` resolution delivery. Asserted in
  `test/events/agent-settled/negotiate.test.ts`.
- `src/events/agent-settled/effect-applicator.ts` owns the done-gate check.
  Asserted in `test/events/agent-settled/effect-applicator.test.ts`.
- `src/transitions.ts` owns the `advance` effect carrying the resolution.
  Asserted in `test/transitions.test.ts`.
- `src/state-validation.ts` + `src/types.ts` own the field shape + restore.
  Asserted in `test/state-validation.test.ts`.

## Inventory

- **Files:**
  - `src/types.ts` — add optional `negotiateResolution` field to `LoopState`
    (modify).
  - `src/state-validation.ts` — validate optional `negotiateResolution` shape;
    restore heals absent → `undefined` (modify).
  - `src/transitions.ts` — `computeNegotiateTransition` `advance` effect carries
    `resolution?` (modify).
  - `src/events/agent-settled/negotiate.ts` — capture resolution at concession;
    `deliverAdvance` appends resolution block / blocks + routes when
    `touchesTests` (modify).
  - `src/events/agent-settled/effect-applicator.ts` — `applyDoneEffect`
    unexecuted-resolution check before `reportDone` (modify).
  - `src/languages/typescript.ts`, `src/languages/go.ts`, `src/languages/java.ts`
    — **no change** (the resolution block is appended by `deliverAdvance`, not
    baked into the per-language `promptNegotiateAutoAdvance`).
  - `test/events/agent-settled/negotiate.test.ts` — extend (no new file).
  - `test/events/agent-settled/effect-applicator.test.ts` — extend (no new file).
  - `test/transitions.test.ts` — extend (no new file).
  - `test/state-validation.test.ts` — extend (no new file).
- **Imports:** `negotiate.ts` — no new imports (uses existing `GP`, `sendPrompt`,
  `T`). `effect-applicator.ts` — no new imports. `transitions.ts` — no new
  imports. `types.ts` / `state-validation.ts` — no new imports.
- **Call sites:** `commit` called at concession + execution (same pattern as
  `dispute.ts`); `ctx.ui.notify` / `setStatus` at the two new points;
  `reportDone` guarded by the new check.
- **Exports:** no new exports. `negotiateResolution` is a state field, not a
  module export.

## Test Strategy

- **Baseline:** 1764/1764 passing as of writing (after the scope-check fix
  commit `be3587b`). No existing test asserts the *absence* of a resolution
  delivery, so none are expected to flip. The `deliverAdvance` test currently
  asserts the auto-advance prompt is sent; it is **extended** (not rewritten)
  to also assert the resolution block when a resolution is present.
- **Per-test disposition:**
  - Kept unchanged: all existing `negotiate.test.ts`, `effect-applicator.test.ts`,
    `transitions.test.ts`, `state-validation.test.ts` tests (the new field is
    optional, so old fixtures remain valid — the mechanism that makes
    "all other tests kept unchanged" true is the optional-field extension, per
    the `dispute` precedent).
  - Extended: `deliverAdvance` test — new case "resolution present, source-only
    → prompt appends `Agreed resolution to apply: <text>`"; new case
    "resolution present, touchesTests → advance blocked, Tester prompt sent,
    warning notified, no advance".
  - Extended: `applyDoneEffect` test — new case "unexecuted resolution → no
    'All phases complete', warning notified, status `done (resolution
    unexecuted)`"; new case "executed/absent resolution → done as today".
- **New tests (one per pinned behavior):**
  1. Concession with a named test-file resolution → `negotiateResolution` set
     with `touchesTests: true`, `executed: false`.
  2. Concession with a source-only resolution → `touchesTests: false`.
  3. Plain "agree" (no named resolution) → `negotiateResolution` absent.
  4. `touchesTests` detection: a path ending `.test.ts` → true; a source path
     `src/foo.ts` → false; false negative degrades (no false block).
  5. `deliverAdvance` source-only → prompt carries the resolution block.
  6. `deliverAdvance` touchesTests → blocked, Tester prompt, warning notify,
     status pinned verbatim.
  7. `applyDoneEffect` unexecuted → no completion message, warning, status
     pinned verbatim.
  8. `applyDoneEffect` executed/absent → completion message (regression: the
     existing done path is unchanged).
  9. Restore: a pre-change state (no `negotiateResolution`) → validates,
     `negotiateResolution === undefined`, done gate does not fire.
  10. **Regression for session 01a0d128:** feed the exact sequence (Writer
      dispute → Tester Option (a) concede → agree → advance) and assert the
      advance is **blocked** (not silently dropped) and the done gate would
      refuse to report complete.
- **Untouched:** `src/languages/*.ts` (the per-language auto-advance prompts) —
  left alone because the resolution is appended by `deliverAdvance`; the
  mechanism that makes them valid unchanged is that no per-language prompt is
  edited.
- **Live-toolchain rules:** no test in this spec spawns a real tool. All tests
  mock `runGates` / `commit` / `sendPrompt` at the process boundary. No
  fixture buildability / tool-absence / timeout / verdict-field concerns apply
  (class M not triggered).

## Scope lines

- `src/types.ts` — modified (one optional field added).
- `src/state-validation.ts` — modified (optional shape check + restore).
- `src/transitions.ts` — modified (`advance` effect payload).
- `src/events/agent-settled/negotiate.ts` — modified (capture + deliver).
- `src/events/agent-settled/effect-applicator.ts` — modified (done gate).
- `test/events/agent-settled/negotiate.test.ts` — extended.
- `test/events/agent-settled/effect-applicator.test.ts` — extended.
- `test/transitions.test.ts` — extended.
- `test/state-validation.test.ts` — extended.
- **No file added. No file removed.** (The stray
  `test/events/b-phase-role-context.test.ts` from session 01a0d128 is a
  *working-tree* artifact of that session, not part of this change — its
  cleanup is a separate manual action, not in this spec's Inventory.)

## Acceptance Criteria

- **Hard:** `npx vitest run` passes (full suite, incl. the 10 new tests above).
- **Hard:** `npx tsc --noEmit` is clean.
- **Hard (grep, functional):** `grep -rn "negotiateResolution" src/` returns ≥
  1 hit in each of `types.ts`, `state-validation.ts`, `transitions.ts`,
  `negotiate.ts`, `effect-applicator.ts`.
- **Hard (grep, verbatim strings):** the three pinned strings appear exactly
  once each in `src/`:
  - `grep -rn "Agreed resolution to apply:" src/` → 1 hit
  - `grep -rn "requires a test-file change, which Phase B (Writer) cannot make" src/` → 1 hit
  - `grep -rn "Loop stopping with an unexecuted negotiated resolution" src/` → 1 hit
- **Hard (regression):** the session-01a0d128 regression test (new test #10)
  asserts the advance is blocked and the done gate refuses completion.
- **Soft:** the resolution routing is minimal and does not introduce a new
  Tester sub-phase or a new persisted flag beyond `negotiateResolution`
  (judgment: the escalate-and-notify path is acceptable if a full Tester-turn
  routing proves larger than this unit; the *invariant* is "never a silent
  drop", not the specific routing mechanism).

### Open design decision (flag, do not silently choose)

The minimal safe fix is: **persist the resolution + block the advance when it
touches tests + refuse done until executed.** Whether the blocked advance
*routes to a real Tester turn* (so the resolution is actually performed in-loop)
or *escalates to the human* (visible, stops, lets the person route it) is a
design choice that affects the state machine. This spec pins the **invariant**
(no silent drop, no spurious done) and the **minimal blocking** behavior; the
routing target (Tester turn vs. human escalation) is a Q to resolve in Phase 0
review. The default, absent a decision, is **human escalation** — it is the
smaller change and never leaves the Writer holding an unexecutable commitment.

## Dependencies

- `internal/done-bug-role-context-mismatch.md` (session 01a0d128) — the src
  fix (two prompt builders in `before-agent.ts`) is implemented and the spec
  archived; that work is **in the working tree, uncommitted**. This spec does
  not depend on it being committed — it fixes the *negotiation-layer* defect
  that let that session's resolution drop, independent of the src fix's
  commit state.
- `internal/fix-phase0-scanner-noise.md` (done) — unrelated; listed only to
  confirm no shared file.
- Scope-check gate (`src/scope-check.ts`, commit `be3587b`) — complementary,
  not a dependency: the scope gate catches *out-of-Inventory dirty files* at
  the gate; this spec catches *unexecuted negotiated obligations* at the
  negotiate/done layer. They fail on different signals and neither subsumes
  the other.

## Findings log

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| 1 | needs-doc | The negotiate auto-advance prompt (`promptNegotiateAutoAdvance`) is generic and carries no resolution — verified in `negotiate.ts:151` + `languages/typescript.ts:65`. | Accepted; the resolution block is appended by `deliverAdvance`, not baked into the per-language prompt. |
| 2 | blocker | The Writer's "I will: …" promise is a chat message with no state backing — verified in session 01a0d128 `02:49:29`. Nothing persists it, so nothing can carry it forward. | Accepted; `negotiateResolution` is the state field that backs it. |
| 3 | needs-doc | The role boundary correctly refuses the Writer's test-file edit (session 01a0d128 `02:54:16` TOOLERR). Relaxing it is NOT the fix. | Accepted; pinned as a quirk (do not fix). The fix is the missing delivery path, not the boundary. |
| 4 | needs-doc | Routing target (Tester turn vs. human escalation) is a state-machine design choice. | Flagged as an open design decision; default is human escalation (smaller, never a silent drop). To be resolved in Phase 0. |
| 5 | nit | The stray `test/events/b-phase-role-context.test.ts` is a working-tree artifact of session 01a0d128, not part of this change. | Rejected as in-scope; its cleanup is a separate manual action, noted in Scope lines. |
