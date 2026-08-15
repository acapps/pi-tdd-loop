// Contract tests for makeState test helper
// internal/done-loop-state-refactor.md — Test Strategy: Smaller makeState helpers

import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/state-factory";
import { validateState } from "../src/state-validation";
import type { LanguageKey, BuildTool, Phase, GateResult, Finding } from "../src/types";
import type { LoopState, LoopIdentity, PhaseMachine, NegotiationState, DisputeState, GateState, PhaseZeroState } from "../src/state-types";

// --- Default sub-structure instances (for spreading in overrides) ---

export const defaultIdentity: LoopIdentity = {
  specPath: "spec.md",
  language: "go" as LanguageKey,
  buildTool: "maven" as BuildTool,
  coverageThreshold: 80,
};

export const defaultMachine: PhaseMachine = {
  phase: "A" as Phase,
  round: 1,
  lastPhase: null,
  turnsThisPhase: 1,
  maxA: 3,
  maxNegotiate: 3,
  maxB: 5,
  maxC: 3,
  maxTurnsPerPhase: 5,
  justTransitioned: false,
  negotiateReprompted: false,
};

export const defaultNegotiation: NegotiationState = {
  lastProposal: "",
};

export const defaultDispute: DisputeState = {
  mode: false,
  count: 0,
  max: 3,
  awaitFix: false,
  awaitReview: false,
};

export const defaultGates: GateState = {};

export const defaultPhase0: PhaseZeroState = {
  awaitingReview: false,
};

// --- makeState helper ---

/**
 * Creates a LoopState with defaults from createInitialState,
 * allowing partial sub-structure overrides.
 *
 * Usage:
 *   const state = makeState();                              // defaults
 *   const state = makeState({ machine: { ...defaultMachine, phase: "B" } });
 *   const state = makeState({ dispute: { ...defaultDispute, mode: true } });
 */
export function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    ...createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool),
    ...overrides,
  };
}

// ================================================================
// makeState — defaults
// ================================================================

describe("makeState", () => {
  it("returns valid initial state with no overrides", () => {
    const state = makeState();

    expect(state.identity.specPath).toBe("spec.md");
    expect(state.identity.language).toBe("go");
    expect(state.identity.buildTool).toBe("maven");
    expect(state.identity.coverageThreshold).toBe(80);
    expect(state.machine.phase).toBe("A");
    expect(state.machine.round).toBe(1);
    expect(state.negotiation.lastProposal).toBe("");
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.count).toBe(0);
    expect(state.gates.lastResult).toBeUndefined();
    expect(state.phase0.awaitingReview).toBe(false);
  });

  it("returns state that passes validation", () => {
    const state = makeState();
    const errors = validateState(state);
    expect(errors).toEqual([]);
  });
});

// ================================================================
// makeState — partial sub-structure overrides
// ================================================================

describe("makeState — sub-structure overrides", () => {
  it("overrides machine with spread syntax", () => {
    const state = makeState({
      machine: { ...defaultMachine, phase: "B", round: 3 },
    });

    expect(state.machine.phase).toBe("B");
    expect(state.machine.round).toBe(3);
    // Other machine fields preserved from defaultMachine
    expect(state.machine.maxA).toBe(3);
    expect(state.machine.maxB).toBe(5);
    expect(state.machine.maxC).toBe(3);
    expect(state.machine.turnsThisPhase).toBe(1);
  });

  it("overrides dispute with spread syntax", () => {
    const state = makeState({
      dispute: { ...defaultDispute, mode: true, count: 2 },
    });

    expect(state.dispute.mode).toBe(true);
    expect(state.dispute.count).toBe(2);
    expect(state.dispute.max).toBe(3); // preserved from defaultDispute
    expect(state.dispute.awaitFix).toBe(false);
  });

  it("overrides identity with spread syntax", () => {
    const state = makeState({
      identity: { ...defaultIdentity, language: "java", coverageThreshold: 95 },
    });

    expect(state.identity.language).toBe("java");
    expect(state.identity.coverageThreshold).toBe(95);
    expect(state.identity.specPath).toBe("spec.md"); // preserved
    expect(state.identity.buildTool).toBe("maven"); // preserved
  });

  it("overrides negotiation with spread syntax", () => {
    const state = makeState({
      negotiation: { ...defaultNegotiation, lastProposal: "Proposal text" },
    });

    expect(state.negotiation.lastProposal).toBe("Proposal text");
  });

  it("overrides gates with lastResult", () => {
    const gateResult: GateResult = {
      compile: true,
      compileError: "",
      tests: true,
      allPassed: true,
      coverage: 90,
      failures: [],
    };
    const state = makeState({
      gates: { ...defaultGates, lastResult: gateResult },
    });

    expect(state.gates.lastResult).toEqual(gateResult);
  });

  it("overrides phase0 with findings", () => {
    const findings: Finding[] = [{
      id: 1,
      category: "Ambiguous phrase",
      title: "Test",
      ambiguity: "Test",
      interpretations: [],
      recommendation: "Fix",
    }];
    const state = makeState({
      phase0: { ...defaultPhase0, findings, awaitingReview: true },
    });

    expect(state.phase0.findings).toEqual(findings);
    expect(state.phase0.awaitingReview).toBe(true);
  });
});

