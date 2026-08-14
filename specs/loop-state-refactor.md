# LoopState Refactoring

## Overview

`LoopState` is a 30+ field mutable bag that every module reads and writes. It couples every module together and makes it impossible to reason about what each module needs vs. what it mutates.

**Spec is the target state.** Current implementation is in `src/types.ts` (LoopState interface) and consumed by all modules.

## Current State

```typescript
interface LoopState {
  phase: Phase;                    // every module reads
  round: number;                   // transitions writes, commands reads
  specPath: string;                // every module reads
  language: LanguageKey;           // every module reads
  buildTool: BuildTool;            // gates reads, commands writes
  maxA: number;                    // transitions reads, commands writes (initial)
  maxNegotiate: number;            // transitions reads, commands writes (initial)
  maxB: number;                    // transitions reads, commands writes (initial)
  maxC: number;                    // transitions reads, commands writes (initial)
  maxDispute: number;              // tools reads
  maxTurnsPerPhase: number;        // events reads
  coverageThreshold: number;       // gates reads, commands writes
  disputeMode: boolean;            // tools writes, events reads/writes
  disputeCount: number;            // tools writes
  turnsThisPhase: number;          // events writes, transitions reads
  lastProposal: string;            // tools writes, events reads
  lastPhase: Phase;                // transitions writes, commands reads
  justTransitioned: boolean;       // transitions writes, events reads/writes
  negotiateReprompted: boolean;    // transitions writes, events reads
  awaitDisputeFix: boolean;        // tools writes, events reads/writes
  awaitDisputeReview: boolean;     // tools writes, events reads
  lastGateResult?: GateResult;     // events writes, selectors reads
  specFindings?: Finding[];        // commands writes, events reads
  awaitingReview?: boolean;        // commands writes, events reads
  skipPhase0?: boolean;            // commands writes, unused
}
```

**30+ fields, read by every module, mutated by every module.**

## Problems

| Problem | Impact |
|---|---|
| Every module can mutate any field | Hard to reason about who changes what |
| `skipPhase0` is set but never read | Dead state |
| Transient flags (`justTransitioned`, `negotiateReprompted`) mixed with persistent state | State restoration on reload must clear transients manually |
| No validation — invalid state can exist (e.g., `phase: "done"` with `round: 5`) | Silent bugs |
| Testing requires creating the full 30-field object | `makeState()` helpers are 20+ lines each |

## Target Architecture

### Split into focused sub-structures

```typescript
// src/types.ts — After

interface LoopState {
  // Identity — set once, never changes
  identity: LoopIdentity;
  
  // Phase machine — transitions writes, events reads
  machine: PhaseMachine;
  
  // Negotiation — tools writes, events reads
  negotiation: NegotiationState;
  
  // Dispute — tools writes, events reads/writes
  dispute: DisputeState;
  
  // Gate results — events writes, selectors reads
  gates: GateState;
  
  // Phase 0 — commands writes, events reads
  phase0: PhaseZeroState;
}

interface LoopIdentity {
  specPath: string;
  language: LanguageKey;
  buildTool: BuildTool;
  coverageThreshold: number;
}

interface PhaseMachine {
  phase: Phase;
  round: number;
  lastPhase: Phase;
  turnsThisPhase: number;
  maxA: number;
  maxNegotiate: number;
  maxB: number;
  maxC: number;
  // Transient — cleared on session restore
  justTransitioned: boolean;
  negotiateReprompted: boolean;
}

interface NegotiationState {
  lastProposal: string;
}

interface DisputeState {
  mode: boolean;
  count: number;
  max: number;
  awaitFix: boolean;
  awaitReview: boolean;
}

interface GateState {
  lastResult?: GateResult;
}

interface PhaseZeroState {
  findings?: Finding[];
  awaitingReview: boolean;
}
```

### Module-specific access patterns

Each module accesses only the sub-structures it needs:

| Module | Reads | Writes |
|---|---|---|
| transitions.ts | identity, machine | machine |
| gates.ts | identity, machine | (none — returns GateResult) |
| tools.ts | identity, negotiation, dispute | negotiation, dispute |
| commands.ts | identity, machine, phase0 | identity, machine, phase0 |
| events.ts | all | machine, dispute, gates, phase0 |
| selectors.ts | machine, gates | (none) |

### State factory with validation

```typescript
function createInitialState(specPath: string, language: LanguageKey, buildTool: BuildTool, coverage?: number): LoopState {
  return {
    identity: { specPath, language, buildTool, coverageThreshold: coverage ?? 80 },
    machine: { phase: "A" as Phase, round: 1, lastPhase: "A" as Phase, turnsThisPhase: 1,
               maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3,
               justTransitioned: false, negotiateReprompted: false },
    negotiation: { lastProposal: "" },
    dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
    gates: {},
    phase0: { awaitingReview: false },
  };
}

function validateState(state: LoopState): string[] {
  const errors: string[] = [];
  if (state.machine.phase === "done" && state.machine.round > 0) {
    errors.push("done phase should have round 0");
  }
  return errors;
}
```

### Transient flag clearing on session restore

```typescript
// events/session-start.ts
function clearTransientFlags(state: LoopState): void {
  state.machine.justTransitioned = false;
  state.machine.negotiateReprompted = false;
  state.dispute.mode = false;
  state.dispute.awaitFix = false;
  state.dispute.awaitReview = false;
}
```

## Test Strategy

### Smaller makeState helpers

```typescript
function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    ...createInitialState("spec.md", "go", "maven"),
    ...overrides,
  };
}

// Tests can now override sub-structures cleanly:
const state = makeState({
  machine: { ...defaultMachine, phase: "B", round: 3 },
  dispute: { ...defaultDispute, mode: true },
});
```

### State validation tests

```typescript
describe("validateState", () => {
  it("rejects done phase with non-zero round", () => {
    const state = makeState({ machine: { ...defaultMachine, phase: "done", round: 5 } });
    expect(validateState(state)).toContain("done phase should have round 0");
  });
});
```

## Acceptance Criteria

- [ ] LoopState split into 6 sub-structures (identity, machine, negotiation, dispute, gates, phase0)
- [ ] State factory with validation
- [ ] Each module accesses only its needed sub-structures
- [ ] `skipPhase0` removed (dead state)
- [ ] Transient flag clearing is explicit, not ad-hoc
- [ ] All existing tests pass with updated `makeState` helpers
- [ ] No behavioral changes — this is a refactor only

## Risks

- **High**: This changes the shape of state everywhere. Every module needs updates.
- **Migration**: Do this incrementally — split into sub-structures first, then update modules one at a time.
- **Breaking tests**: All `makeState` helpers need updates. Plan for batch test updates.

## Migration Plan

1. **Phase 1**: Add sub-structures alongside flat fields (dual-state)
2. **Phase 1**: Update transitions.ts to use sub-structures
3. **Phase 2**: Update tools.ts to use sub-structures
4. **Phase 3**: Update commands.ts and events.ts
5. **Phase 4**: Remove flat fields, keep only sub-structures
6. **Phase 4**: Add validation tests
