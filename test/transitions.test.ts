// Unit tests for transitions module (pure functions)

import { describe, it, expect } from "vitest";
import * as T from "../src/transitions";
import type { LoopState, GateResult } from "../src/types";

function makeState(overrides = {}): LoopState {
  return {
    phase: "idle",
    round: 0,
    specPath: "spec.md",
    language: "go",
    buildTool: "maven",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
    ...overrides,
  };
}

function makeGateResult(overrides = {}): GateResult {
  return {
    compile: false,
    compileError: "",
    tests: false,
    coverage: 0,
    failures: [],
    allPassed: false,
    ...overrides,
  };
}

// --- computeNegotiateTransition ---

describe("computeNegotiateTransition", () => {
  it("first settle: re-prompts Writer on odd round", () => {
    const state = makeState({ phase: "negotiate", round: 1 });
    const result = T.computeNegotiateTransition(state);

    expect(result.effect.type).toBe("reprompt");
    if (result.effect.type === "reprompt") {
      expect(result.effect.notify).toContain("negotiate_propose");
      expect(result.effect.level).toBe("warning");
    }
    expect(result.state.negotiateReprompted).toBe(true);
  });

  it("first settle: re-prompts Tester on even round", () => {
    const state = makeState({ phase: "negotiate", round: 2 });
    const result = T.computeNegotiateTransition(state);

    expect(result.effect.type).toBe("reprompt");
    if (result.effect.type === "reprompt") {
      expect(result.effect.notify).toContain("negotiate_review");
      expect(result.effect.level).toBe("warning");
    }
  });

  it("second settle: auto-advances to Phase B", () => {
    const state = makeState({ phase: "negotiate", round: 1, negotiateReprompted: true });
    const result = T.computeNegotiateTransition(state);

    expect(result.effect.type).toBe("advance");
    expect(result.state.phase).toBe("B");
    expect(result.state.round).toBe(1);
    expect(result.state.justTransitioned).toBe(true);
    expect(result.state.negotiateReprompted).toBe(false);
    expect(result.state.lastPhase).toBe("negotiate");
  });
});

// --- Phase A transitions ---

describe("Phase A transitions (via computeTransition)", () => {
  it("compile pass: advances to negotiate", () => {
    const state = makeState({ phase: "A", round: 1 });
    const gateResult = makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("advance");
    expect(result.state.phase).toBe("negotiate");
    expect(result.state.round).toBe(1);
    expect(result.state.negotiateReprompted).toBe(false);
  });

  it("compile fail: retries within maxA", () => {
    const state = makeState({ phase: "A", round: 1, maxA: 3 });
    const gateResult = makeGateResult({ compile: false, compileError: "type mismatch" });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("retry");
    expect(result.state.phase).toBe("A");
    expect(result.state.round).toBe(2);
  });

  it("compile fail: escalates at maxA", () => {
    const state = makeState({ phase: "A", round: 3, maxA: 3 });
    const gateResult = makeGateResult({ compile: false, compileError: "type mismatch" });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("escalated");
    expect(result.state.phase).toBe("escalated");
    expect(result.state.lastPhase).toBe("A");
  });
});

// --- Phase B transitions ---

describe("Phase B transitions (via computeTransition)", () => {
  it("allPassed: advances to Phase C", () => {
    const state = makeState({ phase: "B", round: 1 });
    const gateResult = makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("advance");
    expect(result.state.phase).toBe("C");
    expect(result.state.round).toBe(1);
  });

  it("failure: retries within maxB", () => {
    const state = makeState({ phase: "B", round: 1, maxB: 5 });
    const gateResult = makeGateResult({ compile: true, tests: false, coverage: 0, failures: [{ test: "T", subtest: "", output: "" }] });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("retry");
    expect(result.state.phase).toBe("B");
    expect(result.state.round).toBe(2);
  });

  it("failure: escalates at maxB", () => {
    const state = makeState({ phase: "B", round: 5, maxB: 5 });
    const gateResult = makeGateResult({ compile: true, tests: false, coverage: 0, failures: [{ test: "T", subtest: "", output: "" }] });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("escalated");
    expect(result.state.phase).toBe("escalated");
  });
});

