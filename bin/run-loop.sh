#!/usr/bin/env bash
# External loop runner — bridges the pi process lifecycle gap.
#
# Usage:
#   PI_LOOP_RUNNER=1 bin/run-loop.sh <spec-path> [--timeout N]
#
# How it works:
#   1. The extension's sendPrompt() writes the next prompt to .pi/loop-status
#      when PI_LOOP_RUNNER=1 (instead of queuing a followUp that --print mode
#      would never process).
#   2. The runner reads the status file after each pi --continue --print call.
#   3. If status is "continue", the runner sends the stored prompt to a new
#      pi --continue --print process.
#   4. If status is "done" or "escalated", the runner exits.

set -euo pipefail

SPEC_PATH="${1:?Usage: run-loop.sh <spec-path> [--timeout N]}"
shift || true
EXTRA_ARGS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) EXTRA_ARGS="$EXTRA_ARGS --timeout $2"; shift 2 ;;
    *) shift ;;
  esac
done

# Derive workspace root (same logic as getWorkspaceRoot in src/types.ts).
if [[ "$SPEC_PATH" == test/golden/* ]]; then
  WORKSPACE_ROOT="$(dirname "$SPEC_PATH")"
else
  WORKSPACE_ROOT="."
fi
STATUS_FILE="$WORKSPACE_ROOT/.pi/loop-status"
mkdir -p "$WORKSPACE_ROOT/.pi"

read_field() {
  local field="$1"
  if [[ ! -f "$STATUS_FILE" ]]; then
    echo "missing"
    return
  fi
  python3 -c "import json; d=json.load(open('$STATUS_FILE')); print(d.get('$field','missing'))"
}

echo "=== Loop Runner ==="
echo "Spec: $SPEC_PATH $EXTRA_ARGS"
echo "Workspace: $WORKSPACE_ROOT"
echo "Status file: $STATUS_FILE"
echo ""

run_pi() {
  local prompt="$1"
  # Use --continue for all invocations (including the first) so the session
  # is persistent across runner iterations. The first call starts a new
  # session if none exists; subsequent calls continue it.
  echo "$prompt" | PI_LOOP_RUNNER=1 pi --continue --print 2>&1 | tail -5
}

# --- First invocation: start the loop ---
echo "[1] Starting: /loop $SPEC_PATH $EXTRA_ARGS"
run_pi "/loop $SPEC_PATH $EXTRA_ARGS"

S="$(read_field status)"
P="$(read_field phase)"
echo "After start: phase=$P status=$S"

# Phase 0: the loop is in "review" — approve it.
if [[ "$P" == "review" ]]; then
  echo ""
  echo "[2] Approving Phase 0: /loop-approve"
  run_pi "/loop-approve"
  S="$(read_field status)"
  P="$(read_field phase)"
  echo "After approve: phase=$P status=$S"
fi

# Check if the loop completed or escalated.
case "$S" in
  done) echo "Loop completed."; exit 0 ;;
  escalated) echo "Loop escalated." >&2; exit 1 ;;
  missing) echo "Error: status file not found." >&2; exit 1 ;;
esac

# --- Subsequent invocations: continue the loop ---
N=2
while true; do
  S="$(read_field status)"
  P="$(read_field phase)"

  echo ""
  echo "[$N] Turn boundary. Phase: $P | Status: $S"

  case "$S" in
    done)
      echo "Loop completed after $((N-1)) continuations."
      exit 0
      ;;
    escalated)
      echo "Loop escalated at phase $P — human intervention needed." >&2
      exit 1
      ;;
    continue)
      # The extension wrote a specific prompt to the status file.
      # Send that prompt to the next pi process.
      PROMPT="$(read_field prompt)"
      if [[ -z "$PROMPT" || "$PROMPT" == "missing" ]]; then
        echo "Error: status file has no prompt." >&2
        exit 1
      fi
      echo "Continuing with prompt: ${PROMPT:0:80}..."
      run_pi "$PROMPT"
      N=$((N + 1))
      ;;
    active)
      # Fallback: no specific prompt written (e.g., old extension version).
      # Use /loop-continue to let the extension figure out the next step.
      echo "Continuing: /loop-continue"
      run_pi "/loop-continue"
      N=$((N + 1))
      ;;
    *)
      echo "Unknown status: $S" >&2
      exit 1
      ;;
  esac
done
