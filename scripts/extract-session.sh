#!/bin/bash
# Extract loop logs from a session file
# Usage: extract-session.sh [session-file]
#   If no file given, uses the most recent loop-go-bak session

SESSION_DIR="$HOME/.pi/agent/sessions/--Users-alancapps-.pi-agent-extensions-loop-go-bak--"

if [ -n "$1" ]; then
  SESSION_FILE="$1"
else
  SESSION_FILE=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
fi

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
  echo "No session file found."
  echo "Usage: $0 [session-file]"
  echo "  Latest sessions:"
  ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -5 | while read f; do echo "  $f"; done
  exit 1
fi

echo "═══════════════════════════════════"
echo "Session: $(basename "$SESSION_FILE")"
echo "═══════════════════════════════════"
echo ""

# Extract all custom events, sorted by timestamp
grep '"customType":' "$SESSION_FILE" | python3 -c "
import sys, json

for line in sys.stdin:
    try:
        d = json.loads(line)
        ctype = d.get('customType', '')
        data = d.get('data', {})
        ts = d.get('timestamp', '')
        
        if ctype == 'loop-debug':
            msg = data.get('msg', '')
            # Check if it's a behavioral event (has category)
            if 'category' in data:
                cat = data['category']
                print(f'[{ts}] [BEHAVIORAL/{cat}] {msg}')
            else:
                print(f'[{ts}] [debug] {msg}')
        elif ctype == 'loop-event':
            cat = data.get('category', '')
            msg = data.get('msg', '')
            print(f'[{ts}] [EVENT/{cat}] {msg}')
        elif ctype == 'loop-state':
            phase = data.get('phase', '')
            round = data.get('round', '')
            print(f'[{ts}] [state] phase={phase} round={round}')
        elif ctype == 'loop-refusal':
            phase = data.get('phase', '')
            path = data.get('path', '')
            print(f'[{ts}] [refusal] {phase}: blocked write to {path}')
        elif ctype == 'loop-dispute':
            action = data.get('action', '')
            claim = data.get('claim', '')
            disputeCount = data.get('disputeCount', '')
            if action:
                print(f'[{ts}] [dispute] #{disputeCount}: {action}')
            elif claim:
                print(f'[{ts}] [dispute] #{disputeCount}: {claim[:80]}')
            else:
                print(f'[{ts}] [dispute] {json.dumps(data)}')
        elif ctype == 'loop-negotiate':
            action = data.get('action', '')
            text = data.get('text', '')
            print(f'[{ts}] [negotiate] {action}: {text[:80]}')
        else:
            print(f'[{ts}] [{ctype}] {json.dumps(data)[:100]}')
    except:
        pass
" | sort

echo ""
echo "═══════════════════════════════════"
echo "Summary"
echo "═══════════════════════════════════"

# Count by category
grep '"customType":' "$SESSION_FILE" | python3 -c "
import sys, json
from collections import Counter

counts = Counter()
for line in sys.stdin:
    try:
        d = json.loads(line)
        ctype = d.get('customType', '')
        data = d.get('data', {})
        if 'category' in data:
            counts[f'event/{data[\"category\"]}'] += 1
        else:
            counts[ctype] += 1
    except:
        pass

for cat, count in counts.most_common():
    print(f'  {cat}: {count}')
"
