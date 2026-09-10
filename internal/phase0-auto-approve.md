# implement-phase0-auto-approve

## Problem

Verified current state as of writing:

When the loop reaches Phase 0 (`review`), the agent reviews the spec and either:
1. Calls `negotiate_propose("approve")` → `executePhase0Approve` → Phase A (src/tools.ts:195-214)
2. Calls `negotiate_propose("<feedback>")` → `executePhase0Feedback` → stays in review (src/tools.ts:216-230)
3. Calls `negotiate_review("approve")` → same as 1 (src/tools.ts:448-451)
4. Calls `negotiate_review("<feedback>")` → same as 2 (src/tools.ts:451)
5. Settles without calling either tool → `handleReviewSettled` fires → notifies "Use /loop-approve to proceed" and waits (src/events/agent-settled/review.ts:29-38)

Path 5 is the gap: the agent finishes its review turn without explicitly calling a negotiate tool. The settle handler parks the loop and waits for a human to type `/loop-approve`. Even when the spec is clean (no findings, no ambiguity), a human must manually approve.

The agent is already *told* to use `negotiate_propose` (src/commands.ts:262: `"Use negotiate_propose to approve (plan='approve') or provide feedback on findings."`), but LLMs don't always follow tool-calling instructions — especially local models. The settle handler's fallback (path 5) is a dead-end that requires human intervention.

## Target

When the agent settles in Phase 0 without calling `negotiate_propose` or `negotiate_review` (i.e., no explicit approval or feedback was recorded), the settle handler auto-advances to Phase A **if no dispute was filed and no feedback was recorded**. If feedback WAS recorded (via `negotiate_propose` or `negotiate_review` with non-approve text), the loop stays in review and waits for the human.

This makes the common path (clean spec → auto-advance) zero-friction while preserving the human gate for the uncommon path (feedback given → human decides).

The `--no-auto-approve` flag on `/loop` disables this behavior, restoring the old "always wait for human" semantics.

## Interface

### `LoopState` (src/types.ts)

Add one optional field:

```ts
autoApprove?: boolean; // default true; set false by --no-auto-approve
```

Optional (not required) so existing test fixtures that don't include it remain valid. `undefined` is treated as `true`.

### `LoopArgs` (src/selectors.ts)

Add one optional field:

```ts
autoApprove?: boolean; // default true; set false by --no-auto-approve
```

Parse `--no-auto-approve` (boolean flag, no value) in `parseLoopArgs`.

### `createInitialState` (src/commands.ts:103)

Accept `autoApprove?: boolean` as a 6th parameter. Set `autoApprove` in the returned state.

### `cmdLoop` (src/commands.ts:138)

Pass `autoApprove` from `parseLoopArgs` to `createInitialState`.

### `handleReviewSettled` (src/events/agent-settled/review.ts)

Add `autoApprove` to `ReviewHandlerInput`. Change the settle behavior:

- If `autoApprove` is `false` (or `--no-auto-approve` was passed): current behavior — notify and wait.
- If `autoApprove` is `true` (default) AND `lastProposal` is empty (no feedback recorded) AND no dispute is filed: auto-advance to Phase A (same field writes as `executePhase0Approve`).
- If `autoApprove` is `true` BUT `lastProposal` is non-empty (feedback was recorded): current behavior — notify and wait for human.

## Behavior

Decision table for `handleReviewSettled` (first-match-wins):

| # | Condition | Action | Return |
|---|-----------|--------|--------|
| 1 | `!state.current.awaitingReview` | no-op | `{ handled: false }` |
| 2 | `autoApprove === false` | notify "Use /loop-approve to proceed." | `{ handled: true }` |
| 3 | `lastProposal` is non-empty (feedback recorded) | notify "Feedback recorded. Use /loop-approve to proceed." | `{ handled: true }` |
| 4 | `dispute?.status === "filed"` or `"in-review"` | notify "Dispute pending. Use /loop-approve to proceed." | `{ handled: true }` |
| 5 | default (clean review, auto-approve on) | auto-advance: phase="A", round=1, awaitingReview=false, turnsThisPhase=1, send Phase A prompt, commit | `{ handled: true }` |

