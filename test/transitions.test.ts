// Unit tests for transitions module (pure functions)

import { describe, it, expect } from "vitest";
import * as T from "../src/transitions";
import type { LoopState, GateResult } from "../src/types";

// Spec 07 shims — the negotiate round markers (LoopState fields) and effect
// variants (review-request/feedback) land in src/types.ts and src/transitions.ts
// in the writer phase. The casts below keep this contract type-clean before
// that lands; remove once the declarations exist.
type NegotiateMarkers = { negotiateProposed?: boolean; negotiateFeedback?: string };
type EffectShape = { type: string; notify?: string; status?: string };
type NegResult = { state: LoopState & NegotiateMarkers; effect: EffectShape };

function makeState(overrides: Partial<LoopState> & NegotiateMarkers = {}): LoopState {
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
    // Row 5 (CHANGED): the even-round Tester reprompt now sets the flag, so a
    // Tester that never reviews cannot be reprompted forever.
    expect(result.state.negotiateReprompted).toBe(true);
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

  it("row 1: proposed → Tester review (round 1→2), markers cleared, input unmutated", () => {
    const state = makeState({
      phase: "negotiate",
      round: 1,
      lastProposal: "plan X",
      negotiateProposed: true,
      negotiateFeedback: "stale",
      negotiateReprompted: true,
    });
    const before = JSON.parse(JSON.stringify(state));
    const result = T.computeNegotiateTransition(state) as NegResult;

    expect(result.effect.type).toBe("review-request");
    expect(result.effect.notify).toBe("Writer proposed — Tester reviewing.");
    expect(result.state.round).toBe(2); // odd Writer round → even Tester round
    expect(result.state.negotiateProposed).toBe(false);
    expect(result.state.negotiateFeedback).toBe("");
    expect(result.state.negotiateReprompted).toBe(false);
    expect(result.state).not.toBe(state); // fresh state object
    expect(state).toEqual(before); // input never mutated
  });

  it("row 2a: feedback within maxNegotiate → Writer revision (round 4→5)", () => {
    const state = makeState({ phase: "negotiate", round: 4, negotiateFeedback: "make it faster", maxNegotiate: 3 });
    const result = T.computeNegotiateTransition(state) as NegResult;

    expect(result.effect.type).toBe("feedback");
    expect(result.effect.notify).toBe("Tester feedback recorded — Writer revising.");
    expect(result.state.round).toBe(5); // even Tester round → odd Writer round
    expect(result.state.negotiateFeedback).toBe("");
    expect(result.state.negotiateProposed).toBe(false);
    expect(result.state.negotiateReprompted).toBe(false);
  });

  it("row 2b: feedback beyond maxNegotiate → escalate (round 6, maxNegotiate 3)", () => {
    const state = makeState({ phase: "negotiate", round: 6, negotiateFeedback: "still wrong", maxNegotiate: 3 });
    const result = T.computeNegotiateTransition(state);

    expect(result.effect.type).toBe("escalated");
    if (result.effect.type === "escalated") {
      expect(result.effect.status).toBe("escalated (Phase negotiate exhausted)");
      expect(result.effect.notify).toBe("Negotiation limit reached. Escalating to human.");
    }
    expect(result.state.phase).toBe("escalated");
    expect(result.state.lastPhase).toBe("negotiate");
    expect(result.state.turnsThisPhase).toBe(1);
  });

  it("row 2b: feedback beyond maxNegotiate=1 → escalate (round 4)", () => {
    const state = makeState({ phase: "negotiate", round: 4, negotiateFeedback: "no", maxNegotiate: 1 });
    const result = T.computeNegotiateTransition(state);

    expect(result.effect.type).toBe("escalated");
    expect(result.state.phase).toBe("escalated");
    expect(result.state.lastPhase).toBe("negotiate");
  });

  it("precedence: proposed beats reprompted (row 1 over row 3, no advance)", () => {
    const state = makeState({ phase: "negotiate", round: 1, negotiateProposed: true, negotiateReprompted: true });
    const result = T.computeNegotiateTransition(state);

    expect(result.effect.type).toBe("review-request");
    expect(result.state.phase).toBe("negotiate"); // NOT advanced to B
    expect(result.state.round).toBe(2);
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

// --- Phase-boundary dispute-flag clearing (spec 08) ---
// Contract: no dispute flag survives a phase boundary. The five state
// builders are module-private, so each site is exercised through the public
// transition API that invokes it. Each test covers both flags live (the
// contract) plus a single live flag (the clears are unconditional — a live
// flag must not depend on its sibling being set).

describe("phase-boundary dispute-flag clearing (spec 08)", () => {
  const allPass = () => makeGateResult({ compile: true, tests: true, coverage: 85, allPassed: true });
  const failB = () => makeGateResult({ compile: true, tests: false, coverage: 0, failures: [{ test: "T", subtest: "", output: "" }] });

  it("site 1 — advanceToNegotiate: both flags cleared at the A→negotiate boundary", () => {
    const state = makeState({ phase: "A", round: 1, awaitDisputeFix: true, awaitDisputeReview: true });
    const result = T.computeTransition(state, allPass());

    expect(result.state.phase).toBe("negotiate");
    expect(result.state.awaitDisputeFix).toBe(false);
    expect(result.state.awaitDisputeReview).toBe(false);

    // edge: a single live flag — cleared unconditionally
    const one = makeState({ phase: "A", round: 1, awaitDisputeReview: true });
    const rOne = T.computeTransition(one, allPass());
    expect(rOne.state.awaitDisputeFix).toBe(false);
    expect(rOne.state.awaitDisputeReview).toBe(false);
  });

  it("site 2 — advanceToPhaseB: both flags cleared at the negotiate→B boundary", () => {
    const state = makeState({ phase: "negotiate", round: 2, negotiateReprompted: true, awaitDisputeFix: true, awaitDisputeReview: true });
    const result = T.computeNegotiateTransition(state);

    expect(result.state.phase).toBe("B");
    expect(result.state.awaitDisputeFix).toBe(false);
    expect(result.state.awaitDisputeReview).toBe(false);

    // edge: single live flag
    const one = makeState({ phase: "negotiate", round: 2, negotiateReprompted: true, awaitDisputeFix: true });
    const rOne = T.computeNegotiateTransition(one);
    expect(rOne.state.awaitDisputeFix).toBe(false);
    expect(rOne.state.awaitDisputeReview).toBe(false);
  });

  it("site 3 — advanceToPhaseC: both flags cleared at the B→C boundary (beside disputeMode)", () => {
    const state = makeState({ phase: "B", round: 2, disputeMode: true, awaitDisputeFix: true, awaitDisputeReview: true });
    const result = T.computeTransition(state, allPass());

    expect(result.state.phase).toBe("C");
    expect(result.state.disputeMode).toBe(false);
    expect(result.state.awaitDisputeFix).toBe(false);
    expect(result.state.awaitDisputeReview).toBe(false);

    // edge: single live flag, no dispute mode
    const one = makeState({ phase: "B", round: 1, awaitDisputeFix: true });
    const rOne = T.computeTransition(one, allPass());
    expect(rOne.state.awaitDisputeFix).toBe(false);
    expect(rOne.state.awaitDisputeReview).toBe(false);
  });

  it("site 4 — escalateTo: both flags cleared at the B→escalated boundary", () => {
    const state = makeState({ phase: "B", round: 5, maxB: 5, awaitDisputeFix: true, awaitDisputeReview: true });
    const result = T.computeTransition(state, failB());

    expect(result.state.phase).toBe("escalated");
    expect(result.state.lastPhase).toBe("B");
    expect(result.state.awaitDisputeFix).toBe(false);
    expect(result.state.awaitDisputeReview).toBe(false);

    // edge: single live flag
    const one = makeState({ phase: "B", round: 5, maxB: 5, awaitDisputeReview: true });
    const rOne = T.computeTransition(one, failB());
    expect(rOne.state.awaitDisputeFix).toBe(false);
    expect(rOne.state.awaitDisputeReview).toBe(false);
  });

  it("site 5 — markDone: both flags cleared at the C→done boundary", () => {
    const state = makeState({ phase: "C", round: 1, awaitDisputeFix: true, awaitDisputeReview: true });
    const result = T.computeTransition(state, allPass());

    expect(result.state.phase).toBe("done");
    expect(result.state.awaitDisputeFix).toBe(false);
    expect(result.state.awaitDisputeReview).toBe(false);

    // edge: single live flag
    const one = makeState({ phase: "C", round: 1, awaitDisputeReview: true });
    const rOne = T.computeTransition(one, allPass());
    expect(rOne.state.awaitDisputeFix).toBe(false);
    expect(rOne.state.awaitDisputeReview).toBe(false);
  });
});
