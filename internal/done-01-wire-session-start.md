# Wire session_start handler into extension entry point

## Problem

`src/events/session-start.ts` already has a complete implementation (`handleSessionStart`). `src/events.ts` still exports `eventSessionStart` as a standalone function. The module is not wired into the extension's event registration.

## Target

Wire `handleSessionStart` from the module into the extension so the monolith delegates to it. No behavioral change.

## Interface

```typescript
// session-start.ts (already implemented)
export function handleSessionStart(input: {
  state: { current: LoopState };
  ctx: EventCtx;
  debug: (msg: string) => void;
}): void;
```

## Changes

1. In `src/events.ts`, replace `eventSessionStart` body to call `handleSessionStart` from `./events/session-start`
2. Remove duplicate helpers (`restoreState`, `findLastLoopState`, `clearTransientFlags`) from `events.ts` once wired
3. Extension command registration unchanged (still calls `eventSessionStart`, which delegates)

## Acceptance Criteria

- [ ] `eventSessionStart` delegates to `handleSessionStart`
- [ ] All existing tests pass
- [ ] No behavioral change in state restoration on reload
