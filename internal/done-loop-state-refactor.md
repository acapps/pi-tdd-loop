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
  // NOTE: current code initializes lastPhase to "A" (commands.ts:111). The refactored
  // state factory uses null initially (Phase | null). This is safe because:
  // - commands.ts:234 reads lastPhase only on resume from escalated (lastPhase is always
  //   set by transitions.ts before escalation)
  // - All other readers (commands.ts:283, tools.ts:139/273, events.ts:376) only write it
  // - The null value represents "no prior phase" which is semantically correct
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
  // Identity — set during initialization, may be updated on continue
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
  buildTool: BuildTool;    // NOTE: current code casts as "maven" | "gradle" (excludes "go")
  coverageThreshold: number;
}

interface PhaseMachine {
  phase: Phase;
  round: number;
  lastPhase: Phase | null;        // null initially, set after first phase transition
  turnsThisPhase: number;
  maxA: number;
  maxNegotiate: number;
  maxB: number;
  maxC: number;
  maxTurnsPerPhase: number;    // escalation threshold — read by events dispatcher
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
  max: number;    // was maxDispute at top level — tools.ts:118 reads this
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

// skipPhase0 is only set (commands.ts:116), never read. It is dead code and
// removed from the target architecture.
//
// PhaseZeroThresholds (types.ts) is NOT part of LoopState. It is passed as
// an argument to shouldActivatePhase0() in reviewer.ts and stays external to state.
```

### State validation — where it runs

`validateState()` is called at these boundaries:
1. **After createInitialState** — ensures initial state is valid
2. **After applySubStructures** — ensures mutations preserved invariants
3. **After session restore** — ensures persisted state survived correctly
4. **At module boundaries** (optional, debug mode) — catches cross-module inconsistencies

In production, violations are logged as warnings but not thrown (defensive).
In tests, violations throw immediately.

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
    machine: { phase: "A" as Phase, round: 1, lastPhase: null,
               turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3,
               maxTurnsPerPhase: 5,
               justTransitioned: false, negotiateReprompted: false },
    negotiation: { lastProposal: "" },
    dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
    gates: {},
    phase0: { awaitingReview: false },
  };
}

// Validation rules:
//   1. done phase ⇒ round must be 0, turnsThisPhase must be 0
//   2. escalated phase ⇒ lastPhase must be B or C (can only escalate from active phases)
//   3. dispute mode on ⇒ disputeCount must be > 0
//      (dispute flow: tools.ts sets mode=true first, then increments count;
//       validation should not enforce this invariant during the transition between
//       setting mode and incrementing count — skip this rule in validateState)
//   4. round must be ≥ 1 for all non-done phases
//   5. turnsThisPhase must be ≥ 1 for all non-done phases
function validateState(state: LoopState): string[] {
  const errors: string[] = [];
  if (state.machine.phase === "done" && state.machine.round > 0) {
    errors.push("done phase should have round 0");
  }
  if (state.machine.phase === "done" && state.machine.turnsThisPhase > 0) {
    errors.push("done phase should have turnsThisPhase 0");
  }
  if (state.machine.phase === "escalated" &&
      (!state.machine.lastPhase || !["B", "C"].includes(state.machine.lastPhase))) {
    errors.push("escalated phase must come from B or C");
  }
  // NOTE: dispute.mode + dispute.count == 0 is NOT an error — the dispute flow sets
  // mode=true first (tools.ts:304), then increments count. The invariant is violated
  // transiently between those two operations.
  if (state.machine.phase !== "done" && state.machine.round < 1) {
    errors.push("non-done phase must have round >= 1");
  }
  if (state.machine.phase !== "done" && state.machine.turnsThisPhase < 1) {
    errors.push("non-done phase must have turnsThisPhase >= 1");
  }
  return errors;
}
```

### Transient flag clearing on session restore

```typescript
// events/session-start.ts
// Transient flags are ephemeral session state. They represent the *current*
// interaction flow (e.g., "did we just transition?", "is the dispute tool awaiting
// a response?"). They are NOT persistent user preferences.
//
// dispute.mode is cleared here because it reflects the active dispute state
// (awaiting a human response). Evidence: tools.ts:304 sets mode=true on dispute
// invocation, transitions.ts:243 clears it on phase advance, commands.ts:73 and
// commands.ts:333 clear it on reset/cancel. It is always session-scoped.
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

  it("rejects escalated phase without B or C as lastPhase", () => {
    const state = makeState({ machine: { ...defaultMachine, phase: "escalated", lastPhase: "A" } });
    expect(validateState(state)).toContain("escalated phase must come from B or C");
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

### Dual-state consistency (Phase 1-5)

During the transition from flat fields to sub-structures, both representations exist
simultaneously. **The flat fields are the source of truth** during migration. The
sub-structures are derived views that are populated from flat fields via a
`toSubStructures(state)` helper and written back via `applySubStructures(state, subStructures)`.

```typescript
// Migration helper — populates sub-structures from flat fields
function toSubStructures(state: LoopState): LoopSubStructures {
  return {
    identity: { specPath: state.specPath, language: state.language,
                buildTool: state.buildTool, coverageThreshold: state.coverageThreshold },
    machine: { phase: state.phase, round: state.round, lastPhase: state.lastPhase,
               turnsThisPhase: state.turnsThisPhase, maxA: state.maxA,
               maxNegotiate: state.maxNegotiate, maxB: state.maxB, maxC: state.maxC,
               maxTurnsPerPhase: state.maxTurnsPerPhase,
               justTransitioned: state.justTransitioned,
               negotiateReprompted: state.negotiateReprompted },
    // ... etc
  };
}

// Migration helper — writes sub-structures back to flat fields
function applySubStructures(state: LoopState, ss: LoopSubStructures): void {
  state.phase = ss.machine.phase;
  state.round = ss.machine.round;
  // ... etc
}
```

Each module is updated incrementally:
1. Add the sub-structure types alongside the flat fields
2. Update one module to use sub-structures internally
3. At module boundaries, convert via `toSubStructures` / `applySubStructures`
4. **applySubStructures is called immediately after any mutation** to keep flat fields
   in sync. The flat fields are source of truth — if a module mutates sub-structures,
   it must call applySubStructures before returning.
5. When all modules use sub-structures, remove flat fields

### Steps

1. **Phase 1**: Add sub-structure types and migration helpers (`toSubStructures`, `applySubStructures`)
2. **Phase 2**: Update transitions.ts to use sub-structures internally, convert at boundaries
3. **Phase 3**: Update tools.ts to use sub-structures internally, convert at boundaries
4. **Phase 4**: Update commands.ts and events.ts to use sub-structures, convert at boundaries
5. **Phase 5**: Remove flat fields, migration helpers, and boundary conversions
6. **Phase 6**: Add validation tests and validateState unit tests
