// Contract tests for migration helpers (dual-state consistency)
// internal/done-loop-state-refactor.md — Migration Plan: toSubStructures / applySubStructures

import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/state-factory";
import { toSubStructures, applySubStructures } from "../src/state-migration";
import type { LoopState as OldLoopState, Phase, LanguageKey, BuildTool, GateResult, Finding } from "../src/types";
import type { LoopSubStructures } from "../src/state-types";

// --- Helper: create old-style flat LoopState ---

function makeOldState(overrides?: Partial<OldLoopState>): OldLoopState {
  return {
    phase: "A" as Phase,
    round: 1,
    specPath: "spec.md",
    language: "go" as LanguageKey,
    buildTool: "maven" as BuildTool,
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A" as Phase,
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
    lastGateResult: undefined,
    specFindings: undefined,
    awaitingReview: undefined,
    skipPhase0: undefined,
    ...overrides,
  };
}

// ================================================================
// toSubStructures — maps flat fields to sub-structures
// ================================================================

describe("toSubStructures", () => {
  it("maps identity fields correctly", () => {
    const state = makeOldState();
    const ss = toSubStructures(state);

    expect(ss.identity.specPath).toBe("spec.md");
    expect(ss.identity.language).toBe("go");
    expect(ss.identity.buildTool).toBe("maven");
    expect(ss.identity.coverageThreshold).toBe(80);
  });

  it("maps machine fields correctly", () => {
    const state = makeOldState();
    const ss = toSubStructures(state);

    expect(ss.machine.phase).toBe("A");
    expect(ss.machine.round).toBe(1);
    expect(ss.machine.lastPhase).toBe("A");
    expect(ss.machine.turnsThisPhase).toBe(1);
    expect(ss.machine.maxA).toBe(3);
    expect(ss.machine.maxNegotiate).toBe(3);
    expect(ss.machine.maxB).toBe(5);
    expect(ss.machine.maxC).toBe(3);
    expect(ss.machine.maxTurnsPerPhase).toBe(5);
    expect(ss.machine.justTransitioned).toBe(false);
    expect(ss.machine.negotiateReprompted).toBe(false);
  });

  it("maps negotiation fields correctly", () => {
    const state = makeOldState({ lastProposal: "My proposal" });
    const ss = toSubStructures(state);

    expect(ss.negotiation.lastProposal).toBe("My proposal");
  });

  it("maps dispute fields correctly (disputeMode → mode, disputeCount → count, maxDispute → max)", () => {
    const state = makeOldState({
      disputeMode: true,
      disputeCount: 2,
      maxDispute: 5,
      awaitDisputeFix: true,
      awaitDisputeReview: true,
    });
    const ss = toSubStructures(state);

    expect(ss.dispute.mode).toBe(true);
    expect(ss.dispute.count).toBe(2);
    expect(ss.dispute.max).toBe(5);
    expect(ss.dispute.awaitFix).toBe(true);
    expect(ss.dispute.awaitReview).toBe(true);
  });

  it("maps gates fields correctly (lastGateResult → lastResult)", () => {
    const gateResult: GateResult = {
      compile: true,
      compileError: "",
      tests: true,
      allPassed: true,
      coverage: 90,
      failures: [],
    };
    const state = makeOldState({ lastGateResult: gateResult });
    const ss = toSubStructures(state);

    expect(ss.gates.lastResult).toEqual(gateResult);
  });

  it("maps phase0 fields correctly (specFindings → findings, awaitingReview)", () => {
    const findings: Finding[] = [{
      id: 1,
      category: "Ambiguous phrase",
      title: "Test",
      ambiguity: "Test",
      interpretations: [],
      recommendation: "Fix",
    }];
    const state = makeOldState({ specFindings: findings, awaitingReview: true });
    const ss = toSubStructures(state);

    expect(ss.phase0.findings).toEqual(findings);
    expect(ss.phase0.awaitingReview).toBe(true);
  });

  it("handles missing optional fields (lastGateResult undefined)", () => {
    const state = makeOldState({ lastGateResult: undefined });
    const ss = toSubStructures(state);

    expect(ss.gates.lastResult).toBeUndefined();
  });

  it("handles missing optional fields (specFindings undefined)", () => {
    const state = makeOldState({ specFindings: undefined });
    const ss = toSubStructures(state);

    expect(ss.phase0.findings).toBeUndefined();
  });

  it("returns object with exactly 6 sub-structures", () => {
    const state = makeOldState();
    const ss = toSubStructures(state);

    expect(Object.keys(ss).length).toBe(6);
    expect("identity" in ss).toBe(true);
    expect("machine" in ss).toBe(true);
    expect("negotiation" in ss).toBe(true);
    expect("dispute" in ss).toBe(true);
    expect("gates" in ss).toBe(true);
    expect("phase0" in ss).toBe(true);
  });
});

