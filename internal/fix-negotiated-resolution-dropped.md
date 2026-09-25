# fix-negotiated-resolution-dropped

## Problem

When a **negotiate-phase** dispute is resolved by agreement and the loop
advances to Phase B via the **tool-call path** (`transitionToPhaseB`), the
**negotiated resolution is not carried into the Phase B prompt**. The
resolution can therefore be silently dropped when it names work that the
Phase B role is structurally barred from doing (a test-file change, which
only the Tester may make).

This is proven by session `01a0d128` (spec
`internal/done-bug-role-context-mismatch.md`). The verified event sequence:

- `02:42:31` `[NEGOTIATE] propose` — the **Writer** files a dispute: the new
  tests were written in a new file `test/events/b-phase-role-context.test.ts`,
  but the spec's Inventory / Test Strategy / Scope lines pin them to
  `test/events/before-agent.test.ts` ("No file added").
- `02:45:55` `[NEGOTIATE] review` — the **Tester** concedes, choosing
  **Option (a)**: *"move the new describes into `test/events/before-agent.test.ts`
  (Phase B block) and delete `test/events/b-phase-role-context.test.ts`."*
- `02:49:18` `[NEGOTIATE] propose: agree` → `Approved → Phase B`.
- `02:49:29` Phase B prompt sent: `promptWriterPhaseB(ws)` → generic
  "Write TypeScript source files. Read *.test.ts and *.ts stubs. Implement
  the logic." — the negotiated move+delete is **not in this prompt**.
- `02:54:16` `[TOOLERR] edit: Phase B/C: you may only write source files
  (non-test). Cannot modify test files.` — the Writer **refused** the
  test-file edit.
- `02:56:14` gate **green**, loop advances to Phase C → done.

Result: the resolution was negotiated, agreed, and stated by the Tester —
and then never executed. The loop reported success.

### The two advance paths

There are **two** paths from negotiate to Phase B:

| Path | Trigger | Prompt sent | Resolution carried? |
|------|---------|-------------|---------------------|
| **Tool-call** (`transitionToPhaseB`) | Tester approves via `negotiate_review` → `executeNegotiateApprove` | `promptWriterPhaseB(ws)` — generic | **No** ← this is the bug |
| **Auto-advance** (settle handler) | Writer didn't propose, `negotiateReprompted=true` → safety valve | `promptNegotiateAutoAdvance(negotiateFeedback)` | Partially — prompt has the section, but `negotiateFeedback` is `""` at this point (cleared by `advanceNegotiateRound`) |

Session 01a0d128 used the **tool-call path**. The auto-advance path is a
safety valve for when the Writer fails to propose — it is not the primary
advance mechanism and does not carry a Tester concession.

### What is already fixed (committed `4ffee71`)

The **prompt structure** for the auto-advance path is correct:
`promptNegotiateAutoAdvance` takes a `negotiateResolution` parameter and
includes the "Negotiated resolution:" section, test-file boundary
("test files are owned by the Tester"), no-false-done guard, and Tester
routing language. All three languages are updated.

What is **not** fixed:
1. No state field captures the Tester's concession text. The resolution
   lives in `negotiateFeedback`, which is cleared by `advanceNegotiateRound`
   before the advance fires.
2. The tool-call path (`transitionToPhaseB`) sends `promptWriterPhaseB(ws)`
   — a generic prompt with no resolution section, no boundary language,
   no no-false-done guard.
3. `buildAdvancePrompt` (the single prompt builder) has no case for
   carrying a resolution into the Phase B prompt.

### Structural cause (verified in code)

- `src/tools/negotiate.ts:189` `executeNegotiateFeedback` stores the
  Tester's decision in `state.negotiateFeedback`. This is the only place
  the resolution text exists in state.
- `src/transitions.ts:107` `advanceNegotiateRound` clears
  `negotiateFeedback` to `""` on every round advance.
- `src/tools/negotiate.ts:178` `executeNegotiateApprove` calls
  `transitionToPhaseB` which sends `ADVANCE_PROMPTS.WRITER_PHASE_B`.
- `src/events/agent-settled/effect-applicator.ts:333`
  `buildAdvancePrompt` resolves `WRITER_PHASE_B` →
  `lang.prompts.promptWriterPhaseB(ws)` — no resolution parameter.
- `src/tools/state-io.ts:18` `transitionToPhaseB` → `resetForPhaseB` clears
  `negotiateFeedback` (line 33) before the prompt is sent.

The resolution text exists in state for exactly one round (between
`executeNegotiateFeedback` and the next `advanceNegotiateRound`), and the
advance path that sends the Phase B prompt does not read it.

This is a **failure class D ("all tests pass" lie)** at the negotiation
layer: the gate is green, the loop reports done, but a negotiated
commitment was never delivered to the actor who must execute it.

