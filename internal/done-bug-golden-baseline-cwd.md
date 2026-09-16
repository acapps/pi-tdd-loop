# Bug: Golden project baseline runs in wrong cwd + sendUserMessage RPC fix

## Failure 1: Baseline in wrong cwd

When `/loop test/golden/golden-project/spec.md` is invoked, the Phase 0 baseline
check runs `go test -json ./...` in `ctx.cwd` (the directory where pi was started)
instead of the workspace root (`test/golden/golden-project/`).

In a greenfield golden project (no `go.mod` yet), `go test` fails with:
```
pattern ./...: directory prefix . does not contain main module or its selected dependencies
```

The loop refuses to start: "Baseline check failed: the existing test suite is not green."

## Failure 2: sendUserMessage fails in RPC mode

All `sendUserMessage` calls used `{ triggerTurn: true }` which is not a valid
option in the real SDK (v0.85.0). The real SDK uses `deliverAs: "steer" | "followUp"`.
Without `deliverAs`, calling `sendUserMessage` while the agent is still streaming
throws: "Agent is already processing. Specify streamingBehavior to queue the message."

In interactive mode, the TUI handles the timing differently and the error doesn't
surface. In RPC mode, it causes the loop to stall.

## Fix

1. **Baseline cwd:** In `cmdLoop`, compute `workspaceRoot = getWorkspaceRoot(specPath)`.
   Use it for `detectProject` and `runBaseline`. Self-refactor: `workspaceRoot` is
   `"."` → same as `ctx.cwd`, no behavior change.

2. **sendUserMessage:** Replace all `{ triggerTurn: true }` with
   `{ deliverAs: "followUp" }` (17 calls across 7 files). Replace
   `{ triggerTurn: false }` with `{}` (1 call). Update the mock type to match
   the real SDK. Update 33 test assertions.

3. **Golden project seed:** Added `go.mod` and `stringutil.go` (empty package stub)
   to `test/golden/golden-project/` so `go test ./...` can run and return
   `[no test files]` (recognized by `detectNoTests`).

## RPC Mode Limitation (not a bug)

RPC mode (`pi --mode rpc`) exits on `agent_end` before the followUp queue is
drained. This means RPC mode cannot drive a multi-turn loop. The loop is designed
for interactive mode where the TUI keeps the session alive between turns.

Verified: the loop successfully runs Phase 0 → A → Negotiate in RPC mode with
zero extension errors after the deliverAs fix. It stalls at the Negotiate → B
transition because the process exits before the followUp prompt is processed.

## Regression

1. **Baseline in workspace root:** Call `cmdLoop` with a golden project spec path.
   Assert that `runBaseline` receives the workspace root, not `ctx.cwd`.
2. **Greenfield golden project:** Golden project with `go.mod` but no test files.
   Assert that `/loop` starts successfully (baseline `noTests: true`).
3. **deliverAs on sendUserMessage:** All agent-settled handlers send prompts with
   `deliverAs: "followUp"`.
