# fix-b-phase-role-context

## Problem

Verified current state as of writing (2026-09-23):

The `before_agent_start` loop-context message for **Phase B** is dispatched on
**phase only** — it never inspects the dispute sub-flow, so every B-phase turn
gets the Writer context, including the turns whose actor is the **Tester**.

- Entry: `handleBeforeAgent` (`src/events/before-agent.ts:45`). Phase B
  dispatches to `buildWriterPrompt` (`src/events/before-agent.ts:206`), which
  branches on **exactly one** condition
  (`src/events/before-agent.ts:213`):
  `state.dispute?.status === "conceded" && state.dispute?.filer === "writer"`
  → `buildDisputeFixPrompt` (Tester fix context); **otherwise** the Writer
  context.
- The Writer context string (`src/events/before-agent.ts:217-222`), verbatim:
  `WRITER. Write ${lang.sourceFilePattern} to pass ${lang.testFilePattern}.\n` +
  `Preserve stub signatures. If a test is wrong or unpassable by construction, stop and call negotiate_propose with the dispute — do not keep editing source to satisfy it.\n` +
  `When done, stop producing tool calls.`
  systemPrompt: `Phase B (Writer), round ${round}. Write ${sourceFilePattern} only. Do not modify ${testFilePattern}.`

The dispute sub-flow in Phase B has **three** actor contexts, but only one is
reached:

| Sub-flow | Status + filer | Actor | Context actually injected | Correct? |
|---|---|---|---|---|
| Normal B turn | `none` / no dispute | Writer | Writer | ✓ |
| Dispute **review** (Writer filed, Tester reviews) | `in-review` + filer `writer` | **Tester** | **Writer** | ✗ **defect** |
| Dispute **fix** (Tester conceded, fixes test) | `conceded` + filer `writer` | Tester | Tester fix | ✓ |

The defect row: when the Tester is asked to review a Writer-filed dispute
(`dispute.status === "in-review"`, `dispute.filer === "writer"`), the
loop-context message tells it to *write non-test files to pass the tests* —
the opposite of its actual job (call `negotiate_review`, write nothing). The
system prompt carries the right role, so the model does the right thing, but
the injected context contradicts it.

**Observed artifact:** session `01a0155a` (spec 10), Phase B, 2026-08-18
15:44:52 — the Tester's dispute-review turn received the `WRITER. Write ...`
context (verified in raw JSONL). Session `01a011fa` shows the same pattern at
05:12:36.

