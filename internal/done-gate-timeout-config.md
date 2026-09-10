# implement-gate-timeout-config

## Problem

Verified current state as of writing:

`src/gates.ts` hardcodes gate execution timeouts:
- Line 36: `execCommand(..., cwd, 30_000)` — compile: 30s
- Line 46: `execCommand(..., cwd, 60_000)` — test: 60s

These values are reasonable for small projects (a Go project compiles in <2s,
tests in <5s). They are not reasonable for:
- Mid-size Java projects: Maven test runs routinely take 2-5 minutes
- Large TypeScript projects: `vitest run` on a 500-file monorepo can take
  1-3 minutes
- Any project with slow integration tests

When the timeout fires, `execFile` kills the process and returns an error.
`execCommand` wraps this as an `ExecOutcome` with `error: true`. The gate
treats this as a **gate error** (not a test failure), which escalates the loop.

So a project with a slow test suite will always escalate, always. The user
cannot run the loop on their project without editing the source.

## Target

Gate timeouts are configurable via a `/loop` flag:
```
/loop spec.md --timeout 120
```

The `--timeout` value (in seconds) applies to both compile and test
commands. Default remains 30s compile / 60s test when the flag is absent.

The timeout is stored in `LoopState` as `gateTimeoutSec: number` (default 60,
applied to test; compile is always `gateTimeoutSec / 2`).

## Interface

`LoopState` gains one field:
```ts
gateTimeoutSec: number; // default 60; compile = /2
```

`runGate` signature gains an optional parameter:
```ts
export async function runGate(
  language: LanguageKey,
  buildTool: BuildTool,
  cwd: string,
  timeoutSec?: number, // default 60
): Promise<GateResult>
```

`cmdLoop` in `src/commands.ts` parses `--timeout <N>` from the command args
and stores it in `state.current.gateTimeoutSec`.

`gate-transition.ts` passes `state.current.gateTimeoutSec` to `runGate`.

## Behavior

Order (pinned):
1. `cmdLoop` parses `--timeout <N>` (integer, seconds). If absent, default 60.
2. `state.current.gateTimeoutSec = N`
3. `runGate` receives `timeoutSec` parameter. Compile timeout =
   `max(10, timeoutSec / 2)` (minimum 10s). Test timeout = `timeoutSec`.
4. If the timeout fires, the gate returns an error (existing behavior,
   unchanged).

The `--timeout` flag is positional-optional: `/loop spec.md --timeout 120`
or `/loop --timeout 120 spec.md` (parsed from args array, not string split).

## Test Strategy

- Unit test: `runGate` with `timeoutSec: 1` on a command that sleeps 2s.
  Assert the gate returns an error (timeout fired).
  **Live-toolchain rule:** this test uses `sleep` (a shell builtin), not a
  real language toolchain. It does not spawn `go`, `mvn`, or `vitest`.
  However, it DOES spawn a real process (`sleep`), so it must be in
  `test/e2e/` or use a mocked `execFile`. **Decision: mock `execFile`** —
  assert it's called with `timeout: 60000` (for default) or `timeout: 120000`
  (for `--timeout 120`). No real process.
- Unit test: `cmdLoop` with `--timeout 120` in args. Assert
  `state.current.gateTimeoutSec === 120`.
- Unit test: `cmdLoop` without `--timeout`. Assert
  `state.current.gateTimeoutSec === 60`.
- Unit test: `gate-transition` passes `state.gateTimeoutSec` to `runGate`.
- No live-toolchain tests.

## Scope

- In scope: `src/gates.ts` (parameter), `src/types.ts` (new field),
  `src/commands.ts` (flag parsing), `src/events/agent-settled/gate-transition.ts`
  (pass the value), `src/state-validation.ts` (validate the new field),
  tests.
- Out of scope: per-language timeout config, project-level config file
  (`.pi/loop-config.json`), separate compile/test timeouts.

## Acceptance

- [ ] `LoopState` has `gateTimeoutSec: number` (default 60)
- [ ] `/loop spec.md --timeout 120` sets `gateTimeoutSec = 120`
- [ ] `/loop spec.md` (no flag) sets `gateTimeoutSec = 60`
- [ ] `runGate` uses `timeoutSec` for test, `max(10, timeoutSec/2)` for compile
- [ ] `gate-transition` passes `state.gateTimeoutSec` to `runGate`
- [ ] `state-validation` accepts `gateTimeoutSec` (positive integer)
- [ ] All existing gate tests pass (default 60s unchanged)
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all pass