## Target

After the change, when a negotiate dispute is resolved by agreement and the
loop advances to Phase B via **either** path, the **agreed resolution is
captured in state and delivered into the Phase B prompt** with boundary
language so the Writer knows what was agreed and what it can/can't do.

Concretely:

- A new optional state field `negotiateResolution?: string` captures the
  Tester's concession text when it names a test-file change. It survives
  round advances (unlike `negotiateFeedback`) and is cleared when Phase B
  begins.
- `buildAdvancePrompt` appends the resolution to the Phase B prompt when
  `state.negotiateResolution` is present, using the same boundary +
  no-false-done + Tester-routing language as `promptNegotiateAutoAdvance`.
- The tool-call path (`transitionToPhaseB`) and the auto-advance path
  (settle handler) both go through `buildAdvancePrompt`, so both carry
  the resolution.

The role boundary (Writer cannot write `*.test.ts`) is unchanged.

## Interface

New optional state field:

```ts
// src/types.ts — LoopState
/** The agreed resolution of a negotiate dispute, captured when the Tester's
 *  review feedback names a test-file change. Survives round advances
 *  (unlike negotiateFeedback). Cleared when Phase B begins (resetForPhaseB).
 *  Absent → no open resolution (pre-change sessions are valid). */
negotiateResolution?: string;
```

`src/state-validation.ts`: `negotiateResolution` is **optional** at the
shape level (absent = no open resolution). Type: `string`. The
session-start restore path heals absent → `undefined` (no explicit default
needed — absence is the valid "none" state, matching the `dispute` field's
restore behavior).

`src/tools/negotiate.ts` `executeNegotiateFeedback`: when the decision text
contains a test-file token (heuristic: backtick-quoted or plain path ending
in `.test.ts` / `_test.go` / `Test.java` / `.spec.ts`, or the words "test
file" / "test files"), store the full decision text in
`state.negotiateResolution`. This is in addition to the existing
`negotiateFeedback` assignment (the feedback is still used for the
feedback-effect path; the resolution is a separate, longer-lived field).

`src/tools/state-io.ts` `resetForPhaseB`: clear `negotiateResolution` (set
to `undefined` or `""`) alongside the existing `negotiateFeedback` clear.

`src/events/agent-settled/effect-applicator.ts` `buildAdvancePrompt`: the
`WRITER_PHASE_B` case checks `state.negotiateResolution`. When present and
non-empty, it appends a resolution block to the prompt output:

```
Negotiated resolution:
<text>

Implement the source half of the resolution. Do not modify test files —
test files are owned by the Tester. If the resolution requires test
changes, implement the source half and report the test half as pending
the Tester. Do not claim the resolution is complete if the test half is
outstanding.
```

No signature change to `transitionToPhaseB`, `handleNegotiateSettled`,
`computeNegotiateTransition`, or `applyDoneEffect`. The change is in the
state field, the capture site, the clear site, and the prompt builder.

## Behavior

### Where the resolution is captured (executeNegotiateFeedback)

`executeNegotiateFeedback` currently stores the Tester's decision in
`state.negotiateFeedback`. After the change, it **also** checks whether the
decision text names a test-file change and, if so, stores it in
`state.negotiateResolution`:

```ts
function executeNegotiateFeedback(state, pi, debug, decision) {
  state.current.negotiateFeedback = decision;
  // NEW: capture the resolution if it names a test-file change
  if (touchesTests(decision)) {
    state.current.negotiateResolution = decision;
  }
  persistState(state, pi, debug);
  return buildReviewResult(state.current.phase, decision);
}
```

`touchesTests(text)` is a heuristic: returns `true` if the text contains a
backtick-quoted or plain path ending in a test-file extension (`.test.ts`,
`_test.go`, `Test.java`, `.spec.ts`, `.test.js`) or the phrases "test file"
/ "test files". A false negative (a test change not flagged) degrades to
the *current* behavior (no resolution carried) — never a false block. A
false positive (a non-test resolution flagged) is visible in the prompt,
not a silent drop — the safe direction.

The resolution is captured on **every** feedback call that touches tests,
not just the first. If the Tester gives multiple rounds of feedback, the
last test-touching feedback wins (it is the most recent agreement).

### Where the resolution is delivered (buildAdvancePrompt)

`buildAdvancePrompt` is the single prompt builder called by
`deliverAdvancePrompt` (the shared helper both the tool-call and
auto-advance appliers use). After the change, the `WRITER_PHASE_B` case:

1. Builds the base prompt: `lang.prompts.promptWriterPhaseB(ws)` (unchanged).
2. If `state.negotiateResolution` is present and non-empty, appends the
   resolution block (pinned above).
3. Returns the combined prompt.

The auto-advance path (`promptNegotiateAutoAdvance`) already has its own
resolution section and boundary language. It is **not** modified — it
already works. The `buildAdvancePrompt` change only affects the
`WRITER_PHASE_B` case (the tool-call path).

### Where the resolution is cleared (resetForPhaseB)

`resetForPhaseB` (called by `transitionToPhaseB`) clears
`negotiateResolution` alongside the existing `negotiateFeedback` clear.
This ensures the resolution is not carried into Phase B rounds 2+ (the
Writer has already been told what was agreed; the gate and disputes handle
the rest).

The settle handler's auto-advance path also calls `resetForPhaseB` (via
`autoAdvanceToPhaseB` → `transitionToPhaseB`), so the resolution is
cleared there too.

