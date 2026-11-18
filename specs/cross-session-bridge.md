# cross-session-bridge

Watch a pi-tdd-loop session for Phase 0 reviewer feedback, push it to a design session, and loop back when the spec file changes.

## Problem

Working on a feature with two Pi sessions:
- **Session A** (design session, local LLM) writes the spec with full project context
- **Session B** (pi-tdd-loop) runs `/loop <spec>` and the Tester finds spec issues in Phase 0

The feedback loop is manual: copy Tester findings → paste into Session A → Session A updates the spec file → tell Session B "spec updated" → `/loop-patch`. This repeats for a few rounds.

The extension already supports the receiving end (`/loop-patch <spec>` re-reads the spec, resets the round). What's missing is automation of pushing feedback out and detecting spec updates coming back.

Target: a thin bridge extension (~50 lines) that watches, pushes, and triggers — no new pi-tdd-loop features required.

## Target

A Pi extension installed alongside pi-tdd-loop that:

1. **Captures Phase 0 feedback** from the loop session (session B) — the reviewer's findings from `handleAgentSettled` → Phase 0 review
2. **Pushes findings to the design session** (session A) via the Pi event system or file watch
3. **Detects spec file changes** (the design session writes to the spec file)
4. **Triggers `/loop-patch <spec>`** in the loop session automatically, closing the round

The bridge is local (`~/.pi/agent/extensions/`), not a feature of pi-tdd-loop itself. It assumes both sessions share the same filesystem (same spec file path).

## Interface

```typescript
// Bridge API (command-driven, not always-on)
/bridge-start <sessionA-id> <spec-path>
/bridge-stop
/bridge-status
```

No persistent state. No config file. Commands are scoped to a single bridge session.

The bridge attaches to the current Pi session (loop session B) and:
- Listens for Phase 0 review output
- Watches `<spec-path>` for filesystem changes
- Communicates with session A via Pi's session messaging API (`session_send_message`) or stdout/file if cross-session messaging isn't available

## Behavior

**Phase 0 feedback capture:**
- Bridge monitors the loop session for Phase 0 review findings
- Findings are the reviewer output: ambiguities, missing edge cases, underspecified behavior
- When Phase 0 findings appear, bridge captures them as a structured message

**Push to design session:**
- Bridge sends captured findings to session A via `session_send_message` (if pi-sessions is available)
- Fallback: writes findings to `<spec-path>.bridge-findings.md` (design session watches this file or user reads it)
- Bridge waits for ack (spec file modified or findings file acknowledged)

**Spec change detection:**
- Bridge watches `<spec-path>` via `fs.watch` for modifications
- On change: validates file is readable, triggers `/loop-patch <spec-path>` in the current session
- Cooldown: 2 seconds between detections to avoid re-triggering on atomic writes

**Cooldown & limits:**
- Max rounds: configurable default 3 (avoids infinite loops if design session keeps breaking)
- Per-round cooldown: 10 seconds between feedback push and next detection
- `/bridge-stop` hard-cancels all watches and listeners

**Error cases:**
- Session A not found / not responding: fallback to file-based findings, log warning
- Spec file not readable after change: log error, don't trigger patch, wait
- Bridge started outside a loop session: error, bridge requires active loop state

## Inventory

- `index.ts` — main extension entry point, registers commands + hooks
- `watcher.ts` — spec file watcher, triggers patch on change
- `capture.ts` — Phase 0 feedback extractor, reads loop debug/state entries
- `commands.ts` — `/bridge-start`, `/bridge-stop`, `/bridge-status` command handlers

No dependencies on pi-tdd-loop internals. Uses only Pi extension API (`pi.on`, `pi.appendEntry`) and Node `fs`.

## Test Strategy

- **Unit tests mock the Pi API:** `pi.on("agent_settled")`, `pi.appendEntry`, `session_send_message`
- **File watch is mocked:** no real `fs.watch` in unit tests
- **Integration scenario:** one test that simulates the full round (feedback captured → pushed → spec changed → patch triggered)
- **No real process spawns:** no Pi sessions, no file I/O beyond mocked paths

## Scope lines

- `index.ts`: added — extension entry, command registration
- `watcher.ts`: added — fs.watch wrapper with cooldown
- `capture.ts`: added — Phase 0 finding extractor
- `commands.ts`: added — bridge command handlers
- `package.json`: added — extension manifest
- `README.md`: added — usage docs
- All in `~/.pi/agent/extensions/cross-session-bridge/` (local, not in loop-go-bak repo)

## Acceptance Criteria

- Bridge captures Phase 0 findings and pushes them to session A (or writes fallback file)
- Spec file change triggers `/loop-patch` within 2 seconds
- Max 3 auto-rounds before bridge stops and escalates to user
- `/bridge-stop` cancels all watches and listeners
- Bridge works without pi-sessions installed (file fallback)
- Grep: no references to "pi-tdd-loop" internals (effect-applicator, gate-transition, etc.) — only Pi API surface
- Full test suite green, type-checker clean

## Dependencies

- Pi extension API (`@earendil-works/pi-coding-agent`) — peer dependency
- pi-tdd-loop — uses its spec file path + `/loop-patch` command, but reads no internals
- pi-sessions (`session_send_message`) — optional, graceful degradation without it

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