Row 5 is the new behavior. Rows 2-4 are the guard conditions that preserve the human gate.

### Verbatim pins

- Row 2 notification: `"Phase 0: Review findings. Use /loop-approve to proceed."` (unchanged)
- Row 3 notification: `"Phase 0: Feedback recorded. Use /loop-approve to proceed."` (new)
- Row 4 notification: `"Phase 0: Dispute pending. Use /loop-approve to proceed."` (new)
- Row 5 notification: `"Phase 0: Clean review — auto-advancing to Phase A."` (new)
- Row 5 status: `"Phase A — round 1"` (same as `executePhase0Approve`)
- Row 5 debug: `"Phase 0 auto-approve → Phase A, round 1"` (new)

### Side-effect contract (row 5)

1. `state.current.phase = "A"`
2. `state.current.round = 1`
3. `state.current.awaitingReview = false`
4. `state.current.turnsThisPhase = 1`
5. `ctx.ui.notify("Phase 0: Clean review — auto-advancing to Phase A.", "info")`
6. `ctx.ui.setStatus("loop", "Phase A — round 1")`
7. `commit(state.current, pi, debug)` — persists the advanced state
8. `sendPrompt(pi, lang.prompts.promptTesterPhaseA(specPath, buildTool, workspaceRoot), state.current, debug)` — sends the Phase A prompt

### Quirks list

- `handleReviewSettled` currently ignores the `lang` parameter (comment: "dead parameter — preserved for parity with the monolith"). This spec makes it *used* (row 5 calls `lang.prompts.promptTesterPhaseA`). The parameter is no longer dead.
- `executePhase0Approve` in src/tools.ts does `persistState` (which calls `commit`), but `handleReviewSettled` also calls `commit` at the end. The auto-approve path in row 5 will call `commit` once, matching the settle handler's existing pattern. The tool path (`executePhase0Approve`) is unchanged.

### Intended shifts

- The `lang` parameter in `ReviewHandlerInput` becomes live (was dead). Before: unused. After: used for `promptTesterPhaseA` in row 5.
- The Phase 0 prompt in `buildPhaseZeroPrompt` (src/commands.ts:262) says "Use negotiate_propose to approve (plan='approve') or provide feedback on findings." This is still correct — the agent *should* call the tool. Auto-approve is a fallback for when it doesn't. No prompt change needed.

### Ownership

- `handleReviewSettled` in `src/events/agent-settled/review.ts` owns the auto-advance decision.
- `test/events/agent-settled/review.test.ts` (new file) asserts the decision table.
- `parseLoopArgs` in `src/selectors.ts` owns `--no-auto-approve` parsing.
- `test/selectors.test.ts` asserts the flag parsing.

## Inventory

### Files touched

1. **src/types.ts** — add `autoApprove?: boolean` to `LoopState`
2. **src/selectors.ts** — add `autoApprove?: boolean` to `LoopArgs`; parse `--no-auto-approve` in `parseLoopArgs`
3. **src/commands.ts** — `createInitialState` accepts 6th param; `cmdLoop` passes it through
4. **src/events/agent-settled/review.ts** — `ReviewHandlerInput` gains `autoApprove`; `handleReviewSettled` implements the 5-row decision table
5. **src/events/agent-settled/index.ts** — pass `autoApprove` to `handleReviewSettled` call site
6. **test/events/agent-settled/review.test.ts** — new: 5+ regression tests for the decision table
7. **test/selectors.test.ts** — add `--no-auto-approve` parsing test
8. **test/extension.test.ts** — update `cmdLoop` call sites if they assert on `createInitialState` args

### Imports

- `src/events/agent-settled/review.ts`: add `import { getWorkspaceRoot } from "../../types";` (needed for `promptTesterPhaseA` call in row 5)
- `src/events/agent-settled/review.ts`: add `import { sendPrompt } from "../../prompt";` (needed for row 5)
- `src/events/agent-settled/review.ts`: add `import { getLanguageConfig } from "../../languages";` — wait, `lang` is already passed in. No new import needed for that.
- `src/selectors.ts`: no new imports (string parsing only)
- `src/commands.ts`: no new imports

