# Bug: before-agent context message uses the wrong role in Phase B sub-flows

## Context

`buildBeforeAgent` (`src/events/before-agent.ts`) dispatches the injected `loop-context` message on **phase only**. Phase `negotiate` has a parity rule (`state.round % 2`, `src/commands.ts:36`) that picks Writer vs Tester, but Phase B has no role state at all — so every B-phase turn gets the Writer context, including turns whose actor is the Tester.

## Observed problem

Session `01a0155a` (spec 10), verified in the raw JSONL after the `extract-session.sh` fix:

| Time | Actor | System prompt (correct) | loop-context (wrong) |
|---|---|---|---|
| 15:44:52 | **Tester** (dispute review) | Tester | `WRITER. Write *.ts (non-test files) to pass *.test.ts.` |
| 15:46:14 | **Tester** (dispute fix) | Tester | `You are the TESTER (dispute fix)...` (correct — sent via `handleDisputeFix`) |

The 15:44:52 row is the defect: the Tester was asked to review a Writer-filed dispute while its injected context message told it to *write non-test files*. The system prompt carried the right role, so the model did the right thing — but the context message contradicted it. Session `01a011fa` shows the same pattern on its dispute-review turn (05:12:36, `WRITER (negotiation)`-era text delivered to the Tester).

The same class of defect was the *target* of spec 09 (role-fied text in dispute prompts) — the prompt strings were fixed, but the before-agent context layer was not.

## Proposed fix

1. Track the B-phase actor in state: reuse/extend the existing `disputeFiler`-style field (added by spec 09) — e.g. `bActor?: "writer" | "tester"` set when a B turn is triggered for dispute review (`handleDisputeReview`/`triggerDisputeReview`) and cleared by `clearTransientFlags`.
2. In `buildBeforeAgent`, for phase `B`: `bActor === "tester"` → Tester context (review or fix, per the existing flags); otherwise the current Writer context.
3. Sweep: no B-phase turn may emit a `WRITER.`-prefixed context while `awaitDisputeReview`/`awaitDisputeFix` is set (new unit test on `buildBeforeAgent` for both sub-flow states).

## Acceptance

- `buildBeforeAgent` in phase B with `awaitDisputeReview: true` returns the Tester review context (test pins the exact string).
- `buildBeforeAgent` in phase B with `awaitDisputeFix: true` returns the Tester fix context (existing behavior preserved).
- `buildBeforeAgent` in phase B with neither flag returns the Writer context (existing behavior preserved).
- `clearTransientFlags` clears the new actor field (add to the existing test that pins the cleared set).
- `npm test` green.

## Evidence

Session `01a0155a` JSONL, `custom_message` entries: 15:44:52 `{"customType":"loop-context","content":"WRITER. Write *.ts (non-test files) to pass *.test.ts."}` immediately after `loop-debug "Dispute review → tester review turn"` (15:44:52.505). Contrast 15:46:14 where the Tester fix context is correct.
