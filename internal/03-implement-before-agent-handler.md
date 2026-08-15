# Implement before_agent_start prompt injection handler

## Problem

`src/events/before-agent.ts` has a stub (`handleBeforeAgent` returns `undefined`). The real logic lives in `src/events.ts` as `buildPhasePrompt()` and its helpers (`buildReviewPrompt`, `buildTesterPrompt`, `buildNegotiatePrompt`, `buildWriterPrompt`, `buildCleanerPrompt`, `buildDisputeFixPrompt`, `buildContextMessage`).

## Target

Migrate all phase-specific prompt building into `src/events/before-agent.ts`. The module receives the current phase and returns the appropriate prompt injection.

## Interface

```typescript
// before-agent.ts
export function handleBeforeAgent(input: {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  systemPrompt: string;
}): { message: Record<string, unknown>; systemPrompt: string } | undefined;
```

## Behavior (from events.ts eventBeforeAgentStart / buildPhasePrompt)

1. If phase is `"idle"` → return undefined
2. Switch on `state.current.phase`:
   - `"review"` → Reviewer prompt (read spec, find ambiguities, no file writes)
   - `"A"` → Tester prompt (write test files and source stubs)
   - `"negotiate"` → If odd round → Writer propose prompt; even round → Tester review prompt
   - `"B"` → If `awaitDisputeFix` → Tester dispute fix prompt; else → Writer implement prompt
   - `"C"` → Cleaner refactor prompt
3. Each prompt includes a `buildContextMessage` and augmented `systemPrompt`

## Changes

1. Implement `handleBeforeAgent` with the full switch/case prompt logic
2. Move helpers into `before-agent.ts`: `buildReviewPrompt`, `buildTesterPrompt`, `buildNegotiatePrompt`, `buildWriterPrompt`, `buildCleanerPrompt`, `buildDisputeFixPrompt`, `buildContextMessage`
3. Replace `eventBeforeAgentStart` in `events.ts` to delegate
4. Remove helpers from `events.ts`

## Acceptance Criteria

- [ ] Each phase returns the correct prompt injection
- [ ] Negotiate phase alternates Writer/Tester based on round parity
- [ ] Phase B dispute fix overrides normal writer prompt
- [ ] `buildContextMessage` produces `{ customType: "loop-context", content, display: false }`
- [ ] All existing extension tests pass
- [ ] No behavioral change
