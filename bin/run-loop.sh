#!/usr/bin/env bash
# External loop runner — bridges the pi process lifecycle gap.
#
# Within a single `pi --print` invocation, the agent can process multiple
# turns (followUp queue works because the process is alive). This runner
# only bridges the *process* boundary: when pi exits, it checks the status
# file and relaunches with /loop-continue if the loop is still active.
#
# Usage:
#   PI_LOOP_RUNNER=1 bin/run-loop.sh <spec-path>
#
# The PI_LOOP_RUNNER=1 env var tells commit() to write .pi/loop-status.

set -euo pipefail

SPEC_PATH="${1:?Usage: run-loop.sh <spec-path>}"

# Derive workspace root (same logic as getWorkspaceRoot in src/types.ts).
if [[ "$SPEC_PATH" == test/golden/* ]]; then
  WORKSPACE_ROOT="$(dirname "$SPEC_PATH")"
else
  WORKSPACE_ROOT="."
fi
STATUS_FILE="$WORKSPACE_ROOT/.pi/loop-status"

read_status() {
  if [[ ! -f "$STATUS_FILE" ]]; then
    echo "missing"
    return
  fi
  python3 -c "import json; d=json.load(open('$STATUS_FILE')); print(d['status'])"
}

read_phase() {
  python3 -c "import json; d=json.load(open('$STATUS_FILE')); print(d['phase'])"
}

# --- First invocation: start the loop ---
echo "Starting loop: /loop $SPEC_PATH"
echo "/loop $SPEC_PATH" | pi --continue --print

# Check if the loop completed in the first process (trivial spec).
S="$(read_status)"
case "$S" in
  done) echo "Loop completed on first run."; exit 0 ;;
  escalated) echo "Loop escalated on first run." >&2; exit 1 ;;
  missing) echo "Error: status file not found after first run." >&2; exit 1 ;;
esac

# --- Subsequent invocations: continue the loop ---
while true; do
  S="$(read_status)"
  P="$(read_phase)"

  echo "Turn boundary. Phase: $P | Status: $S"

  case "$S" in
    done)
      echo "Loop completed."
      exit 0
      ;;
    escalated)
      echo "Loop escalated — human intervention needed." >&2
      exit 1
      ;;
    active)
      echo "Continuing: /loop-continue"
      echo "/loop-continue" | pi --continue --print
      ;;
    *)
      echo "Unknown status: $S" >&2
      exit 1
      ;;
  esac
done
