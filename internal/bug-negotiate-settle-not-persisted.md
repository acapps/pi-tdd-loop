# bug-negotiate-settle-not-persisted

## Problem

Verified current state as of writing (baseline: `npx tsc --noEmit` clean; `npm test` → 32 files, 1017 tests, 0 failures):

**The negotiate settle path commits no state.** `handleNegotiateSettled` (`src/events/agent-settled/negotiate.ts:44-66`) computes a transition via `T.computeNegotiateTransition` (which advances `round` and clears the pending markers in the *new* state object, `src/transitions.ts:78-86`), delivers a prompt, and the dispatcher reassigns `state.current = result.newState` (`src/events/agent-settled/index.ts:131-132`). **No `appendEntry("loop-state", ...)` call exists anywhere in this path** — grep-proven: the only `loop-state` persists near negotiate are the *tool* sites (`src/tools.ts`), which fire when the agent calls a tool, not when the settle delivers a round.

**The crash window (concrete, step-by-step):**
1. Writer calls `negotiate_propose` → `negotiateProposed = true`, `round: N`, **persisted** (`src/tools.ts:238-239`).
2. Turn ends → settle → `computeNegotiateTransition` returns `newState` with `round: N+1`, `negotiateProposed: false` → `deliverReviewRequest` sends the proposal to Tester (`negotiate.ts:77`) → dispatcher reassigns `state.current` → **no persist**.
3. Session reloads (crash, restart, `/loop` in a new session) → `session-start.ts` restores the *step-1* snapshot: `phase: "negotiate", round: N, negotiateProposed: true` → `clearTransientFlags` clears `negotiateProposed` (`session-start.ts:41-54`) → restored machine: `negotiate`, round `N`, no markers.
4. Next settle → `computeNegotiateTransition` falls to `round % 2 === 1 ? repromptWriter : repromptTester` (`src/transitions.ts:68-71`). At round `N` (odd, the Writer's round — the proposal was *already delivered to Tester*), the machine re-prompts the **Writer**. The round ping-pong is now out of sync with the conversation: Tester already reviewed, Writer gets asked to propose again, and the proposal text is re-sent on the next `deliverReviewRequest`.

**Same class, second window:** the feedback branch (`negotiate.ts:89`) delivers `state.negotiateFeedback` — read from the *old* state object (pinned: `deliverFeedback` receives `state`, not `newState`, line 89) — and likewise nothing is persisted. A reload between feedback delivery and the next tool call restores `negotiateFeedback` still set (the tool persisted it at `tools.ts:356-358`), so the *same feedback prompt is re-delivered* to the Writer on the next settle. The Writer's response to a double-delivered instruction is a double edit.

**Scope note:** this spec is the *verification* half of `refactor-single-commit-point.md` commit point #1. If that refactor lands first, this document's fix is already in place and this spec reduces to its regression tests (Interface, Test Strategy). If it lands first, **rename this file to `done-negotiate-settle-not-persisted.md`** after the regression tests are added.

## Target

After this fix: every negotiate settle that reassigns `state.current` is followed by a commit of the *new* state (round advanced, markers cleared). A reload at any point in the negotiate cycle restores a machine that is in sync with the conversation: no re-prompt of the agent who just acted, no re-delivery of an already-delivered proposal/feedback.

## Interface

Depends on `refactor-single-commit-point.md` (`src/commit.ts:commit`). If that unit has landed, this unit adds **no production code** — only the regression tests named in Test Strategy, plus one pin change:

- `src/events/agent-settled/index.ts:handlePhaseSettled` — the negotiate branch is:
  ```ts
  const result = handleNegotiateSettled({ state: state.current, pi, ctx, lang, debug });
  state.current = result.newState;
  commit(state, pi);          // ← this line is the fix (refactor commit point #1)
  return result.handled;
  ```
- If `refactor-single-commit-point.md` has NOT landed, this unit is **blocked** — do not implement a local `appendEntry` here; that would create a 15th ad-hoc persist site and defeat the refactor. (Pinned: the dependency is hard, not advisory.)

**No new user-visible strings.** No new state fields.

## Behavior

Reload-sync table (rows = reload points; column = restored machine must satisfy):

| # | Reload after | Persisted snapshot (post-fix) | Restored machine invariant |
|---|---|---|---|
| 1 | proposal delivered (step 3 above) | `round: N+1, negotiateProposed: false, negotiateFeedback: ""` | next settle re-prompts **Tester** (even round), not Writer |
| 2 | feedback delivered | `round: N+1, negotiateFeedback: ""` | next settle does not re-deliver the feedback prompt |
| 3 | reprompt delivered | `negotiateReprompted: true` → cleared by `clearTransientFlags` on restore | next settle re-prompts per parity (current behavior, pinned) |
| 4 | auto-advance to B delivered | `phase: "B", round: 1, justTransitioned: true` → flag cleared on restore | Phase B resumes; the `justTransitioned`-cleared restore means the Writer turn prompt is NOT re-sent (pinned: current `clearTransientFlags` behavior, `session-start.ts:44`) — accepted, see quirk Q1 |
| 5 | escalation delivered | `phase: "escalated"` | terminal short-circuit (`agent-settled/index.ts:37`), no further settles |

**Verbatim pins:** none new. Existing pinned strings (`"Writer must use negotiate_propose tool."`, `"Tester must use negotiate_review tool."`, `"Proposal recorded. Awaiting review."`) unchanged.

**Quirks list:**
- Q1: row 4 — a reload after auto-advance loses the `justTransitioned`-driven Writer turn prompt (it is a transient, cleared by design at `session-start.ts:44`). The Writer must be re-prompted by the user via `/loop-continue`. Current behavior for *all* transients; do not fix here.
- Q2: `deliverFeedback` reads `state.negotiateFeedback` from the *old* state (`negotiate.ts:89`) — correct today because the marker is only cleared in `newState`; pinned, do not "fix" to `newState` (it would read `""`).

**Intended shifts:** none beyond the commit itself.

**Ownership:** `src/events/agent-settled/index.ts` owns the commit call; `test/extension.test.ts` asserts the persistence.

## Inventory

**Files touched (closed list):**
- If refactor landed: **zero** production files. `test/extension.test.ts` + `test/events/session-start.test.ts` only.
- If refactor did not land: this unit is blocked (see Interface). There is no third option.

**Call sites:** the negotiate reassignment at `src/events/agent-settled/index.ts:132` is the single commit point for this spec.

## Test Strategy

- **Baseline:** 32 files / 1017 tests green.
- **Flips:** 0 — no production behavior change beyond adding a persist the tests below assert.
- **New tests (the entire fix, if the refactor landed):**
  1. `test/extension.test.ts` — "negotiate settle persists the advanced round": Writer proposes (tool) → settle delivers review-request → assert a `loop-state` entry with `round: 2, negotiateProposed: false` exists **after** the settle (fails pre-fix: no such entry).
  2. `test/extension.test.ts` — "reload after proposal delivery re-prompts Tester, not Writer": seed session entries with the step-3 snapshot → `session_start` → next settle → assert the delivered prompt is the Tester reprompt (`GP.promptNegotiateRepromptTester()` string, pinned).
  3. `test/extension.test.ts` — "reload after feedback delivery does not re-deliver feedback": seed with post-feedback snapshot → settle → assert `negotiateFeedback` prompt is NOT sent.
  4. `test/events/session-start.test.ts` — the step-3 snapshot shape (round advanced, markers cleared) round-trips through `validateRestoredState` (depends on refactor; skip if blocked).
- **Untouched:** `src/transitions.ts`, `src/tools.ts` — mechanism: this spec adds no decision logic.

## Scope lines

- Production: unchanged (refactor-owned) or blocked.
- `test/extension.test.ts`: added (3 tests).
- `test/events/session-start.test.ts`: added (1 test, refactor-dependent).

## Acceptance Criteria

1. Test 1 above fails on the pre-fix code (no persist after negotiate settle) and passes after.
2. `npm test` green, 32 files.
3. Grep sweep: needle `commit(state, pi)` in `src/events/agent-settled/index.ts` ≥ 1 hit in the negotiate branch (or, pre-refactor, this spec is not implemented).
4. The double-delivery regression (test 3) reproduces the review's B-5 scenario end-to-end: tool persist → settle deliver → reload → settle → no second prompt.

## Dependencies

- **Hard dependency:** `refactor-single-commit-point.md`. If it lands first, this spec becomes test-only and should be renamed `done-` after its tests land.
- **Soft dependency:** `bug-gate-signal-integrity.md` (same dispatcher file; order: gate → commit → this).

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | The 2025-08-18 review (B-5) described this window but attributed the re-prompt parity to "depending on parity" — the closed table above pins it: the proposal is always delivered at the Writer's (odd) round, so the restored round is always odd, so the re-prompt is always the **Writer** — deterministic, not parity-dependent | Accepted — table row 1 is the pin |
| 2 | blocker | Implementing a local persist here would create a 15th ad-hoc `loop-state` site, defeating `refactor-single-commit-point.md` | Rejected as an option — hard dependency pinned in Interface |
