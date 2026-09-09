# Feature: Non-Interactive Loop Runner

## Problem

The loop is designed for interactive mode. In interactive mode, the TUI process
stays alive across turns, so `sendUserMessage` with `deliverAs: "followUp"`
queues the next phase prompt and the TUI's event loop picks it up.

In non-interactive mode (`pi --print`), the process exits on `agent_end` before
the followUp queue drains. The loop stalls at the first turn boundary.

This blocks CI/CD usage, unattended runs, and automated testing.

## Solution

Shift turn orchestration from in-process (`agent_settled` → `sendUserMessage`)
to an external runner that invokes `pi --continue --print` in a loop. The
extension already persists state via `appendEntry("loop-state")` and restores
it in `session_start`. The runner just needs to know when to stop.

## Architecture

```
[Runner] ──stdin: "/loop spec.md"──> [pi --continue --print]
                                         │
                                     session_start restores state
                                     /loop starts Phase 0
                                     agent works, settles
                                     agent_settled: gate, advance,
                                       sendUserMessage (followUp)
                                     agent processes followUp
                                     ... (multiple turns within one process)
                                         │
                                     agent_end → process exits
                                         │
[Runner] <── exit code 0 ───────────────┘
   │
   ├── reads .pi/loop-status
   ├── status === "active" → loop: stdin "/loop-continue" → pi --continue --print
   ├── status === "done"   → exit 0
   └── status === "escalated" → exit 1
```

Key insight: within a single `pi --print` invocation, the agent can process
multiple turns (the followUp queue works because the process is alive). The
runner only needs to bridge the *process* boundary, not the *turn* boundary.

## Technical Changes

### 1. Status file: `.pi/loop-status` (in workspace root)

Written by the extension on every `commit()` call. The workspace root is
derived from `getWorkspaceRoot(specPath)` — same as the golden project pattern.

For non-golden projects (workspace root = `"."`), the file goes in `ctx.cwd/.pi/loop-status`.

```json
{
  "status": "active" | "done" | "escalated",
  "phase": "review" | "A" | "negotiate" | "B" | "C",
  "round": 3,
  "specPath": "test/golden/golden-project/spec.md",
  "updatedAt": "2026-09-09T14:00:00.000Z"
}
```

- `status`: `active` = loop in progress; `done` = Phase C passed; `escalated` = human intervention needed.
- `phase`: current phase (from `state.phase`).
- `round`: current round number.
- `specPath`: the spec path (for logging/debugging).
- `updatedAt`: ISO timestamp of the last commit.

The file is written in `commit()` alongside `appendEntry`. If the write fails
(disk error, read-only fs), the extension logs a debug line and continues —
the status file is a convenience for the runner, not a source of truth.
The session entry remains the source of truth.

### 2. Status file write in `commit()`

In `src/commit.ts`, after `api.appendEntry("loop-state", {...state})`:

```ts
// Best-effort status file for external runner.
try {
  const statusFile = path.join(getWorkspaceRoot(state.specPath), ".pi", "loop-status");
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify({
    status: state.phase === "done" ? "done"
      : state.phase === "escalated" ? "escalated"
      : "active",
    phase: state.phase,
    round: state.round,
    specPath: state.specPath,
    updatedAt: new Date().toISOString(),
  }), "utf8");
} catch (err) {
  debug(`commit: status file write failed — ${err}`);
}
```

The `getWorkspaceRoot` call returns `"."` for non-golden projects, so the file
goes in `./.pi/loop-status` relative to the workspace root.

### 3. `/loop-continue` already works from a fresh process

`cmdContinue` (registered as `/loop-continue`) reads `state.current`, which is
hydrated by `session_start` from the session entry. It calls
`buildContinuePrompt(state.current)` which switches on `state.phase` and returns
the right prompt. It sends the prompt via `sendUserMessage`.

No changes needed to `cmdContinue` itself. The existing logic handles:
- Phase A → negotiate → B → C transitions
- Gate failure → retry prompt
- Escalated → resume from `lastPhase`
- Done/idle → "Nothing to continue" notification

### 4. Runner script: `bin/run-loop.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SPEC_PATH="${1:?Usage: run-loop.sh <spec-path>}"
WORKSPACE_ROOT="$(python3 -c "
import os
p = '$SPEC_PATH'
if p.startswith('test/golden/'):
    print(os.path.dirname(p))
else:
    print('.')
")"
STATUS_FILE="$WORKSPACE_ROOT/.pi/loop-status"

# First invocation: start the loop
echo "/loop $SPEC_PATH" | pi --continue --print
check_status

# Subsequent invocations: continue the loop
while true; do
  if [ ! -f "$STATUS_FILE" ]; then
    echo "Error: status file $STATUS_FILE not found." >&2
    exit 1
  fi

  STATUS=$(python3 -c "import json; print(json.load(open('$STATUS_FILE'))['status'])")
  PHASE=$(python3 -c "import json; print(json.load(open('$STATUS_FILE'))['phase'])")

  echo "Turn boundary. Phase: $PHASE | Status: $STATUS"

  case "$STATUS" in
    done)
      echo "Loop completed."
      exit 0
      ;;
    escalated)
      echo "Loop escalated — human intervention needed." >&2
      exit 1
      ;;
    active)
      echo "/loop-continue" | pi --continue --print
      ;;
    *)
      echo "Unknown status: $STATUS" >&2
      exit 1
      ;;
  esac
done

check_status() {
  # After the first /loop invocation, check if the loop already completed
  # (e.g., spec was trivial and the agent finished everything in one process).
  if [ -f "$STATUS_FILE" ]; then
    local s
    s=$(python3 -c "import json; print(json.load(open('$STATUS_FILE'))['status'])")
    case "$s" in
      done) echo "Loop completed on first run."; exit 0 ;;
      escalated) echo "Loop escalated on first run." >&2; exit 1 ;;
    esac
  fi
}
```

### 5. No changes to `agent_settled` handlers

The `agent_settled` handlers still call `sendUserMessage` with
`deliverAs: "followUp"`. Within a single `pi --print` invocation, the process
is alive, so the followUp queue works. The agent processes the followUp, starts
a new turn, works, settles, and the handler sends the next followUp. This
continues until the agent has no more work to do (no more followUps queued),
and the process exits.

The runner then checks the status file and decides whether to launch another
`pi --continue --print` with `/loop-continue`.

## What does NOT change

- `sendUserMessage` calls in `agent_settled` handlers (still `deliverAs: "followUp"`)
- `commit()` logic (still `appendEntry` + validate)
- `session_start` handler (still restores state from entries)
- `cmdContinue` / `buildContinuePrompt` (already handles all phase transitions)
- All 1211 existing tests

## Regression

1. **Status file written on commit:** Call `commit()` with a mock `api`. Assert
   that `.pi/loop-status` exists in the workspace root with the correct JSON.
2. **Status file reflects phase:** Commit with `phase: "done"` → file says
   `"status": "done"`. Commit with `phase: "B"` → `"status": "active"`.
3. **Status file write failure is non-fatal:** Mock `fs.writeFileSync` to throw.
   Assert that `commit()` does not throw and logs a debug line.
4. **Runner script is executable:** `test -x bin/run-loop.sh`.
5. **/loop-continue from fresh process:** Call `cmdContinue` with a hydrated
   state (simulating session_start restore). Assert the correct prompt is sent.

## Scope

- In scope: status file, runner script, regression tests.
- Out of scope: changing `agent_settled` handlers, changing `sendUserMessage`
  calls, changing `session_start` logic, adding a new command (uses existing
  `/loop-continue`).
