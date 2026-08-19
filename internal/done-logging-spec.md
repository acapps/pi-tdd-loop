# Behavioral Logging for Loop Extension

## Problem

Current debug logs show internal state transitions (`phase=B r=2 dt=false jt=false`) but not behavioral events. To diagnose a run, the agent must mentally replay the state machine from cryptic state dumps.

## Goal

Add behavioral log lines that describe **what happened** at a high level, so the agent (or user) can diagnose issues instantly without traversing the state machine code.

## Design Principles

1. **One line per meaningful event** — each log entry describes a single action
2. **Human-readable** — no cryptic state abbreviations
3. **Searchable** — use consistent prefixes so `grep` or visual scanning finds the right event
4. **Complementary to state logs** — behavioral logs explain what, state logs show how

## Current Custom Types (from session.jsonl)

| Type | Count | Purpose |
|------|-------|---------|
| `loop-debug` | 69 | Internal state messages (too verbose, too technical) |
| `loop-context` | 10 | Context messages injected into conversation |
| `loop-state` | 6 | State snapshots |
| `loop-refusal` | 2 | Blocked tool calls |
| `loop-negotiate` | 2 | Negotiation tool calls |
| `loop-dispute` | 2 | Dispute events |

## Proposed New Custom Type: `loop-event`

A new custom type for behavioral events. Each entry has a category and a human-readable message.

### Format

```json
{
  "type": "custom",
  "customType": "loop-event",
  "data": {
    "ts": 1786632815743,
    "category": "gate",
    "msg": "Gate failed: 3 tests failed, coverage 0%"
  }
}
```

### Categories

| Category | When | Example |
|----------|------|---------|
| `phase-start` | Phase begins | `"Phase B started (Writer)"` |
| `phase-end` | Phase completes | `"Phase B passed → advancing to Phase C"` |
| `gate-pass` | Gate passes | `"Gate passed: compile=true, tests=true, coverage=95%"` |
| `gate-fail` | Gate fails | `"Gate failed: 3 tests failed, coverage 0%"` |
| `retry` | Phase retries | `"Retry: Writer round 3 of 5"` |
| `tool-call` | Tool called | `"Tool: negotiate_propose (dispute #1)"` |
| `tool-blocked` | Tool call blocked | `"Tool blocked: write stringutil_test.go (Phase B, test file)"` |
| `tool-result` | Tool returned | `"Tool result: negotiate_review (approve)"` |
| `dispute-filed` | Writer disputes | `"Dispute #1: 'TestIsPalindrome: AbCa is not a palindrome'"` |
| `dispute-reviewed` | Dispute reviewed | `"Dispute reviewed: Tester conceded"` |
| `dispute-defended` | Dispute defended | `"Dispute defended: Writer will fix code"` |
| `dispute-fix` | Tester fixes test | `"Tester entering dispute fix mode"` |
| `escalation` | Loop escalated | `"Escalated: Phase B exhausted (5/5 rounds)"` |
| `loop-done` | Loop completed | `"Loop complete: all phases passed"` |

## Example Session with Behavioral Logs

**Before (current):**
```
agent_settled entry: phase=B r=2 dt=false jt=false nf=false nr=false dc=2
agent_settled: running gate → phase=B r=2 dt=false jt=false nf=false nr=false dc=2
Gate result: compile=true tests=false cov=0% failures=0
Transition effect: retry → phase=B r=3 dt=false jt=false nf=false nr=false dc=2
agent_settled: retry B r=3 → phase=B r=3 dt=false jt=false nf=false nr=false dc=2
before_agent_start: Phase B (Writer), round 3
```

**After (behavioral):**
```
[gate-fail] Gate failed: tests=false, 0 failures captured, coverage=0%
[retry] Writer round 3 of 5
[phase-start] Phase B round 3 (Writer)
```

**Before (dispute):**
```
negotiate_propose: plan=The 12 failing tests assert... phase=B
negotiate_propose: Phase B dispute, claim=The 12 failing tests assert...
dispute: The 12 failing tests assert...
agent_settled entry: phase=B r=2 dt=false jt=false nf=false nr=false dc=2
agent_settled: dispute review turn → phase=B r=2 dt=false jt=false nf=false nr=false dc=2
```

**After (behavioral):**
```
[tool-call] Tool: negotiate_propose
[dispute-filed] Dispute #2: 'The 12 failing tests assert...'
[dispute-reviewed] Awaiting Tester review
```

## Implementation Plan

### Step 1: Add helper function (`src/logging.ts`)

```typescript
export function logEvent(
  debug: (msg: string) => void,
  category: string,
  msg: string,
  pi: ExtensionAPI,
): void {
  pi.appendEntry("loop-event", { ts: Date.now(), category, msg });
  debug(`[${category}] ${msg}`);
}
```

### Step 2: Replace existing debug calls with behavioral events

In `events.ts`, `tools.ts`, `transitions.ts`:

| Current | New |
|---------|-----|
| `debug("Gate result: compile=true tests=false cov=0%")` | `logEvent(debug, "gate-fail", "tests=false, coverage=0%", pi)` |
| `debug("Transition effect: retry → phase=B r=3")` | `logEvent(debug, "retry", "Writer round 3 of 5", pi)` |
| `debug("negotiate_propose: Phase B dispute, claim=...")` | `logEvent(debug, "dispute-filed", `Dispute #2: '...'``, pi)` |

### Step 3: Keep state logs as fallback

Keep `loop-debug` for detailed state dumps. Behavioral logs are the primary view; state logs are for deep debugging.

## Session Extraction Script

Create `scripts/extract-session.sh`:

```bash
#!/bin/bash
# Extract behavioral events from a session file
# Usage: scripts/extract-session.sh <session-file>

SESSION_FILE="$1"
if [ -z "$SESSION_FILE" ]; then
  SESSION_FILE=$(ls -t ~/.pi/agent/sessions/--Users-alancapps-.pi-agent-extensions-loop-go-bak--/*.jsonl | head -1)
fi

grep '"customType":"loop-event"' "$SESSION_FILE" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        data = d.get('data', {})
        ts = d.get('timestamp', '')
        cat = data.get('category', '')
        msg = data.get('msg', '')
        print(f'[{ts}] [{cat}] {msg}')
    except: pass
"
```

## Acceptance Criteria

1. Running `/loop <spec>` produces `loop-event` entries in the session file
2. `scripts/extract-session.sh` outputs readable behavioral log lines
3. An agent can diagnose a loop issue from the behavioral log alone (without reading code)
4. Existing `loop-debug` entries still work (no breaking changes)

## Metrics (for the test harness)

After implementing, measure:
- Can the agent diagnose a failed run from behavioral logs alone?
- How many log lines are needed vs current approach?
- Does the extraction script work reliably?
