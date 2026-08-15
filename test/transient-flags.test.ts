// Contract tests for transient flag clearing
// internal/done-loop-state-refactor.md — Transient flag clearing on session restore

import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/state-factory";
import { clearTransientFlags } from "../src/transient-flags";
import type { LanguageKey, BuildTool, Phase } from "../src/types";
import type { LoopState } from "../src/state-types";

// --- Helper ---

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    ...createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool),
    ...overrides,
  };
}

// ================================================================
// clearTransientFlags — mutates state in place
// ================================================================

describe("clearTransientFlags", () => {
  it("clears justTransitioned to false", () => {
    const state = makeState({
      machine: {
        ...makeState().machine,
        justTransitioned: true,
      },
    });
    clearTransientFlags(state);
    expect(state.machine.justTransitioned).toBe(false);
  });

  it("clears negotiateReprompted to false", () => {
    const state = makeState({
      machine: {
        ...makeState().machine,
        negotiateReprompted: true,
      },
    });
    clearTransientFlags(state);
    expect(state.machine.negotiateReprompted).toBe(false);
  });

  it("clears dispute.mode to false", () => {
    const state = makeState({
      dispute: {
        ...makeState().dispute,
        mode: true,
      },
    });
    clearTransientFlags(state);
    expect(state.dispute.mode).toBe(false);
  });

  it("clears dispute.awaitFix to false", () => {
    const state = makeState({
      dispute: {
        ...makeState().dispute,
        awaitFix: true,
      },
    });
    clearTransientFlags(state);
    expect(state.dispute.awaitFix).toBe(false);
  });

  it("clears dispute.awaitReview to false", () => {
    const state = makeState({
      dispute: {
        ...makeState().dispute,
        awaitReview: true,
      },
    });
    clearTransientFlags(state);
    expect(state.dispute.awaitReview).toBe(false);
  });
});

// ================================================================
// clearTransientFlags — clears all 5 transient flags together
// ================================================================

describe("clearTransientFlags — all flags at once", () => {
  it("clears all 5 transient flags in one call", () => {
    const state = makeState({
      machine: {
        ...makeState().machine,
        justTransitioned: true,
        negotiateReprompted: true,
      },
      dispute: {
        ...makeState().dispute,
        mode: true,
        awaitFix: true,
        awaitReview: true,
      },
    });

    clearTransientFlags(state);

    expect(state.machine.justTransitioned).toBe(false);
    expect(state.machine.negotiateReprompted).toBe(false);
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.awaitFix).toBe(false);
    expect(state.dispute.awaitReview).toBe(false);
  });
});

// ================================================================
// clearTransientFlags — does not affect non-transient fields
// ================================================================

describe("clearTransientFlags — preserves non-transient fields", () => {
  it("preserves machine phase", () => {
    const state = makeState({
      machine: { ...makeState().machine, phase: "B", justTransitioned: true },
    });
    clearTransientFlags(state);
    expect(state.machine.phase).toBe("B");
  });

  it("preserves machine round", () => {
    const state = makeState({
      machine: { ...makeState().machine, round: 5, justTransitioned: true },
    });
    clearTransientFlags(state);
    expect(state.machine.round).toBe(5);
  });

  it("preserves machine lastPhase", () => {
    const state = makeState({
      machine: { ...makeState().machine, lastPhase: "A", justTransitioned: true },
    });
    clearTransientFlags(state);
    expect(state.machine.lastPhase).toBe("A");
  });

  it("preserves dispute count", () => {
    const state = makeState({
      dispute: { ...makeState().dispute, count: 5, mode: true },
    });
    clearTransientFlags(state);
    expect(state.dispute.count).toBe(5);
  });

  it("preserves dispute max", () => {
    const state = makeState({
      dispute: { ...makeState().dispute, max: 7, mode: true },
    });
    clearTransientFlags(state);
    expect(state.dispute.max).toBe(7);
  });

  it("preserves identity fields", () => {
    const state = makeState({
      identity: { ...makeState().identity, coverageThreshold: 95 },
    });
    clearTransientFlags(state);
    expect(state.identity.coverageThreshold).toBe(95);
    expect(state.identity.specPath).toBe("spec.md");
  });

  it("preserves negotiation.lastProposal", () => {
    const state = makeState({
      negotiation: { lastProposal: "My proposal text" },
    });
    clearTransientFlags(state);
    expect(state.negotiation.lastProposal).toBe("My proposal text");
  });

  it("preserves gates.lastResult", () => {
    const gateResult = {
      compile: true,
      compileError: "",
      tests: true,
      allPassed: true,
      coverage: 90,
      failures: [],
    };
    const state = makeState({
      gates: { lastResult: gateResult },
    });
    clearTransientFlags(state);
    expect(state.gates.lastResult).toEqual(gateResult);
  });

  it("preserves phase0 fields", () => {
    const state = makeState({
      phase0: {
        findings: [],
        awaitingReview: true,
      },
    });
    clearTransientFlags(state);
    expect(state.phase0.awaitingReview).toBe(true);
    expect(state.phase0.findings).toEqual([]);
  });
});