// ================================================================
// makeState — multiple overrides at once
// ================================================================

describe("makeState — multiple overrides", () => {
  it("overrides multiple sub-structures together", () => {
    const state = makeState({
      identity: { ...defaultIdentity, language: "typescript" },
      machine: { ...defaultMachine, phase: "C", round: 2, lastPhase: "B" },
      dispute: { ...defaultDispute, mode: true, count: 1 },
    });

    expect(state.identity.language).toBe("typescript");
    expect(state.machine.phase).toBe("C");
    expect(state.machine.round).toBe(2);
    expect(state.machine.lastPhase).toBe("B");
    expect(state.dispute.mode).toBe(true);
    expect(state.dispute.count).toBe(1);
  });

  it("overrides all 6 sub-structures", () => {
    const gateResult: GateResult = {
      compile: false,
      compileError: "err",
      tests: false,
      allPassed: false,
      coverage: 0,
      failures: [],
    };
    const state = makeState({
      identity: { ...defaultIdentity, specPath: "new.md" },
      machine: { ...defaultMachine, phase: "done", round: 0, turnsThisPhase: 0 },
      negotiation: { ...defaultNegotiation, lastProposal: "Final" },
      dispute: { ...defaultDispute, mode: false },
      gates: { ...defaultGates, lastResult: gateResult },
      phase0: { ...defaultPhase0, awaitingReview: true },
    });

    expect(state.identity.specPath).toBe("new.md");
    expect(state.machine.phase).toBe("done");
    expect(state.machine.round).toBe(0);
    expect(state.negotiation.lastProposal).toBe("Final");
    expect(state.dispute.mode).toBe(false);
    expect(state.gates.lastResult).toEqual(gateResult);
    expect(state.phase0.awaitingReview).toBe(true);
  });
});

// ================================================================
// makeState — convenience: creating common test states
// ================================================================

describe("makeState — common test states", () => {
  it("creates done state", () => {
    const state = makeState({
      machine: { ...defaultMachine, phase: "done", round: 0, turnsThisPhase: 0 },
    });
    expect(validateState(state)).toEqual([]);
  });

  it("creates escalated state from B", () => {
    const state = makeState({
      machine: { ...defaultMachine, phase: "escalated", lastPhase: "B" },
    });
    expect(validateState(state)).toEqual([]);
  });

  it("creates escalated state from C", () => {
    const state = makeState({
      machine: { ...defaultMachine, phase: "escalated", lastPhase: "C" },
    });
    expect(validateState(state)).toEqual([]);
  });

  it("creates Phase B state", () => {
    const state = makeState({
      machine: { ...defaultMachine, phase: "B", round: 2, lastPhase: "A", turnsThisPhase: 1, justTransitioned: true },
    });
    expect(state.machine.phase).toBe("B");
    expect(state.machine.justTransitioned).toBe(true);
  });

  it("creates dispute-active state", () => {
    const state = makeState({
      machine: { ...defaultMachine, phase: "B" },
      dispute: { ...defaultDispute, mode: true, count: 1, awaitFix: true },
    });
    expect(state.dispute.mode).toBe(true);
    expect(state.dispute.count).toBe(1);
    expect(state.dispute.awaitFix).toBe(true);
  });
});

// ================================================================
// makeState — edge cases
// ================================================================

describe("makeState — edge cases", () => {
  it("works with empty overrides object", () => {
    const state = makeState({});
    expect(state.machine.phase).toBe("A");
    expect(state.identity.specPath).toBe("spec.md");
  });

  it("works with undefined overrides", () => {
    const state = makeState(undefined);
    expect(state.machine.phase).toBe("A");
  });

  it("works with partial machine override (only phase)", () => {
    const state = makeState({
      machine: { ...defaultMachine, phase: "negotiate" },
    });
    expect(state.machine.phase).toBe("negotiate");
    // All other fields preserved
    expect(state.machine.round).toBe(1);
    expect(state.machine.maxA).toBe(3);
  });

  it("works with partial dispute override (only mode)", () => {
    const state = makeState({
      dispute: { ...defaultDispute, mode: true },
    });
    expect(state.dispute.mode).toBe(true);
    expect(state.dispute.count).toBe(0); // preserved
  });
});
