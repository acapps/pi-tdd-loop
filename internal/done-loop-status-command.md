# implement-loop-status-command

## Problem

Verified current state as of writing:

The loop runs for minutes to hours. The user sees status bar updates
("Phase B — round 2") and notifications, but there is no way to query what
the loop is doing without reading the session transcript.

The user's first question during a long run is "what is it doing right now?"
The current answer is "open the transcript and scroll." There is no
`/loop-status` command.

The state is already tracked: `state.current` has `phase`, `round`,
`turnsThisPhase`, `maxTurnsPerPhase`, `disputeCount`, `specPath`. The last
gate result is available in the most recent `loop-debug` entry. The last
agent action is in the session transcript (not in `LoopState`).

## Target

A `/loop-status` command that prints a snapshot of the current loop state:

```
Phase: B (round 2/5)
Turns this phase: 3/5
Disputes: 0/3
Spec: spec.md
Language: go / maven
```

If the loop is not running (phase is `idle` or `done`):
```
Loop is not running. (last phase: C, status: done)
```

The command is read-only: it does not mutate state, does not commit, does
not send a prompt. It uses `ctx.ui.notify` to display the snapshot.

## Interface

New command: `/loop-status`

```ts
// src/commands.ts
export function cmdStatus(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Show current loop status",
    handler: async (_args: string, ctx: CommandContext) => {
      const s = state.current;
      if (s.phase === "idle") {
        ctx.ui.notify("Loop is not running.", "info");
        return;
      }
      if (s.phase === "done") {
        ctx.ui.notify(
          `Loop complete. (Phase ${s.lastPhase}, round ${s.round})`,
          "info",
        );
        return;
      }
      if (s.phase === "escalated") {
        ctx.ui.notify(
          `Loop escalated at Phase ${s.lastPhase}, round ${s.round}. Run /loop-continue to resume.`,
          "warning",
        );
        return;
      }
      const maxTurns = s.maxTurnsPerPhase ?? 5;
      const lines = [
        `Phase: ${s.phase} (round ${s.round}/${s[`max${s.phase}`] ?? 5})`,
        `Turns this phase: ${s.turnsThisPhase}/${maxTurns}`,
        `Disputes: ${s.disputeCount}/${s.maxDispute}`,
        `Spec: ${s.specPath}`,
        `Language: ${s.language} / ${s.buildTool}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      debug(`Command: /loop-status → ${lines.join(", ")}`);
    },
  };
}
```

Registered in `index.ts`:
```ts
pi.registerCommand("loop-status", Cmd.cmdStatus(state, pi, debug));
```

## Behavior

Order (pinned):
1. Read `state.current`
2. Branch on `phase`:
   - `idle` → "Loop is not running."
   - `done` → "Loop complete. (Phase X, round Y)"
   - `escalated` → "Loop escalated at Phase X, round Y. Run /loop-continue to resume."
   - `review` → "Phase 0: awaiting review. Use /loop-approve to proceed."
   - `A`/`B`/`C` → multi-line snapshot (phase, round, turns, disputes, spec, language)
3. `ctx.ui.notify(...)` — display
4. `debug(...)` — log (only for active phases)

No `commit()` call. No `sendUserMessage` call. Read-only.

## Test Strategy

- Unit test: `cmdStatus` with Phase B state. Assert notify contains
  "Phase: B", "round", "Turns this phase", "Disputes", "Spec", "Language".
- Unit test: `cmdStatus` with `phase: "idle"`. Assert "Loop is not running."
- Unit test: `cmdStatus` with `phase: "done"`. Assert "Loop complete."
- Unit test: `cmdStatus` with `phase: "escalated"`. Assert "Loop escalated."
- Unit test: `cmdStatus` with `phase: "review"`. Assert "awaiting review."
- Unit test: `cmdStatus` does NOT call `commit` (read-only).
- Unit test: `cmdStatus` does NOT call `sendUserMessage`.
- No live-toolchain tests.

## Scope

- In scope: `cmdStatus` in `src/commands.ts`, registration in `index.ts`,
  tests.
- Out of scope: reading `loop-debug` entries for last gate result (would
  require parsing session entries — deferred), displaying the last agent
  action (would require transcript access — deferred), a `/loop-report`
  command with full metrics.

## Acceptance

- [ ] `/loop-status` registered as a command
- [ ] Active phase: multi-line snapshot with phase, round, turns, disputes, spec, language
- [ ] `idle`: "Loop is not running."
- [ ] `done`: "Loop complete."
- [ ] `escalated`: "Loop escalated at Phase X, round Y."
- [ ] `review`: "awaiting review"
- [ ] Does NOT call `commit`
- [ ] Does NOT call `sendUserMessage`
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all pass