### Side-effect contract

- State: `negotiateResolution` set in `executeNegotiateFeedback` (when
  `touchesTests`), cleared in `resetForPhaseB`. Order: set-before-persist
  (matching the `negotiateFeedback` pattern).
- UI: no new `notify` or `setStatus` calls. The resolution is delivered
  in the prompt, not as a UI message.
- Messages: no new `sendPrompt` calls. The existing prompt delivery is
  augmented with the resolution block.
- Persistence: `persistState` is already called in
  `executeNegotiateFeedback` (for `negotiateFeedback`); the new field is
  persisted in the same call.

### Quirks list (current behavior, do not fix)

- The Writer's free-form "I will: 1. … 2. …" message is a chat message
  with no state backing. **Current behavior, do not fix** — the fix
  captures the *Tester's* concession into state; it does not parse
  arbitrary Writer promises.
- The auto-advance path's `promptNegotiateAutoAdvance` already has a
  resolution section but receives `""` because `negotiateFeedback` is
  cleared before the auto-advance fires. **Current behavior** — the
  auto-advance is a safety valve, not the primary advance path. The
  prompt structure is correct; the empty resolution degrades to the
  generic prompt (same as before the fix).
- The role boundary refusing Writer test-file edits is **correct, do not
  relax.** The bug is the missing delivery path, not the boundary.

### Intended shifts

- **Before:** a test-touching negotiated resolution advances to Phase B
  via the tool-call path, the Writer gets a generic prompt with no
  resolution, the Writer cannot perform the test-file work, the gate goes
  green, the loop reports done.
- **After:** the same resolution is captured in state, carried into the
  Phase B prompt with boundary language, the Writer implements the source
  half and reports the test half as pending the Tester. The loop does not
  silently drop the resolution.

## Inventory

- **Files:**
  - `src/types.ts` — add optional `negotiateResolution?: string` to
    `LoopState` (modify).
  - `src/state-validation.ts` — validate optional `negotiateResolution`
    (string, optional); restore heals absent → `undefined` (modify).
  - `src/tools/negotiate.ts` — `executeNegotiateFeedback` captures
    resolution when `touchesTests`; add `touchesTests` helper (modify).
  - `src/tools/state-io.ts` — `resetForPhaseB` clears
    `negotiateResolution` (modify).
  - `src/events/agent-settled/effect-applicator.ts` —
    `buildAdvancePrompt` `WRITER_PHASE_B` case appends resolution block
    when `state.negotiateResolution` is present (modify).
  - `test/tools/negotiate.test.ts` — extend: capture tests for
    `executeNegotiateFeedback` (modify; create if absent).
  - `test/tools/state-io.test.ts` — extend: `resetForPhaseB` clears
    `negotiateResolution` (modify; create if absent).
  - `test/events/agent-settled/effect-applicator.test.ts` — extend:
    `buildAdvancePrompt` appends resolution block (modify).
  - `test/state-validation.test.ts` — extend: `negotiateResolution`
    shape + restore (modify).
  - `test/events/agent-settled/negotiate.test.ts` — extend:
    auto-advance path with `negotiateResolution` set (modify).
- **Imports:** no new imports in any file.
- **Call sites:** `persistState` already called in
  `executeNegotiateFeedback`; `buildAdvancePrompt` already called by
  `deliverAdvancePrompt` for both advance paths.
- **Exports:** no new exports. `touchesTests` is a module-private helper
  in `negotiate.ts`.

## Test Strategy

- **Baseline:** 1759/1759 passing as of writing (commit `4ffee71`).
- **Per-test disposition:**
  - Kept unchanged: all existing tests in the affected files (the new
    field is optional, so old fixtures remain valid).
  - Extended: `executeNegotiateFeedback` tests — new cases for
    `touchesTests` detection and `negotiateResolution` capture.
  - Extended: `resetForPhaseB` tests — new case: `negotiateResolution`
    cleared.
  - Extended: `buildAdvancePrompt` tests — new case: `WRITER_PHASE_B`
    with `negotiateResolution` set → prompt includes resolution block.
  - Extended: `state-validation` tests — new case: `negotiateResolution`
    optional string, absent → `undefined`.