// ================================================================
// applySubStructures — writes sub-structures back to flat fields
// ================================================================

describe("applySubStructures", () => {
  it("writes identity fields back to flat state", () => {
    const state = makeOldState();
    const ss: LoopSubStructures = {
      identity: { specPath: "new-spec.md", language: "java", buildTool: "gradle", coverageThreshold: 90 },
      machine: { phase: "A", round: 1, lastPhase: null, turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5, justTransitioned: false, negotiateReprompted: false },
      negotiation: { lastProposal: "" },
      dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
      gates: {},
      phase0: { awaitingReview: false },
    };
    applySubStructures(state, ss);

    expect(state.specPath).toBe("new-spec.md");
    expect(state.language).toBe("java");
    expect(state.buildTool).toBe("gradle");
    expect(state.coverageThreshold).toBe(90);
  });

  it("writes machine fields back to flat state", () => {
    const state = makeOldState();
    const ss: LoopSubStructures = {
      identity: { specPath: "spec.md", language: "go", buildTool: "maven", coverageThreshold: 80 },
      machine: { phase: "B", round: 3, lastPhase: "A", turnsThisPhase: 2, maxA: 4, maxNegotiate: 4, maxB: 6, maxC: 4, maxTurnsPerPhase: 7, justTransitioned: true, negotiateReprompted: true },
      negotiation: { lastProposal: "" },
      dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
      gates: {},
      phase0: { awaitingReview: false },
    };
    applySubStructures(state, ss);

    expect(state.phase).toBe("B");
    expect(state.round).toBe(3);
    expect(state.lastPhase).toBe("A");
    expect(state.turnsThisPhase).toBe(2);
    expect(state.maxA).toBe(4);
    expect(state.maxNegotiate).toBe(4);
    expect(state.maxB).toBe(6);
    expect(state.maxC).toBe(4);
    expect(state.maxTurnsPerPhase).toBe(7);
    expect(state.justTransitioned).toBe(true);
    expect(state.negotiateReprompted).toBe(true);
  });

  it("writes negotiation fields back to flat state (lastProposal)", () => {
    const state = makeOldState();
    const ss: LoopSubStructures = {
      identity: { specPath: "spec.md", language: "go", buildTool: "maven", coverageThreshold: 80 },
      machine: { phase: "A", round: 1, lastPhase: null, turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5, justTransitioned: false, negotiateReprompted: false },
      negotiation: { lastProposal: "New proposal text" },
      dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
      gates: {},
      phase0: { awaitingReview: false },
    };
    applySubStructures(state, ss);

    expect(state.lastProposal).toBe("New proposal text");
  });

  it("writes dispute fields back to flat state (mode → disputeMode, count → disputeCount, max → maxDispute)", () => {
    const state = makeOldState();
    const ss: LoopSubStructures = {
      identity: { specPath: "spec.md", language: "go", buildTool: "maven", coverageThreshold: 80 },
      machine: { phase: "A", round: 1, lastPhase: null, turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5, justTransitioned: false, negotiateReprompted: false },
      negotiation: { lastProposal: "" },
      dispute: { mode: true, count: 4, max: 6, awaitFix: true, awaitReview: true },
      gates: {},
      phase0: { awaitingReview: false },
    };
    applySubStructures(state, ss);

    expect(state.disputeMode).toBe(true);
    expect(state.disputeCount).toBe(4);
    expect(state.maxDispute).toBe(6);
    expect(state.awaitDisputeFix).toBe(true);
    expect(state.awaitDisputeReview).toBe(true);
  });

  it("writes gates fields back to flat state (lastResult → lastGateResult)", () => {
    const state = makeOldState();
    const gateResult: GateResult = {
      compile: false,
      compileError: "error: undefined",
      tests: false,
      allPassed: false,
      coverage: 0,
      failures: [],
    };
    const ss: LoopSubStructures = {
      identity: { specPath: "spec.md", language: "go", buildTool: "maven", coverageThreshold: 80 },
      machine: { phase: "A", round: 1, lastPhase: null, turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5, justTransitioned: false, negotiateReprompted: false },
      negotiation: { lastProposal: "" },
      dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
      gates: { lastResult: gateResult },
      phase0: { awaitingReview: false },
    };
    applySubStructures(state, ss);

    expect(state.lastGateResult).toEqual(gateResult);
  });

  it("writes phase0 fields back to flat state (findings → specFindings, awaitingReview)", () => {
    const findings: Finding[] = [{
      id: 1,
      category: "Edge case missing",
      title: "Test",
      ambiguity: "Test",
      interpretations: [],
      recommendation: "Fix",
    }];
    const state = makeOldState();
    const ss: LoopSubStructures = {
      identity: { specPath: "spec.md", language: "go", buildTool: "maven", coverageThreshold: 80 },
      machine: { phase: "A", round: 1, lastPhase: null, turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5, justTransitioned: false, negotiateReprompted: false },
      negotiation: { lastProposal: "" },
      dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
      gates: {},
      phase0: { findings, awaitingReview: true },
    };
    applySubStructures(state, ss);

    expect(state.specFindings).toEqual(findings);
    expect(state.awaitingReview).toBe(true);
  });

  it("mutates state in place (no new object)", () => {
    const state = makeOldState();
    const ss: LoopSubStructures = {
      identity: { specPath: "new.md", language: "java", buildTool: "gradle", coverageThreshold: 90 },
      machine: { phase: "B", round: 2, lastPhase: "A", turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5, justTransitioned: false, negotiateReprompted: false },
      negotiation: { lastProposal: "" },
      dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
      gates: {},
      phase0: { awaitingReview: false },
    };
    const result = applySubStructures(state, ss);
    expect(result).toBeUndefined(); // void return
    expect(state.phase).toBe("B"); // mutated in place
  });
});

