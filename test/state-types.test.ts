// Contract tests for LoopState sub-structure types
// Validates the type structure definitions from internal/done-loop-state-refactor.md

import { describe, it, expect } from "vitest";
import type {
  LoopState,
  LoopIdentity,
  PhaseMachine,
  NegotiationState,
  DisputeState,
  GateState,
  PhaseZeroState,
  LoopSubStructures,
} from "../src/state-types";
import type { Phase, LanguageKey, BuildTool, GateResult, Finding } from "../src/types";

// --- Helpers: construct valid instances for each sub-structure ---

function makeIdentity(overrides: Partial<LoopIdentity> = {}): LoopIdentity {
  return {
    specPath: "spec.md",
    language: "go" as LanguageKey,
    buildTool: "maven" as BuildTool,
    coverageThreshold: 80,
    ...overrides,
  };
}

function makeMachine(overrides: Partial<PhaseMachine> = {}): PhaseMachine {
  return {
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
    ...overrides,
  };
}

function makeNegotiation(overrides: Partial<NegotiationState> = {}): NegotiationState {
  return {
    lastProposal: "",
    ...overrides,
  };
}

function makeDispute(overrides: Partial<DisputeState> = {}): DisputeState {
  return {
    mode: false,
    count: 0,
    max: 3,
    awaitFix: false,
    awaitReview: false,
    ...overrides,
  };
}

function makeGates(overrides: Partial<GateState> = {}): GateState {
  return {
    lastResult: undefined,
    ...overrides,
  };
}

function makePhase0(overrides: Partial<PhaseZeroState> = {}): PhaseZeroState {
  return {
    findings: undefined,
    awaitingReview: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    identity: makeIdentity(),
    machine: makeMachine(),
    negotiation: makeNegotiation(),
    dispute: makeDispute(),
    gates: makeGates(),
    phase0: makePhase0(),
    ...overrides,
  };
}

// ================================================================
// LoopIdentity type contract
// ================================================================

describe("LoopIdentity", () => {
  it("requires specPath as string", () => {
    const identity = makeIdentity({ specPath: "path/to/spec.md" });
    expect(typeof identity.specPath).toBe("string");
    expect(identity.specPath).toBe("path/to/spec.md");
  });

  it("requires language as LanguageKey", () => {
    for (const lang of ["go", "java", "typescript"] as LanguageKey[]) {
      const identity = makeIdentity({ language: lang });
      expect(identity.language).toBe(lang);
    }
  });

  it("requires buildTool as BuildTool", () => {
    for (const tool of ["maven", "gradle", "go"] as BuildTool[]) {
      const identity = makeIdentity({ buildTool: tool });
      expect(identity.buildTool).toBe(tool);
    }
  });

  it("requires coverageThreshold as number", () => {
    const identity = makeIdentity({ coverageThreshold: 90 });
    expect(typeof identity.coverageThreshold).toBe("number");
    expect(identity.coverageThreshold).toBe(90);
  });

  it("has exactly 4 fields", () => {
    const identity = makeIdentity();
    const keys = Object.keys(identity);
    expect(keys.sort()).toEqual(["buildTool", "coverageThreshold", "language", "specPath"]);
  });
});

// ================================================================
// PhaseMachine type contract
// ================================================================

