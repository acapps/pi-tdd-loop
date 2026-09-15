#!/bin/bash
# Extract loop session logs for LLM agent debugging.
#
# Usage:
#   extract-session.sh [session-file | session-id-prefix]
#
#   If no argument: uses the most recent loop-go-bak session.
#   If argument is a file path: uses that file.
#   If argument is a UUID prefix (e.g. "01a0a668"): finds the matching session.
#
# Output: structured text, one entry per line, sorted by timestamp.
# Designed for an LLM agent to read — not a human-friendly report.
#
# Sections:
#   [STATE]    loop-state entries (phase, round, turns, disputes)
#   [DEBUG]    loop-debug entries (event trace)
#   [NEGOTIATE] loop-negotiate entries (proposals, feedback, agree)
#   [DISPUTE]  loop-dispute entries (filed, conceded, resolved)
#   [REFUSAL]  loop-refusal entries (blocked tool calls)
#   [MSG]      assistant messages (text + tool calls)
#   [TOOL]     tool results (truncated to 200 chars)
#   [USER]     user messages
#   [CUSTOM]   other custom entries

SESSION_DIR="$HOME/.pi/agent/sessions/--Users-alancapps-.pi-agent-extensions-loop-go-bak--"

if [ -n "$1" ]; then
  if [ -f "$1" ]; then
    SESSION_FILE="$1"
  else
    # Treat as UUID prefix
    SESSION_FILE=$(ls "$SESSION_DIR"/*"$1"*.jsonl 2>/dev/null | head -1)
  fi
else
  SESSION_FILE=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
fi

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
  echo "ERROR: No session file found."
  echo "Usage: $0 [session-file | session-id-prefix]"
  echo "Latest sessions:"
  ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -5 | while read f; do echo "  $(basename "$f")"; done
  exit 1
fi

echo "SESSION: $(basename "$SESSION_FILE")"
echo "PATH: $SESSION_FILE"
echo ""

python3 -c "
import sys, json

with open('$SESSION_FILE') as f:
    lines = f.readlines()

entries = []
for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except:
        continue

    t = obj.get('type', '')
    ts = obj.get('timestamp', '')

    # --- Custom entries (loop-state, loop-debug, etc.) ---
    if t == 'custom':
        ctype = obj.get('customType', '')
        data = obj.get('data', {})
        if ctype == 'loop-state':
            phase = data.get('phase', '?')
            round = data.get('round', '?')
            turns = data.get('turnsThisPhase', '?')
            dispute = data.get('dispute', {})
            dstat = dispute.get('status', 'none') if isinstance(dispute, dict) else 'none'
            entries.append((ts, f'[STATE] phase={phase} round={round} turns={turns} dispute={dstat}'))
        elif ctype == 'loop-debug':
            msg = data.get('msg', '')
            entries.append((ts, f'[DEBUG] {msg}'))
        elif ctype == 'loop-negotiate':
            action = data.get('action', '?')
            text = data.get('text', '')[:150]
            entries.append((ts, f'[NEGOTIATE] {action}: {text}'))
        elif ctype == 'loop-dispute':
            action = data.get('action', '?')
            claim = data.get('claim', '')[:100]
            count = data.get('disputeCount', '?')
            entries.append((ts, f'[DISPUTE] #{count} {action}: {claim}'))
        elif ctype == 'loop-refusal':
            phase = data.get('phase', '?')
            path = data.get('path', '?')
            reason = data.get('reason', '')[:100]
            entries.append((ts, f'[REFUSAL] {phase}: blocked {path} — {reason}'))
        elif ctype == 'loop-spec-patch':
            entries.append((ts, f'[PATCH] {json.dumps(data)[:150]}'))
        else:
            entries.append((ts, f'[CUSTOM/{ctype}] {json.dumps(data)[:150]}'))

    # --- Messages ---
    elif t == 'message':
        msg = obj.get('message', {})
        role = msg.get('role', '?')
        content = msg.get('content', [])

        if role == 'assistant':
            parts = []
            for c in content:
                ctype = c.get('type', '')
                if ctype == 'text':
                    text = c.get('text', '').strip()
                    if text:
                        parts.append(f'[MSG] {text[:300]}')
                elif ctype == 'toolCall':
                    name = c.get('name', '?')
                    args = json.dumps(c.get('arguments', {}))[:200]
                    parts.append(f'[TOOLCALL] {name}({args})')
            for p in parts:
                entries.append((ts, p))

        elif role == 'toolResult':
            tool_name = msg.get('toolName', '?')
            content_parts = msg.get('content', [])
            text = ''
            for c in content_parts:
                if isinstance(c, dict) and c.get('type') == 'text':
                    text = c.get('text', '')
            is_error = msg.get('isError', False)
            prefix = '[TOOLERR]' if is_error else '[TOOL]'
            entries.append((ts, f'{prefix} {tool_name}: {text[:200]}'))

        elif role == 'user':
            parts = []
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'text':
                    parts.append(c.get('text', '')[:200])
            for p in parts:
                entries.append((ts, f'[USER] {p}'))

    # --- Compaction ---
    elif t == 'compaction':
        entries.append((ts, '[COMPACTION] context compacted'))

entries.sort(key=lambda x: x[0])
for ts, text in entries:
    print(f'{ts} {text}')
"

echo ""
echo "═══════════════════════════════════"
echo "SUMMARY"
echo "═══════════════════════════════════"

python3 -c "
import sys, json
from collections import Counter

with open('$SESSION_FILE') as f:
    lines = f.readlines()

counts = Counter()
for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except:
        continue
    t = obj.get('type', '')
    if t == 'custom':
        ctype = obj.get('customType', '')
        counts[ctype] += 1
    elif t == 'message':
        role = obj.get('message', {}).get('role', '?')
        counts[f'msg/{role}'] += 1
    elif t == 'compaction':
        counts['compaction'] += 1

for cat, count in counts.most_common():
    print(f'  {cat}: {count}')
"
