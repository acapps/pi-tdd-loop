# Bug: Session reload mid-phase restarts the whole phase instead of resuming the turn

## Context

Session `01a011fa` (spec 09), Phase A. The Tester was mid-phase (tests being written, 26 failures outstanding) when the session was reloaded at 04:27:19. State restored to `Phase A round 1` and the Tester was re-prompted from scratch — re-reading the spec, re-deriving the contract — instead of resuming where it stopped. Combined with a compaction event at 04:30:01, Phase A took ~40 minutes and the whole run 6+ hours.

## Observed problem

1. `session_start` restores `state.current` from the last `loop-state` entry (`src/events/session-start.ts`), which records **phase + round**, not turn position.
2. `buildRestartPrompt` (`src/events/before-agent.ts:60-64`) maps phase → a fresh phase prompt (`promptTesterPhaseARestart` etc.). There is no "resume mid-phase" path: the agent gets the same instruction it got at phase entry, with no record of what it had already done.
3. Consequences observed: duplicated work (the Tester re-verified and re-wrote contract sections), and — because the restart prompt is identical to the entry prompt — no way for the agent to know its previous turn's edits are still on disk. In spec 09 the reload also landed while 33→26 test failures were outstanding; the "restart" silently discarded the failure context (it lives in the compacted conversation, not in state).

## Proposed fix

1. Persist turn-level progress: extend `loop-state` (or a new `loop-progress` entry) with a lightweight per-phase checkpoint — e.g. `phaseCheckpoint: { round, turnsUsed, lastAction: string, failuresOutstanding?: number }` written at each gate/refusal/dispute event (all already emit `loop-state` or `loop-debug`; the data exists, it just isn't retained).
2. On `session_start` restore, if the restored state is mid-phase (turnsUsed > 0 or a pending flag like `awaitDisputeReview`), send a **resume** prompt instead of the restart prompt: "You are the TESTER, Phase A round N. You previously: <lastAction>. Outstanding: <failuresOutstanding>. Continue — do not re-read the spec unless something is missing."
3. Keep the full restart prompt for the genuine phase-entry case (turnsUsed == 0), so first-entry behavior is unchanged.
4. *Scope question for Phase 0:* how fine-grained is the checkpoint? Minimum viable = `lastAction` + `failuresOutstanding` from the most recent gate. Richer (per-file progress) is probably overkill — decide before scoping.

## Acceptance

- Reload with `turnsUsed > 0` mid-phase → resume prompt delivered (test pins the string shape: includes round, lastAction, failuresOutstanding), not the restart prompt.
- Reload at phase entry (`turnsUsed == 0`) → restart prompt, unchanged (existing tests preserved).
- `clearTransientFlags` / restart paths reset the checkpoint (add to the existing clear-flags test).
- `npm test` green.

## Evidence

Session `01a011fa`: 04:08:07 `Gate fail (33 failures)` → advance to negotiate; 04:27:19 `session_start: restored → Phase A round 1` (note: restored to A, not negotiate — the reload itself was anomalous, but the restore path has no mid-phase distinction either); 04:31:10 full `promptTesterPhaseA` re-delivered; 04:30:01 compaction. Phase A re-ran to completion at 04:45.
