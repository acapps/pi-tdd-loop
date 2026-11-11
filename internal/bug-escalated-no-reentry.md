# Bug: Escalated state is a dead end — no way to re-enter the loop with work done outside it

## Incident

Session `01a1c767-d3dd-765f-b672-3927a77e75c5.jsonl` (pi-dæmi, spec
`docs/enrich-entry-renderer.md`).

1. Phase A exhausted (3 rounds, zero-test gate — see
   `bug-phase-a-zero-test-prompt.md`) → **escalated** at 21:58 and again after
   `/loop-restart A` at 22:22.
2. At 22:30 the user redirected the agent in free chat: *"Well, there should be
   new tests, no?"*
3. The agent did **exactly the right work**: extracted the inline TUI renderer
   into `core/reaction-renderer.ts` (stub), wrote `reaction-renderer.test.ts`
   (7 tests, all failing with "Not implemented" — the correct stub-era failure
   mode), and verified the failures.
4. But the loop state was still **`escalated`**, so:
   - `negotiate_propose("approve")` → **rejected** (`not-available-in-phase`);
   - no `agent_settled` gate ever ran on the new test files;
   - session ended at 22:45 with `restored → Phase escalated round 3`.

The work existed on disk, un-gated. The only re-entry command was
`/loop-restart <phase>`, which throws away the round context and re-runs from
round 1 — and even that re-enters with a *fresh* prompt, not a re-gate of the
work that already appeared.

## Root cause

`escalated` was modeled as a terminal human-intervention state: every tool
rejects, every gate is inert, and the only escape is a full phase restart.
There is no command that says "the human has decided, the work exists, **gate
it**."

## Fix (implemented alongside `bug-phase-a-zero-test-prompt`)

1. **`/loop-continue` from `escalated` re-enters the loop** (already present in
   `src/commands/status.ts`, uncommitted at incident time): no arg → resume
   `lastPhase` at round 1 with that phase's continue prompt; with a phase arg
   → re-enter that phase. The next `agent_settled` fires the gate on whatever
   is on disk — the re-gate path.
2. **`negotiate_propose` is open in `escalated`** (new `escalate` policy row,
   same as Phase A — `src/tools/policy.ts`): the plan is surfaced verbatim to
   the human, the loop stays paused, and the agent is told to wait. This gives
   the agent a way to *signal* the human that it has finished the redirected
   work, instead of a dead `not-available-in-phase` wall. The human's decision
   is still made by the human (`/loop-continue`).
3. **`/loop-status` tells the user the path** — the escalated branch already
   says "Run /loop-continue to resume."

## Acceptance criteria

1. From `escalated`, `negotiate_propose(plan)` → plan surfaced verbatim via
   `ui.notify` (warning), phase stays `escalated`, `loop-negotiate` entry with
   `action: "escalate"`, agent told to wait for the human (`/loop-continue`).
   No auto-transition.
2. From `escalated`, `/loop-continue` → re-enters `lastPhase` round 1; the next
   `agent_settled` runs the gate on current disk state.
3. `negotiate_review` stays closed in `escalated` (review is the negotiate
   phase's mechanism; re-entry is the continue command's).

## Tests

- `test/tools-split/behavior.test.ts` — policy matrix: A/escalated × propose
  moved from the reject table to the escalate block (surfaced verbatim,
  `loop-negotiate` escalate entry, persisted, wait-for-human reply).
- `test/extension.test.ts` — policy matrix: A × propose → escalate row; C ×
  propose and A/C × review still reject.

## Notes

- `escalated` remains a **pause**, not a terminal state: the loop does not act
  on the surfaced plan; the human decides. This keeps the human-in-the-loop
  invariant of escalation intact.
- The zero-test prompt fix (`bug-phase-a-zero-test-prompt.md`) and this fix
  ship together: the Tester's new prompt tells it to raise via
  `negotiate_propose`, and this fix makes that call land instead of hitting a
  wall.