// ================================================================
// Round-trip: toSubStructures → applySubStructures
// ================================================================

describe("round-trip: toSubStructures → applySubStructures", () => {
  it("preserves all identity fields through round-trip", () => {
    const original = makeOldState({
      specPath: "deep/path/spec.md",
      language: "typescript",
      buildTool: "go",
      coverageThreshold: 95,
    });

    const ss = toSubStructures(original);
    applySubStructures(original, ss);

    expect(original.specPath).toBe("deep/path/spec.md");
    expect(original.language).toBe("typescript");
    expect(original.buildTool).toBe("go");
    expect(original.coverageThreshold).toBe(95);
  });

  it("preserves all machine fields through round-trip", () => {
    const original = makeOldState({
      phase: "C" as Phase,
      round: 5,
      lastPhase: "B" as Phase,
      turnsThisPhase: 3,
      maxA: 4,
      maxNegotiate: 5,
      maxB: 7,
      maxC: 6,
      maxTurnsPerPhase: 8,
      justTransitioned: true,
      negotiateReprompted: true,
    });

    const ss = toSubStructures(original);
    applySubStructures(original, ss);

    expect(original.phase).toBe("C");
    expect(original.round).toBe(5);
    expect(original.lastPhase).toBe("B");
    expect(original.turnsThisPhase).toBe(3);
    expect(original.justTransitioned).toBe(true);
    expect(original.negotiateReprompted).toBe(true);
  });

  it("preserves all dispute fields through round-trip", () => {
    const original = makeOldState({
      disputeMode: true,
      disputeCount: 3,
      maxDispute: 7,
      awaitDisputeFix: true,
      awaitDisputeReview: true,
    });

    const ss = toSubStructures(original);
    applySubStructures(original, ss);

    expect(original.disputeMode).toBe(true);
    expect(original.disputeCount).toBe(3);
    expect(original.maxDispute).toBe(7);
    expect(original.awaitDisputeFix).toBe(true);
    expect(original.awaitDisputeReview).toBe(true);
  });

  it("preserves optional fields through round-trip", () => {
    const gateResult: GateResult = {
      compile: true,
      compileError: "",
      tests: false,
      allPassed: false,
      coverage: 75,
      failures: [{ test: "TestAdd", subtest: "", output: "fail\n" }],
    };
    const findings: Finding[] = [{
      id: 1,
      category: "Ambiguous phrase",
      title: "Test",
      ambiguity: "Test",
      interpretations: [],
      recommendation: "Fix",
    }];
    const original = makeOldState({
      lastGateResult: gateResult,
      specFindings: findings,
      awaitingReview: true,
    });

    const ss = toSubStructures(original);
    applySubStructures(original, ss);

    expect(original.lastGateResult).toEqual(gateResult);
    expect(original.specFindings).toEqual(findings);
    expect(original.awaitingReview).toBe(true);
  });
});