**The same defect class, mirrored:** the fix leg for a **tester-filed**
dispute (`conceded` + filer `tester`) is handled by the settle handler
`handleWriterConcedeFix` (`src/events/agent-settled/dispute.ts:96`), which
delivers the Writer fix prompt via `sendPrompt` — but on the *next*
`before_agent_start` the state is `conceded` + filer `tester`, which
`buildWriterPrompt` does **not** match (it only matches filer `writer`), so
the Writer-concede-fix turn also gets the bare **Writer** context rather than
a fix-specific one. This is the mirror of the review-row defect and is in
scope (the spec's own subject is "no B-phase turn emits the wrong-role
context").

**What is NOT a defect (pinned, do not change):**
- `handleDisputeReview` delivers the review prompt via `sendPrompt`
  (`src/events/agent-settled/dispute.ts:70-74`); the `before_agent_start`
  context for that turn is a *second*, redundant signal. Fixing the context
  does not remove the `sendPrompt` — both carry the role, the context just
  stops contradicting it.
- The `negotiate` phase already has round-parity role selection
  (`buildNegotiatePrompt`, `src/events/before-agent.ts:173-176`,
  `round % 2 === 1` → Writer). Phase B has no equivalent — that asymmetry is
  the gap, not a bug in negotiate.

## Target

`buildWriterPrompt` (the Phase B context branch in `handleBeforeAgent`)
selects the context by the **dispute sub-flow**, not just phase. After the
change:

- Normal B turn (no active dispute, or `status === "none"`) → Writer context
  (unchanged).
- Dispute **review** by the Tester (`in-review` + filer `writer`) → a Tester
  review context (new, verbatim-pinned below).
- Dispute **fix** by the Tester (`conceded` + filer `writer`) → Tester fix
  context (unchanged).
- Dispute **concede-fix** by the Writer (`conceded` + filer `tester`) → a
  Writer fix context (new, verbatim-pinned below).
- `defended` (a follow-up delivery turn, not a file-writing turn) and `closed`
  → Writer context (the turn resumes normal B work; pinned, see Behavior).

No new persisted state field. The branch keys off the existing
`state.dispute` shape, which already survives restore
(`src/events/session-start.ts:104-107` deliberately does not touch
`dispute`).

## Interface

No signature or data-shape change to `LoopState` / `DisputeState`. The change
is a pure branch addition inside `buildWriterPrompt`
(`src/events/before-agent.ts`).

Persisted state: **none added.** The branch reads `state.dispute.status` and
`state.dispute.filer`, both of which are already persisted and restored
(`src/state-validation.ts:120-131` validates `dispute.status`; `filer` is a
`"writer" | "tester"` string carried inside the object). A session saved
mid-dispute-review (status `in-review`) restores to the same status and
therefore renders the same Tester-review context — no migration, no healing
needed. Pre-change saved entries carry no new field, so there is nothing to
heal.

## Behavior

Decision table for the Phase B context branch (evaluation order
first-match-wins; the existing `conceded`+`writer` check stays first to
preserve the current fix path exactly):

| # | `state.dispute?.status` | `state.dispute?.filer` | Context returned | Side effect |
|---|---|---|---|---|
| 1 | `conceded` | `writer` | Tester **fix** (existing `buildDisputeFixPrompt`) | status → `closed`, commit (unchanged) |
| 2 | `in-review` | `writer` | Tester **review** (new) | none (pure read) |
| 3 | `conceded` | `tester` | Writer **concede-fix** (new) | none (pure read) |
| 4 | `defended` | any | Writer (normal) | none |
| 5 | `closed` | any | Writer (normal) | none |
| 6 | `filed` | any | Writer (normal) | none (the review turn is scheduled by the settle handler, not by a fresh `before_agent_start` on `filed`) |
| 7 | `none` / `undefined` | — | Writer (normal) | none |
| default | any other | — | Writer (normal) | none (defensive; `status` is a closed 6-member union) |

Rows 4–7 collapse to the existing Writer branch. Only rows 2 and 3 are new.

**Verbatim pins (new strings a test asserts):**

Row 2 — Tester review context. message content:
```
TESTER (dispute review). The Writer disputed a test. Review the claim against the spec and the code.
Use negotiate_review: decision='approve' to concede (you will fix the test), or a rebuttal to defend it.
Do not write files.
```
systemPrompt suffix: `Phase B (dispute review, Tester). Review the Writer's dispute. Use negotiate_review. Do not write files.`

Row 3 — Writer concede-fix context. message content:
```
WRITER (dispute fix). You accepted the Tester's report. Fix the flagged ${lang.sourceFilePattern} to resolve it.
Write source files only. When done, stop producing tool calls.
```
systemPrompt suffix: `Phase B (dispute fix, Writer). You may write ${lang.sourceFilePattern}. Do not modify ${lang.testFilePattern}.`

(Both mirror the existing `promptTesterReviewWriterDispute` /
`promptWriterConcedeFix` in `src/generic-prompts.ts:85,109` in role and
intent, but are the *context-message* variants — shorter, no `${claim}`
interpolation, since the claim is already delivered by the settle handler's
`sendPrompt`.)

**Side-effect contract:** rows 2 and 3 are pure reads — no `commit`, no
status mutation, no `sendPrompt`, no `ctx.ui`. Only row 1 (existing) mutates
state. The new branches call no I/O.

**Quirks list (current behavior, do not fix):**
- Row 1's `buildDisputeFixPrompt` mutates `status → "closed"` and commits
  *inside* the before-agent handler (`src/events/before-agent.ts:234-237`).
  This is the established R3 order (debug → clear → persist); the new rows
  deliberately do **not** copy it because they are read-only review/fix turns
  whose status is advanced by the settle handler, not by the context builder.
  Pinning: rows 2/3 leave `state.dispute` untouched.

**Intended shifts:**
- A tester-filed concede-fix turn (row 3) previously rendered the bare Writer
  context; after the change it renders the fix-specific context. This is the
  intended correction, not a quirk.
- An `in-review` + filer `tester` state (Writer reviewing a tester-filed
  dispute) is **not** in the table — it falls to the default Writer context,
  which is correct (the Writer is the actor). Pin: no new branch for this
  case; it is the Writer acting, so Writer context is right.

**Ownership:** `buildWriterPrompt` / `buildDisputeFixPrompt` in
`src/events/before-agent.ts` own the branch. `test/events/before-agent.test.ts`
asserts it (existing file, extended).

## Inventory

- **Files:**
  - `src/events/before-agent.ts` — modify `buildWriterPrompt` (add two
    branches, rows 2 and 3); add two small pure helpers
    `buildDisputeReviewPrompt` and `buildWriterConcedeFixPrompt` (mirroring
    the existing `buildDisputeFixPrompt` shape). No other function in the file
    changes.
  - `test/events/before-agent.test.ts` — extend the `Phase B` describe block
    with the new rows. No other test file changes.
- **Imports:** none added. `buildWriterPrompt` already receives `lang`,
  `state`, `pi`, `debug`, `systemPrompt` — everything the new branches need is
  in scope. The two new helpers take the same parameters.
- **Call sites:** `buildWriterPrompt` is called from exactly one site
  (`buildPhasePrompt`, `src/events/before-agent.ts:125`). Its signature is
  unchanged, so the call site is untouched.
- **Exports:** the two new helpers are module-private (not exported), matching
  `buildDisputeFixPrompt`. `handleBeforeAgent` is the sole public entry and is
  unchanged in signature.

## Test Strategy

- **Baseline:** 1742/1742 passing as of writing (63 files). The change is
  additive branches in one pure function; no existing assertion flips.
- **Per-test disposition (existing, kept unchanged):**
  - `Phase B (Writer) > normal turn round 1 → Writer prompt` — kept; row 7
    still returns Writer.
  - `Phase B (dispute fix) — F1, R3` (3 tests: prompt, clear+persist, order) —
    kept; row 1 is unchanged and stays first in evaluation order.
- **New tests (one per new pinned behavior):**
  1. `in-review` + filer `writer` → Tester review context, exact message +
     systemPrompt pinned; **no** `commit`/`appendEntry`, `state.dispute.status`
     still `in-review` (pure read).
  2. `conceded` + filer `tester` → Writer concede-fix context, exact message +
     systemPrompt pinned; no state mutation.
  3. `defended` (any filer) → Writer context (row 4).
  4. `closed` → Writer context (row 5).
  5. `in-review` + filer `tester` → Writer context (the Writer-reviewing case
     falls to default; pins the "no new branch" decision).
- **Untouched:** every other test file. Mechanism that keeps them valid: the
  change adds branches reachable only under specific `dispute.status`/`filer`
  combinations that no existing Phase-B fixture sets (existing fixtures use
  `status: "none"` or the `conceded`+`writer` fix case), so no existing
  assertion's input reaches a new branch.
- **Live-toolchain rules:** none — no test spawns a real tool. All new tests
  call `handleBeforeAgent` with a mock `pi` (existing
  `createMockExtensionAPI`) and assert on the returned message/systemPrompt
  strings. No temp dirs, no `exec*`.

## Scope lines

- `src/events/before-agent.ts`: **kept** (grows by two helpers + two branch
  rows). `buildWriterPrompt`'s existing `conceded`+`writer` → fix branch is
  kept verbatim and remains the first check.
- `test/events/before-agent.test.ts`: **kept** (grows by ~5 tests in the
  Phase B block).
- No file removed. No file added.

## Acceptance Criteria

- `npx vitest run` passes (all suites, incl. `test/events/before-agent.test.ts`).
- `npx tsc --noEmit` is clean.
- Grep sweep (functional): `grep -rn "buildDisputeReviewPrompt\|buildWriterConcedeFixPrompt" src/` returns the two definitions in `src/events/before-agent.ts` and their call sites inside `buildWriterPrompt` — and **0** hits outside `src/events/before-agent.ts` (they are module-private).
- Grep sweep (negative): `grep -rn "awaitDisputeReview\|awaitDisputeFix\|disputeFiler" src/` returns **0** hits (the retired flat fields the original draft keyed off must not be reintroduced; the branch reads `state.dispute.status` / `state.dispute.filer`).
- One criterion per pinned row: the five new tests above each assert the exact
  message + systemPrompt string for their row, and the pure-read rows assert
  `pi.appendedEntries` length 0 and `state.dispute.status` unchanged.

## Dependencies

- `bug-dispute-reload-evaporation` (done): the 4 flat dispute flags were
  collapsed into the single `dispute: DisputeState` object. **This spec keys
  off that object** (`status` + `filer`), not the retired flags — the original
  pre-template draft of this spec referenced `awaitDisputeReview` /
  `awaitDisputeFix` / `disputeFiler`, which no longer exist; this rewrite
  corrects that.
- `fix-just-transitioned-settle-drop` (done): the settle-dispatch order
  (dispute handlers run before the gate, `src/events/agent-settled/index.ts`)
  is why the review/fix *prompts* come from the settle handler while the
  *context* comes from `before_agent_start` — the two layers are independent,
  and this spec only touches the context layer.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | blocker | Original draft named `buildBeforeAgent`; the entry is `handleBeforeAgent` | accepted — verified `src/events/before-agent.ts:45`; spec now names it |
| 2 | blocker | Original draft cited `src/commands.ts` for the negotiate parity rule | accepted — verified it is `src/commands/` (dir); the B-phase gap is in `buildWriterPrompt`, negotiate parity is `buildNegotiatePrompt` (`src/events/before-agent.ts:173`); spec corrected |
| 3 | blocker | Original draft keyed the fix off retired flat fields (`disputeFiler`, `awaitDisputeReview`, `awaitDisputeFix`) | accepted — those were removed by `bug-dispute-reload-evaporation`; spec now keys off `state.dispute.status` + `state.dispute.filer` |
| 4 | needs-doc | Original draft was silent on the tester-filed / Writer-concede-fix row (the mirror defect) | accepted — added as row 3 + intended shift + test 2 |
| 5 | needs-doc | No verbatim pin for the new Tester-review string; no persisted-state/restore statement; `clearTransientFlags` AC contradicted the pinned "dispute preserved" behavior | accepted — verbatim pins added (Behavior); persisted-state section added (Interface: none added, restore already preserves `dispute`); the `clearTransientFlags` contradiction is resolved by *not* adding a field, so `clearTransientFlags` (`src/events/session-start.ts:104`) is untouched and its "dispute is deliberately NOT touched" invariant holds |
