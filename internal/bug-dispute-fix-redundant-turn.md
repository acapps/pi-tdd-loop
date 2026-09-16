# Bug: Concession fix window re-prompts the Tester for work it already finished in the same turn

## Context

Session `01a0155a` (spec 10), Phase B, 2026-08-18T15:45-15:46. The Tester reviewed a Writer-filed dispute, verified the claim against the tree, and called `negotiate_review` with `decision='approve'` (concede) — then, **in the same turn**, edited the flagged test and ran the full suite green (1017/1017). When the turn settled, `handleDisputeFix` fired anyway and delivered `Conceded dispute. Fix the test in *.test.ts to match the spec...` to an agent whose work was already done.

## Observed problem

1. `executeBDisputeConcede` (`src/tools.ts`) sets `awaitDisputeFix = true` at decision time. The flag's purpose is to *give the Tester a turn* to fix the test.
2. Nothing checks whether the Tester already acted in the decision turn. The fix prompt is delivered unconditionally on the next settle (`handleDisputeFix`, `src/events/agent-settled/dispute.ts:39-50`), plus a duplicate Tester context message via before-agent.
3. Cost observed: one wasted full agent turn (re-read, re-verify, re-confirm) and a confusing double instruction. In longer fix windows this pattern wastes a round of `maxB` budget per dispute.

Worse variant: if the Tester's in-turn fix is incomplete, the delivered prompt tells it to fix a test it *thinks* it already fixed — the diff between the two states is invisible to the prompt.

## Proposed fix

1. Record at decision time whether the concession is already satisfied: before clearing the turn, run the gate (or at minimum `runTests`) — if green, skip `awaitDisputeFix` entirely (the fix window's job is done) and proceed to the normal B gate on settle.
2. If still red, keep the current fix-window behavior (prompt + Tester turn), but make the prompt state-aware: include the current failure count so the Tester isn't re-deriving from scratch.
3. Alternative (cheaper, no gate call at decision time): let the settle handler check the *last* gate result if it is newer than the concede decision timestamp; only deliver the fix prompt when the suite is red at that point.

*Design question for Phase 0:* is a gate run at decision time acceptable latency-wise (it adds ~10-30s per conceded dispute), or is the timestamp comparison the right trade?

## Acceptance

- Concede decision + suite already green in the decision turn → no fix prompt sent on settle (test: `sentMessages` length 0 for the fix path, flag cleared, advance/done effect proceeds).
- Concede decision + suite red → fix prompt sent, exactly as today (existing tests preserved).
- No new `loop-state` entries beyond the existing concede entry.
- `npm test` green.

## Evidence

Session `01a0155a`: 15:45:25 `negotiate_review decision=approve` → 15:45:25 `loop-dispute action=concede` → 15:45:43 Tester `edit`s `test/events/agent-settled/index.test.ts` → 15:46:04 `npm test` green (1017/1017) → 15:46:14 `loop-debug "Tester fixing test"` + `promptTesterDisputeFix` delivered ("Conceded dispute. Fix the test in *.test.ts to match the spec. When done, stop producing tool calls.").