// ================================================================
// clearTransientFlags — already cleared state (idempotent)
// ================================================================

describe("clearTransientFlags — idempotent", () => {
  it("works when flags are already false", () => {
    const state = makeState();
    // All transient flags start as false
    clearTransientFlags(state);

    expect(state.machine.justTransitioned).toBe(false);
    expect(state.machine.negotiateReprompted).toBe(false);
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.awaitFix).toBe(false);
    expect(state.dispute.awaitReview).toBe(false);
  });

  it("can be called twice with same result", () => {
    const state = makeState({
      machine: { ...makeState().machine, justTransitioned: true },
      dispute: { ...makeState().dispute, mode: true, awaitFix: true },
    });

    clearTransientFlags(state);
    const afterFirst = {
      justTransitioned: state.machine.justTransitioned,
      negotiateReprompted: state.machine.negotiateReprompted,
      disputeMode: state.dispute.mode,
      awaitFix: state.dispute.awaitFix,
      awaitReview: state.dispute.awaitReview,
    };

    clearTransientFlags(state);
    const afterSecond = {
      justTransitioned: state.machine.justTransitioned,
      negotiateReprompted: state.machine.negotiateReprompted,
      disputeMode: state.dispute.mode,
      awaitFix: state.dispute.awaitFix,
      awaitReview: state.dispute.awaitReview,
    };

    expect(afterFirst).toEqual(afterSecond);
  });
});

// ================================================================
// clearTransientFlags — void return
// ================================================================

describe("clearTransientFlags — return type", () => {
  it("returns void (no return value)", () => {
    const state = makeState();
    const result = clearTransientFlags(state);
    expect(result).toBeUndefined();
  });
});

// ================================================================
// clearTransientFlags — partial flags set
// ================================================================

describe("clearTransientFlags — partial flags set", () => {
  it("clears only machine transients, leaves dispute alone", () => {
    const state = makeState({
      machine: {
        ...makeState().machine,
        justTransitioned: true,
        negotiateReprompted: false, // already false
      },
      dispute: {
        ...makeState().dispute,
        mode: true,
        awaitFix: false, // already false
        awaitReview: true,
      },
    });

    clearTransientFlags(state);

    expect(state.machine.justTransitioned).toBe(false);
    expect(state.machine.negotiateReprompted).toBe(false);
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.awaitFix).toBe(false);
    expect(state.dispute.awaitReview).toBe(false);
  });

  it("clears only dispute transients, leaves machine alone", () => {
    const state = makeState({
      machine: {
        ...makeState().machine,
        justTransitioned: false, // already false
        negotiateReprompted: false, // already false
      },
      dispute: {
        ...makeState().dispute,
        mode: true,
        awaitFix: true,
        awaitReview: true,
      },
    });

    clearTransientFlags(state);

    expect(state.machine.justTransitioned).toBe(false);
    expect(state.machine.negotiateReprompted).toBe(false);
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.awaitFix).toBe(false);
    expect(state.dispute.awaitReview).toBe(false);
  });
});

// ================================================================
// Edge cases: empty, undefined, null, single element
// ================================================================

describe("edge cases — transient flags", () => {
  it("works on state with empty gates", () => {
    const state = makeState({ gates: {} });
    clearTransientFlags(state);
    expect(state.machine.justTransitioned).toBe(false);
  });

  it("works on state with single dispute flag set", () => {
    const state = makeState({
      dispute: {
        ...makeState().dispute,
        mode: true, // only this one is true
      },
    });
    clearTransientFlags(state);
    expect(state.dispute.mode).toBe(false);
  });

  it("works on state with no transient flags set at all", () => {
    const state = makeState();
    clearTransientFlags(state);
    expect(state.machine.justTransitioned).toBe(false);
    expect(state.machine.negotiateReprompted).toBe(false);
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.awaitFix).toBe(false);
    expect(state.dispute.awaitReview).toBe(false);
  });
});
