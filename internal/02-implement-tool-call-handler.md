# Implement tool_call path enforcement handler

## Problem

`src/events/tool-call.ts` has a stub (`handleToolCall` returns `undefined`). The real logic lives in `src/events.ts` as `eventToolCall()` and its helpers (`shouldBlockDispute`, `shouldBlockNegotiate`, `shouldBlockPhaseA`, `checkPhaseBCWrite`, `isProjectPath`, `isWriteAction`, `extractToolPath`).

## Target

Migrate the path enforcement logic into `src/events/tool-call.ts`. The module takes a structured input object and returns a block decision or undefined.

## Interface

```typescript
// tool-call.ts
export function handleToolCall(input: {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  toolName: string;
  path: string;
  ctx: EventCtx;
}): { block: true; reason: string } | undefined;
```

## Behavior (from events.ts eventToolCall)

The handler checks in order and returns on first match:

1. If phase is `"escalated"` → return undefined (no enforcement)
2. If `state.awaitDisputeReview` → block: "Dispute filed. Waiting for Tester review."
3. If `state.disputeMode` and path is not a test file → block (lang.refusalMessage.phaseC)
4. If phase is `"negotiate"` and action is write → block (lang.refusalMessage.negotiate)
5. If phase is `"A"` and path is not in Phase A allowlist → block (lang.refusalMessage.phaseA)
6. If phase is B or C and path is a test file → block (lang.refusalMessage.phaseC)
7. Otherwise → undefined (allow)

## Changes

1. Implement `handleToolCall` in `src/events/tool-call.ts` using the logic above
2. Replace `eventToolCall` in `src/events.ts` to delegate to `handleToolCall`
3. Remove helpers from `events.ts`: `shouldBlockDispute`, `shouldBlockNegotiate`, `shouldBlockPhaseA`, `checkPhaseBCWrite`, `isProjectPath`, `isWriteAction`, `extractToolPath`

## Acceptance Criteria

- [ ] `handleToolCall` enforces all phase-specific write blocks
- [ ] Dispute mode blocks non-test-file writes
- [ ] Negotiate phase blocks all writes
- [ ] Phase A blocks writes outside allowlist
- [ ] Phase B/C blocks writes to test files
- [ ] All existing extension tests pass
- [ ] No behavioral change
