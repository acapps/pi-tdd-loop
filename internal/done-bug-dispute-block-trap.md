# Bug: Dispute review window hard-blocks all tool calls, trapping the filer in its own turn

## Context

Session `01a011fa` (spec 09), Phase B, 2026-08-18T05:09-05:12. The Writer filed a dispute via `negotiate_propose`, then burned ~90 seconds on 5 consecutive blocked tool calls (`git checkout`, `ls`, `echo "shell test"`, `read`) before the gate's retry effect finally cleared the flag and delivered the review prompt. The Writer's own diagnosis in the transcript: *"My tool shell is blocked by the dispute-review block rule ... the block string is pre-09 text, so the extension is running from a stale build. The settle event that would clear the flag never fires in this harness."*

## Observed problem

1. Filing a dispute sets `awaitDisputeReview = true` (`triggerDisputeReview`, `src/tools.ts`).
2. Rule 2 (`src/events/tool-call.ts:49-72`) blocks **every** tool call while `awaitDisputeReview` is set — including `read` and `bash`, not just writes.
3. The tool result tells the agent `"Dispute filed. Waiting for Tester review. STOP producing tool calls."` — but the agent's turn only ends via `agent_settled`, which only fires when the model stops emitting tool calls on its own. A model that keeps calling (or whose harness is a long-running session where settle doesn't fire promptly) stays blocked indefinitely: every probe returns the same refusal string, so it keeps probing.
4. Recovery depends on the gate's retry effect clearing the flag — a side channel the agent cannot see or control. In the observed run the block string was pre-spec-09 text, i.e. the loop was dogfooding on a **stale build** of the very code it was trying to fix, and the agent had no way to detect or report that.

The design intent (filed → filer stops, reviewer gets the next turn) is sound; the mechanism (hard-block all tools inside the filer's own live turn) is not.

## Proposed fix

1. **Block writes, not reads.** In the `awaitDisputeReview` window, block write-class tools (`write`/`edit` on project paths) with the dispute reason, but allow read-only tools (`read`, `bash` for inspection) so the agent can finish its turn cleanly. The dispute claim is already captured (`lastProposal`), so further reads cannot corrupt state.
   - *Design question (decide in Phase 0):* is there a real case where a filer must also be blocked from `bash` during review? If not, reads-only-block is the general rule.
2. **Make the stop instruction effective.** The tool result and the context message should instruct the agent to *end its turn* (stop emitting tool calls) rather than "STOP producing tool calls" (which it cannot enforce on itself mid-stream). The next turn belongs to the reviewer.
3. **Stale-build detection.** On `session_start`, compare the loaded extension's source hash (or a build stamp) against the version that wrote the last `loop-state` entry; if they differ, emit a `loop-debug` + `ui.notify` warning ("loop state written by a different build") so a dogfood session flags itself instead of silently running old block strings.

## Acceptance

- After filing a dispute, the filer can still call `read` (test passes: tool-call rule table row for `awaitDisputeReview` + read → allow) and is blocked from `write`/`edit` (existing row preserved).
- The dispute tool result text instructs ending the turn; no "STOP producing tool calls" phrasing remains in `src/` (sweep: `rg -n "STOP producing" src/` → 0).
- A session restored from a state entry written by a different build emits exactly one warning (unit test on the session-start comparison).
- `npm test` green.

## Evidence

Session `01a011fa`, 05:09:59-05:10:37: five `toolResult` entries all reading `Dispute filed. Waiting for Tester review. STOP producing tool calls.` after calls to `bash`/`read`; `loop-refusal` entry at 05:09:24 (blocked `edit` on `test/extension.test.ts`); Writer's final text at 05:10:37 diagnosing the stale build. Recovery only at 05:12:36 when the gate delivered `promptWriterDispute`.