// --- Phase C transitions ---

describe("Phase C transitions (via computeTransition)", () => {
  it("tests pass: done", () => {
    const state = makeState({ phase: "C", round: 1 });
    const gateResult = makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("done");
    expect(result.state.phase).toBe("done");
  });

  it("tests fail: retries within maxC", () => {
    const state = makeState({ phase: "C", round: 1, maxC: 3 });
    const gateResult = makeGateResult({ compile: true, tests: false, coverage: 0, failures: [{ test: "T", subtest: "", output: "" }] });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("retry");
    expect(result.state.phase).toBe("C");
    expect(result.state.round).toBe(2);
  });

  it("tests fail: done (cleaner failed) at maxC", () => {
    const state = makeState({ phase: "C", round: 3, maxC: 3 });
    const gateResult = makeGateResult({ compile: true, tests: false, coverage: 0, failures: [{ test: "T", subtest: "", output: "" }] });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("done");
    expect(result.state.phase).toBe("done");
    if (result.effect.type === "done") {
      expect(result.effect.status).toBe("done (cleaner failed)");
    }
  });
});

// --- Dispute fix transitions ---

describe("Dispute fix transitions (via computeTransition)", () => {
  it("allPassed: advances to Phase C", () => {
    const state = makeState({ phase: "B", round: 1, disputeMode: true });
    const gateResult = makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("advance");
    expect(result.state.phase).toBe("C");
    expect(result.state.disputeMode).toBe(false);
  });

  it("tests fail: Writer retries", () => {
    const state = makeState({ phase: "B", round: 1, disputeMode: true });
    const gateResult = makeGateResult({ compile: true, tests: false, coverage: 0, failures: [{ test: "T", subtest: "", output: "" }] });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("retry");
    expect(result.state.phase).toBe("B");
    expect(result.state.round).toBe(2);
    expect(result.state.disputeMode).toBe(false);
  });

  it("compile fail: Tester retries", () => {
    const state = makeState({ phase: "B", round: 1, disputeMode: true });
    const gateResult = makeGateResult({ compile: false, compileError: "type mismatch" });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("retry");
    expect(result.state.phase).toBe("B");
    expect(result.state.round).toBe(2);
    expect(result.state.disputeMode).toBe(false);
    if (result.effect.type === "retry") {
      expect(result.effect.notify).toContain("compile");
    }
  });
});

// --- computeTransition dispatcher ---

describe("computeTransition (dispatcher)", () => {
  it("dispatches to Phase A", () => {
    const state = makeState({ phase: "A", round: 1 });
    const gateResult = makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("advance");
    expect(result.state.phase).toBe("negotiate");
  });

  it("dispatches to negotiate (no gate)", () => {
    const state = makeState({ phase: "negotiate", round: 1 });
    const result = T.computeTransition(state, null);

    expect(result.effect.type).toBe("reprompt");
  });

  it("returns noop for done", () => {
    const state = makeState({ phase: "done", round: 0 });
    const result = T.computeTransition(state, null);
    expect(result.effect.type).toBe("noop");
  });

  it("dispatches to dispute fix", () => {
    const state = makeState({ phase: "B", round: 1, disputeMode: true });
    const gateResult = makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
    const result = T.computeTransition(state, gateResult);

    expect(result.effect.type).toBe("advance");
    expect(result.state.phase).toBe("C");
  });

  it("returns noop for idle", () => {
    const state = makeState({ phase: "idle", round: 0 });
    const result = T.computeTransition(state, null);

    expect(result.effect.type).toBe("noop");
  });
});

// --- Immutability ---

describe("immutability", () => {
  it("does not mutate original state", () => {
    const state = makeState({ phase: "A", round: 1 });
    const gateResult = makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
    const originalPhase = state.phase;
    const originalRound = state.round;

    T.computeTransition(state, gateResult);

    expect(state.phase).toBe(originalPhase);  // unchanged
    expect(state.round).toBe(originalRound);    // unchanged
  });
});
