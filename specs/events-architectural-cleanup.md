# Events Architectural Cleanup

## Overview

`src/events.ts` is the orchestrator that ties gates, transitions, prompts, and language configs together. Currently it has:
- 7-level deep call chains with no boundary contracts
- Event handlers tested only indirectly via extension.test.ts
- The `agent_settled` handler is 400+ lines with nested conditionals

**Spec is the target state.** Implementation lives under `src/events.ts`.

## Problems

| Problem | Impact |
|---|---|
| `handleGateTransition` → `runGates` → `computeTransition` → `applyEffect` → `handleRetryEffect` → `buildRetryPrompt` → `lang.prompts.*` | 7 levels deep, any prompt change ripples through everything |
| Event handlers tested only via extension.test.ts integration tests | No isolation testing, hard to diagnose failures |
| `agent_settled` handler is 400+ lines with multiple phases handled inline | Single function handles review, negotiate, A, B, C, dispute — violates SRP |
| No clear boundary between "gate execution" and "effect application" | Changes to gate logic require understanding prompt logic and vice versa |

## Target Architecture

### Phase handlers extracted into separate modules

```
src/
  events/
    index.ts              # re-exports, EventCtx type
    session-start.ts      # state restoration on reload
    before-agent.ts       # role-specific prompt injection
    tool-call.ts          # path enforcement (already split logically)
    agent-settled/
      index.ts            # dispatcher: routes to phase handler
      review.ts           # Phase 0: await human approve
      negotiate.ts        # Negotiate: reprompt / auto-advance
      gate-transition.ts  # A/B/C: run gates, apply effect
      dispute.ts          # dispute fix/review handling
      effect-applicator.ts # apply retry/advance/done/escalated effects
```

### Each module has a clear interface

```typescript
// agent-settled/gate-transition.ts
interface GateHandlerInput {
  state: LoopState;
  ctx: EventCtx;
  lang: LanguageConfig;
}

interface GateHandlerOutput {
  state: LoopState;
  effect: TransitionEffect;
  prompt?: string;
}

export function handleGateTransition(input: GateHandlerInput): GateHandlerOutput;
```

### Effect application extracted

The `applyEffect` function (retry, advance, done, escalated) is extracted into `effect-applicator.ts` with its own test suite. Currently it's inline in events.ts with no isolation.

## Test Strategy

### Each module gets direct unit tests

```typescript
// agent-settled/gate-transition.test.ts
describe("handleGateTransition", () => {
  it("runs gates and returns retry effect on failure", () => { ... });
  it("runs gates and returns advance effect on pass", () => { ... });
});

// agent-settled/effect-applicator.test.ts
describe("applyRetryEffect", () => {
  it("resets turnsThisPhase to 1", () => { ... });
  it("sends compile retry prompt on compile fail", () => { ... });
  it("sends test retry prompt on test fail", () => { ... });
});
```

### Extension integration tests remain but with smaller scope

The `extension.test.ts` tests remain as the "glue" tests that verify the full pipeline. But the individual modules can be tested in isolation.

## Acceptance Criteria

- [ ] `events.ts` reduced to < 100 lines (dispatcher only)
- [ ] Each phase handler is a separate module with < 100 lines
- [ ] Each module has its own test file with direct unit tests
- [ ] `applyEffect` extracted into `effect-applicator.ts` with its own tests
- [ ] Extension integration tests still pass (394+ tests)
- [ ] No behavioral changes — this is a refactor only

## Risks

- **Regression risk**: Splitting a 400-line function is high-risk. Need full test coverage before starting.
- **Import complexity**: The events modules import from many sources. Need to ensure circular dependencies don't arise.
- **Migration path**: Do this incrementally — extract one handler at a time, verify tests pass, then move to next.

## Migration Plan

1. **Week 1**: Extract `effect-applicator.ts` (retry/advance/done/escalated effects) — highest impact, clearest boundary
2. **Week 1**: Write direct unit tests for effect-applicator
3. **Week 2**: Extract `gate-transition.ts` (runGates + computeTransition + applyEffect)
4. **Week 2**: Write direct unit tests for gate-transition
5. **Week 3**: Extract `negotiate.ts` and `review.ts` handlers
6. **Week 3**: Verify all extension integration tests still pass