- **New tests (one per pinned behavior):**
  1. `touchesTests`: text with `.test.ts` path → `true`.
  2. `touchesTests`: text with `_test.go` path → `true`.
  3. `touchesTests`: text with "test files" phrase → `true`.
  4. `touchesTests`: text with `src/foo.ts` (source path) → `false`.
  5. `touchesTests`: empty text → `false`.
  6. `executeNegotiateFeedback`: decision with test-file path →
     `negotiateResolution` set to decision text.
  7. `executeNegotiateFeedback`: decision without test-file path →
     `negotiateResolution` not set.
  8. `executeNegotiateFeedback`: second feedback with test-file path
     overwrites the first (last-wins).
  9. `resetForPhaseB`: `negotiateResolution` cleared to `""`.
  10. `buildAdvancePrompt` `WRITER_PHASE_B` with `negotiateResolution`
      set → prompt includes "Negotiated resolution:" + text + boundary
      language.
  11. `buildAdvancePrompt` `WRITER_PHASE_B` without
      `negotiateResolution` → prompt unchanged (regression: existing
      behavior).
  12. `state-validation`: `negotiateResolution: "text"` → valid.
  13. `state-validation`: `negotiateResolution` absent → valid, heals to
      `undefined`.
  14. **Regression for session 01a0d128:** feed the exact sequence
      (Writer dispute → Tester Option (a) feedback → Writer agree →
      Tester approve → `transitionToPhaseB`) and assert the Phase B prompt
      includes the resolution text + boundary language.
- **Live-toolchain rules:** no test in this spec spawns a real tool. All
  tests mock `persistState` / `sendPrompt` at the process boundary.

## Scope lines

- `src/types.ts` — modified (one optional field added).
- `src/state-validation.ts` — modified (optional shape check + restore).
- `src/tools/negotiate.ts` — modified (capture + `touchesTests` helper).
- `src/tools/state-io.ts` — modified (clear in `resetForPhaseB`).
- `src/events/agent-settled/effect-applicator.ts` — modified
  (`buildAdvancePrompt` resolution block).
- Test files as listed in Inventory — extended.
- **No file added. No file removed.**

## Acceptance Criteria

- **Hard:** `npx vitest run` passes (full suite, incl. the 14 new tests).
- **Hard:** `npx tsc --noEmit` is clean.
- **Hard (grep, functional):** `grep -rn "negotiateResolution" src/`
  returns ≥ 1 hit in each of `types.ts`, `state-validation.ts`,
  `tools/negotiate.ts`, `tools/state-io.ts`,
  `events/agent-settled/effect-applicator.ts`.
- **Hard (regression):** the session-01a0d128 regression test (new test
  #14) asserts the Phase B prompt includes the resolution text and
  boundary language when the advance goes through `transitionToPhaseB`.

## Dependencies

- `internal/done-bug-role-context-mismatch.md` (session 01a0d128) — the
  src fix (two prompt builders in `before-agent.ts`) is implemented and
  the spec archived. This spec fixes the *negotiation-layer* defect that
  let that session's resolution drop via the tool-call path.
- Commit `4ffee71` (Round 5 prompt fixes + auto-advance prompt
  structure) — the `promptNegotiateAutoAdvance` prompt structure is
  correct; this spec adds the state wiring for the tool-call path.

## Findings log

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| 1 | blocker | The tool-call advance path (`transitionToPhaseB`) — the path that dropped the resolution in session 01a0d128 — sends `promptWriterPhaseB(ws)` with no resolution. | Accepted; `buildAdvancePrompt` appends the resolution block when `state.negotiateResolution` is present. |
| 2 | blocker | `negotiateFeedback` is cleared by `advanceNegotiateRound` before the advance fires, so the current wiring passes `""` to `promptNegotiateAutoAdvance`. | Accepted; the new `negotiateResolution` field survives round advances (cleared only in `resetForPhaseB`). |
| 3 | needs-doc | The auto-advance path's `promptNegotiateAutoAdvance` already has the correct prompt structure (resolution section, boundary, no-false-done) but receives an empty string. | Accepted as a quirk — the auto-advance is a safety valve, not the primary path. The prompt structure is correct; the empty resolution degrades gracefully. |
| 4 | needs-doc | The `touchesTests` heuristic is a simple regex/phrase check, not a parser. False negatives degrade to current behavior; false positives are visible in the prompt. | Accepted; the safe direction is "carry it and let the Writer see it," not "block the advance." |
