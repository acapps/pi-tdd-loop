# implement-loop-pause-command

## Problem

Verified current state as of writing:

The loop is a long-running autonomous process. Once started, the user's only
interruption options are:
- ESC in the TUI — interrupts the current turn, loses in-flight work
- Kill the process — loses the session (though state is persisted via
  `commit()` on every transition)

There is no `/loop-pause` or `/loop-stop` command. If the agent is going in
circles in Phase B round 3 (not quite hitting the 5× breaker threshold, just
slowly wasting turns), the user cannot cleanly stop the loop, inspect what
happened, fix the spec, and resume.

The state is already persisted. `commit()` is called on every phase transition,
gate result, and dispute event. The `session_start` handler restores state on
the next process start. What's missing is a command that sets the phase to a
stopped state and commits.

## Target

A `/loop-stop` command that:
1. Sets `state.current.phase = "escalated"` and `state.current.lastPhase` to
   the current phase
2. Commits the state (persists via `appendEntry`)
3. Sends a notification: "Loop stopped at Phase X, round Y. Run /loop-continue
   to resume."
4. Does NOT send a prompt (no `sendUserMessage`) — the loop is stopped, not
   transitioning

The user can then:
- Inspect the files the agent wrote
- Fix the spec or the code
- Run `/loop-continue` to resume from the stopped phase

## Interface

New command: `/loop-stop`

```ts
// src/commands.ts
export function cmdStop(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Stop the loop, preserving state for /loop-continue",
    handler: async (_args: string, ctx: CommandContext) => {
      if (isIdleOrDone(state.current.phase)) {
        ctx.ui.notify("Loop is not running.", "warning");
        return;
      }
      const prevPhase = state.current.phase;
      const round = state.current.round;
      state.current.phase = "escalated";
      state.current.lastPhase = prevPhase;
      commit(state.current, pi, debug);
      ctx.ui.notify(
        `Loop stopped at Phase ${prevPhase}, round ${round}. Run /loop-continue to resume.`,
        "info",
      );
      ctx.ui.setStatus("loop", `Stopped — Phase ${prevPhase} round ${round}`);
      debug(`Command: /loop-stop → phase ${prevPhase} → escalated`);
    },
  };
}
```

Registered in `index.ts` alongside the other commands:
```ts
pi.registerCommand("loop-stop", Cmd.cmdStop(state, pi, debug));
```

The `escalated` phase is reused (not a new phase value). `cmdContinue` already
handles `escalated` → resume from `lastPhase` (verified at
`src/commands.ts:299-301`).

## Behavior

Order (pinned):
1. Check `isIdleOrDone` — if idle or done, notify and return
2. Save `prevPhase` and `round`
3. Set `phase = "escalated"`, `lastPhase = prevPhase`
4. `commit(state.current, pi, debug)` — persist
5. `ctx.ui.notify(...)` — tell the user
6. `ctx.ui.setStatus(...)` — update status bar
7. `debug(...)` — log

No `sendUserMessage` call. The loop is stopped, not transitioning.

## Test Strategy

- Unit test: call `cmdStop` handler with a Phase B state. Assert `phase` is
  `"escalated"`, `lastPhase` is `"B"`, `commit` was called, `sendUserMessage`
  was NOT called.
- Unit test: call `cmdStop` with `phase: "idle"`. Assert notify with "Loop is
  not running.", no state change.
- Unit test: call `cmdStop` with `phase: "done"`. Assert same as idle.
- Unit test: after `cmdStop`, call `cmdContinue` handler. Assert it resumes
  from the saved `lastPhase`.
- No live-toolchain tests.

## Scope

- In scope: `cmdStop` in `src/commands.ts`, registration in `index.ts`,
  tests in `test/extension.test.ts` (or a new `test/loop-stop.test.ts`).
- Out of scope: changing `cmdContinue`, changing `cmdLoop`, adding a new
  phase value, changing the state machine in `src/transitions.ts`.

## Acceptance

- [ ] `/loop-stop` registered as a command
- [ ] Sets `phase = "escalated"`, `lastPhase = <current phase>`
- [ ] Calls `commit()` (state persisted)
- [ ] Does NOT call `sendUserMessage`
- [ ] Notifies user with phase and round
- [ ] `/loop-continue` after `/loop-stop` resumes from the saved phase
- [ ] `/loop-stop` when idle/done: warning, no state change
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all pass