// ================================================================
// Edge cases: empty, undefined, null, single element
// ================================================================

describe("edge cases — migration helpers", () => {
  it("toSubStructures handles empty string specPath", () => {
    const state = makeOldState({ specPath: "" });
    const ss = toSubStructures(state);
    expect(ss.identity.specPath).toBe("");
  });

  it("toSubStructures handles empty string lastProposal", () => {
    const state = makeOldState({ lastProposal: "" });
    const ss = toSubStructures(state);
    expect(ss.negotiation.lastProposal).toBe("");
  });

  it("toSubStructures handles undefined lastGateResult", () => {
    const state = makeOldState({ lastGateResult: undefined });
    const ss = toSubStructures(state);
    expect(ss.gates.lastResult).toBeUndefined();
  });

  it("toSubStructures handles empty findings array", () => {
    const state = makeOldState({ specFindings: [] });
    const ss = toSubStructures(state);
    expect(ss.phase0.findings).toEqual([]);
  });

  it("toSubStructures handles single finding", () => {
    const finding: Finding = {
      id: 1,
      category: "Ambiguous phrase",
      title: "Test",
      ambiguity: "Test",
      interpretations: [],
      recommendation: "Fix",
    };
    const state = makeOldState({ specFindings: [finding] });
    const ss = toSubStructures(state);
    expect(ss.phase0.findings).toEqual([finding]);
  });

  it("applySubStructures handles undefined lastResult", () => {
    const state = makeOldState({ lastGateResult: { compile: true, compileError: "", tests: true, allPassed: true, coverage: 0, failures: [] } });
    const ss: LoopSubStructures = {
      identity: { specPath: "spec.md", language: "go", buildTool: "maven", coverageThreshold: 80 },
      machine: { phase: "A", round: 1, lastPhase: null, turnsThisPhase: 1, maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5, justTransitioned: false, negotiateReprompted: false },
      negotiation: { lastProposal: "" },
      dispute: { mode: false, count: 0, max: 3, awaitFix: false, awaitReview: false },
      gates: {}, // no lastResult
      phase0: { awaitingReview: false },
    };
    applySubStructures(state, ss);
    expect(state.lastGateResult).toBeUndefined();
  });
});