describe("PhaseMachine", () => {
  it("requires phase as Phase", () => {
    for (const phase of ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"] as Phase[]) {
      const machine = makeMachine({ phase });
      expect(machine.phase).toBe(phase);
    }
  });

  it("requires round as number", () => {
    const machine = makeMachine({ round: 5 });
    expect(typeof machine.round).toBe("number");
  });

  it("allows lastPhase as Phase or null", () => {
    const machine1 = makeMachine({ lastPhase: null });
    expect(machine1.lastPhase).toBeNull();

    const machine2 = makeMachine({ lastPhase: "B" as Phase });
    expect(machine2.lastPhase).toBe("B");
  });

  it("requires turnsThisPhase as number", () => {
    const machine = makeMachine({ turnsThisPhase: 3 });
    expect(typeof machine.turnsThisPhase).toBe("number");
  });

  it("requires maxA, maxNegotiate, maxB, maxC as numbers", () => {
    const machine = makeMachine({ maxA: 4, maxNegotiate: 5, maxB: 6, maxC: 7 });
    expect(typeof machine.maxA).toBe("number");
    expect(typeof machine.maxNegotiate).toBe("number");
    expect(typeof machine.maxB).toBe("number");
    expect(typeof machine.maxC).toBe("number");
  });

  it("requires maxTurnsPerPhase as number", () => {
    const machine = makeMachine({ maxTurnsPerPhase: 10 });
    expect(typeof machine.maxTurnsPerPhase).toBe("number");
  });

  it("requires transient flags as booleans", () => {
    const machine = makeMachine({ justTransitioned: true, negotiateReprompted: true });
    expect(typeof machine.justTransitioned).toBe("boolean");
    expect(typeof machine.negotiateReprompted).toBe("boolean");
  });

  it("has exactly 11 fields", () => {
    const machine = makeMachine();
    const keys = Object.keys(machine);
    expect(keys.length).toBe(11);
    expect(keys).toContain("phase");
    expect(keys).toContain("round");
    expect(keys).toContain("lastPhase");
    expect(keys).toContain("turnsThisPhase");
    expect(keys).toContain("maxA");
    expect(keys).toContain("maxNegotiate");
    expect(keys).toContain("maxB");
    expect(keys).toContain("maxC");
    expect(keys).toContain("maxTurnsPerPhase");
    expect(keys).toContain("justTransitioned");
    expect(keys).toContain("negotiateReprompted");
  });
});

// ================================================================
// NegotiationState type contract
// ================================================================

describe("NegotiationState", () => {
  it("requires lastProposal as string", () => {
    const negotiation = makeNegotiation({ lastProposal: "My proposal" });
    expect(typeof negotiation.lastProposal).toBe("string");
  });

  it("allows empty string for lastProposal", () => {
    const negotiation = makeNegotiation({ lastProposal: "" });
    expect(negotiation.lastProposal).toBe("");
  });

  it("has exactly 1 field", () => {
    const negotiation = makeNegotiation();
    expect(Object.keys(negotiation).length).toBe(1);
  });
});

// ================================================================
// DisputeState type contract
// ================================================================

describe("DisputeState", () => {
  it("requires mode as boolean", () => {
    const dispute = makeDispute({ mode: true });
    expect(typeof dispute.mode).toBe("boolean");
  });

  it("requires count as number", () => {
    const dispute = makeDispute({ count: 5 });
    expect(typeof dispute.count).toBe("number");
  });

  it("requires max as number", () => {
    const dispute = makeDispute({ max: 10 });
    expect(typeof dispute.max).toBe("number");
  });

  it("requires awaitFix as boolean", () => {
    const dispute = makeDispute({ awaitFix: true });
    expect(typeof dispute.awaitFix).toBe("boolean");
  });

  it("requires awaitReview as boolean", () => {
    const dispute = makeDispute({ awaitReview: true });
    expect(typeof dispute.awaitReview).toBe("boolean");
  });

  it("has exactly 5 fields", () => {
    const dispute = makeDispute();
    expect(Object.keys(dispute).length).toBe(5);
    expect(Object.keys(dispute).sort()).toEqual(["awaitFix", "awaitReview", "count", "max", "mode"]);
  });
});

// ================================================================
// GateState type contract
// ================================================================

describe("GateState", () => {
  it("allows optional lastResult", () => {
    const gates1: GateState = {};
    expect(gates1.lastResult).toBeUndefined();

    const gateResult: GateResult = {
      compile: true,
      compileError: "",
      tests: true,
      allPassed: true,
      coverage: 90,
      failures: [],
    };
    const gates2 = makeGates({ lastResult: gateResult });
    expect(gates2.lastResult).toEqual(gateResult);
  });

  it("has at most 1 field", () => {
    const gates: GateState = {};
    expect(Object.keys(gates).length).toBeLessThanOrEqual(1);
  });
});

// ================================================================
// PhaseZeroState type contract
// ================================================================

