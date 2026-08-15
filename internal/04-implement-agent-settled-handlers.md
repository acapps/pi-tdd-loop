# Implement agent_settled sub-handlers (dispute, review, negotiate, gate-transition)

## Problem

`src/events.ts` exports `eventAgentSettled()` with inline dispatch to phase-specific handlers. The `src/events/agent-settled/` directory has stub modules for each handler. The working code is all in the monolith: `handleReviewSettled`, `handleNegotiateSettled`, `handleGateTransition`, `handleDisputeFix`, `handleDisputeReview`, `handleJustTransitioned`, `checkLoopEscalation`, `isTerminalPhase`.

## Target

Implement each sub-handler in `src/events/agent-settled/` and wire the dispatcher in `agent-settled/index.ts`. The dispatcher routes based on phase and state flags, matching the monolith's dispatch order.

## Dispatcher Order (from events.ts eventAgentSettled)

```
1. isTerminalPhase → return undefined
2. checkLoopEscalation → escalate if turns exceeded
3. handleJustTransitioned → clear flag, trigger Phase B turn
4. handleDisputeFix → trigger Tester dispute fix turn
5. handleDisputeReview → fall through to gate
6. phase === "review" → handleReviewSettled
7. phase === "negotiate" → handleNegotiateSettled
8. else → handleGateTransition
```

## Sub-handler Signatures (already in stub files)

```typescript
// dispute.ts
export function handleDisputeFix(input: { state, pi, ctx, lang, debug }): { handled: boolean; type?: "fix" }
export function handleDisputeReview(input: { state, pi, ctx, lang, debug }): { handled: boolean; type?: "review" }

// review.ts
export function handleReviewSettled(input: { state, pi, ctx, lang, debug }): { handled: boolean }

// negotiate.ts
export function handleNegotiateSettled(input: { state, pi, ctx, lang, debug }): { handled: boolean; newState: LoopState }

// gate-transition.ts
export function handleGateTransition(input: { state, ctx, lang, debug }): { state: LoopState; effect; gateResult }
```

## Changes

1. Implement `handleDisputeFix` — checks `awaitDisputeFix`, sets UI status, sends tester dispute fix prompt
2. Implement `handleDisputeReview` — checks `awaitDisputeReview`, keeps flag blocking, sets UI status, returns false to fall through to gate
3. Implement `handleReviewSettled` — checks `awaitingReview`, notifies human, saves state
4. Implement `handleNegotiateSettled` — calls `T.computeNegotiateTransition`, applies reprompt or auto-advance
5. Implement `handleGateTransition` — calls `runGates`, `T.computeTransition`, then `applyEffect`
6. Implement dispatcher in `agent-settled/index.ts` with the 8-step dispatch order
7. Replace `eventAgentSettled` in `events.ts` to delegate to dispatcher
8. Remove all inline handlers from `events.ts`

## Acceptance Criteria

- [ ] Dispatcher routes to correct handler per phase/flag
- [ ] `handleDisputeFix` triggers Tester dispute fix turn with correct prompt
- [ ] `handleDisputeReview` blocks tool calls and falls through to gate
- [ ] `handleReviewSettled` waits for human approval
- [ ] `handleNegotiateSettled` reprompts or auto-advances per `computeNegotiateTransition`
- [ ] `handleGateTransition` runs gates, computes effect, applies effect
- [ ] Loop escalation triggers when turns exceeded
- [ ] All existing extension tests pass
- [ ] No behavioral change

## Note

This spec intentionally keeps `applyEffect` inline in `gate-transition.ts` for now. The effect-applicator is extracted in a separate spec (#5) to keep this unit smaller.
