# Extract effect-applicator into standalone module

## Problem

`src/events.ts` has `applyEffect()`, `handleRetryEffect()`, `handleAdvanceEffect()`, `handleDoneEffect()`, `handleEscalatedEffect()`, `buildRetryPrompt()`, and `buildAdvancePrompt()` — all inline with no isolation. `src/events/agent-settled/effect-applicator.ts` has stubs with `void x; return false` bodies.

## Target

Move all effect application logic into `src/events/agent-settled/effect-applicator.ts` as pure, testable functions. The gate-transition handler calls `applyEffect` from the module.

## Interface

```typescript
// effect-applicator.ts

export interface EffectInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
  effect: TransitionEffectType;
  gateResult: GateResult;
}

export function applyEffect(input: EffectInput): boolean;
export function applyRetryEffect(input: EffectInput): boolean;
export function applyAdvanceEffect(input: EffectInput): boolean;
export function applyDoneEffect(input: EffectInput): boolean;
export function applyEscalatedEffect(input: EffectInput): boolean;
```

## Behavior

### applyEffect (dispatcher)

Switch on `effect.type`:
- `"noop"` → return false
- `"retry"` → call `applyRetryEffect`
- `"advance"` → call `applyAdvanceEffect`
- `"done"` → call `applyDoneEffect`
- `"escalated"` → call `applyEscalatedEffect`

### applyRetryEffect

1. Reset `state.current.turnsThisPhase = 1`
2. If `awaitDisputeReview`: clear flag, send dispute prompt, return true
3. Set UI status, send retry notification
4. Build prompt via `buildRetryPrompt(effect.prompt, lang, gateResult)` and send to agent

### applyAdvanceEffect

1. Reset `state.current.turnsThisPhase = 1`
2. Set UI status and notify
3. Build prompt via `buildAdvancePrompt(effect.prompt, state, lang)` and send to agent

### applyDoneEffect

1. Reset `state.current.turnsThisPhase = 1`
2. Notify and set status. Loop is complete.

### applyEscalatedEffect

1. Notify (warning level) and set status. Human escalation.

### buildRetryPrompt (prompt builder)

Maps `effect.prompt` key to language-specific prompt:
- `tester_compile_retry` → `lang.prompts.promptTesterCompileRetry(compileError)`
- `writer_phase_b_retry` → `lang.prompts.promptWriterPhaseBContinue(summary, count)`
- `cleaner_retry` → `lang.prompts.promptCleanerRetry(summary, count)`
- `writer_dispute_fix_incomplete` → `lang.prompts.promptWriterPhaseBContinue(summary, count)`
- `tester_dispute_fix_compile_fail` → `lang.prompts.promptTesterCompileRetry(compileError)`

### buildAdvancePrompt (prompt builder)

- `writer_negotiate` → `GP.promptWriterNegotiate(specPath, testFilePattern)`
- `cleaner_phase_c` → `lang.prompts.promptCleanerPhaseC()`

## Changes

1. Implement all effect functions in `effect-applicator.ts`
2. Move `buildRetryPrompt` and `buildAdvancePrompt` into `effect-applicator.ts`
3. Update `gate-transition.ts` to import and call `applyEffect` from the module
4. Remove effect functions from `events.ts`

## Acceptance Criteria

- [ ] `applyEffect` dispatches to correct handler per effect type
- [ ] `applyRetryEffect` resets turns, handles dispute review path, builds correct prompt
- [ ] `applyAdvanceEffect` resets turns, builds correct advance prompt
- [ ] `applyDoneEffect` notifies and completes
- [ ] `applyEscalatedEffect` notifies at warning level
- [ ] `buildRetryPrompt` maps all 5 prompt keys to correct language prompts
- [ ] `buildAdvancePrompt` maps both advance keys correctly
- [ ] All existing extension tests pass
- [ ] No behavioral change

## Dependencies

This spec depends on #4 (agent_settled handlers) being complete, since `gate-transition.ts` will call `applyEffect` from this module.