### Call sites

- `handleReviewSettled` is called from exactly one place: `src/events/agent-settled/index.ts:170`. The call site must add `autoApprove: state.current.autoApprove`.

### Exports

- No new exports. `handleReviewSettled` is already exported.

## Test Strategy

- **Baseline:** 1232/1232 passing. No existing tests assert on `handleReviewSettled` behavior (no `test/events/agent-settled/review.test.ts` exists).
- **New tests (test/events/agent-settled/review.test.ts):**
  1. `awaitingReview = false` → returns `{ handled: false }` (row 1)
  2. `autoApprove = false` → notifies "Use /loop-approve to proceed.", returns `{ handled: true }`, no phase change (row 2)
  3. `lastProposal = "some feedback"` → notifies "Feedback recorded. Use /loop-approve to proceed.", returns `{ handled: true }`, no phase change (row 3)
  4. `dispute.status = "filed"` → notifies "Dispute pending. Use /loop-approve to proceed.", returns `{ handled: true }`, no phase change (row 4)
  5. Clean review, `autoApprove` undefined (default true) → phase becomes "A", round 1, `sendPrompt` called with Phase A prompt, `commit` called (row 5)
  6. Clean review, `autoApprove = true` explicitly → same as 5 (row 5)
  7. `autoApprove = false` with clean review → same as row 2 (guard takes precedence)
- **New tests (test/selectors.test.ts):**
  8. `--no-auto-approve` flag → `autoApprove === false`
  9. No flag → `autoApprove === true`
  10. `--no-auto-approve` combined with other flags → still parsed correctly
- **Untouched:** All other test files. The `autoApprove` field is optional, so existing fixtures that don't include it remain valid (treated as `true`). The `handleReviewSettled` call site in `index.ts` is the only wiring change.

## Scope lines

- **src/types.ts:** added — `autoApprove?: boolean` field in `LoopState`
- **src/selectors.ts:** added — `autoApprove?: boolean` in `LoopArgs`; `--no-auto-approve` parsing in `parseLoopArgs`
- **src/commands.ts:** modified — `createInitialState` signature gains 6th param; `cmdLoop` passes `autoApprove`
- **src/events/agent-settled/review.ts:** modified — `ReviewHandlerInput` gains `autoApprove`; `handleReviewSettled` implements 5-row decision table; `lang` param becomes live
- **src/events/agent-settled/index.ts:** modified — call site passes `autoApprove`
- **test/events/agent-settled/review.test.ts:** added — new file, 7 tests
- **test/selectors.test.ts:** added — 3 tests for `--no-auto-approve`

## Acceptance Criteria

- Full test run green: `npx vitest run` → 1239+ passed, 0 failed
- Type-checker clean: `npx tsc --noEmit` → 0 errors
- Grep sweep 1: `grep -rn "autoApprove" src/` → appears in types.ts, selectors.ts, commands.ts, review.ts, index.ts (5 files)
- Grep sweep 2: `grep -rn "no-auto-approve" src/` → appears in selectors.ts (1 file)
- Grep sweep 3: `grep -rn "Clean review" src/` → appears in review.ts (1 file, the row 5 notification)
- Grep sweep 4: `grep -rn "auto-advancing" src/` → appears in review.ts (1 file)

## Dependencies

- None. This is a self-contained behavior change in the Phase 0 settle handler + a new CLI flag.

## Findings log

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| 1 | needs-doc | The Phase 0 prompt tells the agent to call `negotiate_propose`, but LLMs (especially local models) may not follow tool-calling instructions. The settle handler's fallback is a dead-end. | Accepted — this is the motivation for auto-approve. The prompt is unchanged; auto-approve is a fallback, not a replacement. |
| 2 | nit | `handleReviewSettled` has a dead `lang` parameter. This spec makes it live. | Accepted — the parameter was preserved for parity; now it's used. No API change needed. |