describe("PhaseZeroState", () => {
  it("allows optional findings", () => {
    const phase0: PhaseZeroState = { awaitingReview: false };
    expect(phase0.findings).toBeUndefined();
  });

  it("allows findings array", () => {
    const finding: Finding = {
      id: 1,
      category: "Ambiguous phrase",
      title: "Test finding",
      ambiguity: "Test ambiguity",
      interpretations: [],
      recommendation: "Fix it",
    };
    const phase0 = makePhase0({ findings: [finding] });
    expect(phase0.findings).toEqual([finding]);
  });

  it("requires awaitingReview as boolean", () => {
    const phase0 = makePhase0({ awaitingReview: true });
    expect(typeof phase0.awaitingReview).toBe("boolean");
  });

  it("has at most 2 fields", () => {
    const phase0 = makePhase0();
    expect(Object.keys(phase0).length).toBeLessThanOrEqual(2);
  });
});

// ================================================================
// LoopState composite type contract
// ================================================================

describe("LoopState (composite)", () => {
  it("has exactly 6 sub-structure fields", () => {
    const state = makeState();
    const keys = Object.keys(state);
    expect(keys.length).toBe(6);
    expect(keys.sort()).toEqual(["dispute", "gates", "identity", "machine", "negotiation", "phase0"]);
  });

  it("does not have skipPhase0 (dead code removed)", () => {
    const state = makeState();
    expect("skipPhase0" in state).toBe(false);
  });

  it("does not have flat fields at top level", () => {
    const state = makeState();
    // These used to be top-level fields in the old LoopState
    expect("phase" in state).toBe(false);
    expect("round" in state).toBe(false);
    expect("specPath" in state).toBe(false);
    expect("disputeMode" in state).toBe(false);
    expect("disputeCount" in state).toBe(false);
  });

  it("provides all 6 required sub-structures", () => {
    const state = makeState();
    expect(state.identity).toBeDefined();
    expect(state.machine).toBeDefined();
    expect(state.negotiation).toBeDefined();
    expect(state.dispute).toBeDefined();
    expect(state.gates).toBeDefined();
    expect(state.phase0).toBeDefined();
  });
});

// ================================================================
// LoopSubStructures type contract (migration helper type)
// ================================================================

describe("LoopSubStructures", () => {
  it("contains all 6 sub-structures", () => {
    const ss: LoopSubStructures = {
      identity: makeIdentity(),
      machine: makeMachine(),
      negotiation: makeNegotiation(),
      dispute: makeDispute(),
      gates: makeGates(),
      phase0: makePhase0(),
    };
    expect(Object.keys(ss).length).toBe(6);
  });
});

// ================================================================
// Edge cases: empty, undefined, null, single element
// ================================================================

describe("edge cases — types", () => {
  it("allows empty findings array in PhaseZeroState", () => {
    const phase0: PhaseZeroState = { findings: [], awaitingReview: false };
    expect(phase0.findings).toEqual([]);
  });

  it("allows null lastPhase in PhaseMachine", () => {
    const machine: PhaseMachine = {
      phase: "A",
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
    expect(machine.lastPhase).toBeNull();
  });

  it("allows empty string lastProposal in NegotiationState", () => {
    const negotiation: NegotiationState = { lastProposal: "" };
    expect(negotiation.lastProposal).toBe("");
  });

  it("allows zero count in DisputeState", () => {
    const dispute: DisputeState = {
      mode: false,
      count: 0,
      max: 3,
      awaitFix: false,
      awaitReview: false,
    };
    expect(dispute.count).toBe(0);
  });

  it("allows empty GateState object", () => {
    const gates: GateState = {};
    expect(gates.lastResult).toBeUndefined();
  });

  it("PhaseZeroState with single finding", () => {
    const finding: Finding = {
      id: 1,
      category: "Edge case missing",
      title: "Edge case — single",
      ambiguity: "Single element",
      interpretations: [],
      recommendation: "Handle it",
    };
    const phase0: PhaseZeroState = { findings: [finding], awaitingReview: false };
    expect(phase0.findings!.length).toBe(1);
  });
});
