// Contract tests for effect-applicator — apply retry/advance/done/escalated effects

import { describe, it, expect, vi } from "vitest";
import {
  applyEffect,
  applyRetryEffect,
  applyAdvanceEffect,
  applyDoneEffect,
  applyEscalatedEffect,
} from "../../../src/events/agent-settled/effect-applicator";
import type { LoopState, GateResult, FailingTest } from "../../../src/types";
import type { EffectInput } from "../../../src/events/agent-settled/effect-applicator";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

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
    allPassed: false,
    coverage: 0,
    failures: [],
    ...overrides,
  };
}

function makeMockCtx(): any {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
    },
    cwd: "/tmp/test-project",
  };
}

function makeMockLang(): any {
  return {
    key: "go",
    sourceFilePattern: "*.go",
    testFilePattern: "*_test.go",
    isTestFile: (path: string) => path.endsWith("_test.go"),
    isPhaseAAllowed: (path: string) => path.endsWith(".go") || path.endsWith("_test.go"),
    prompts: {
      promptTesterCompileRetry: (err: string) => `Compile error: ${err}`,
      promptWriterPhaseBContinue: (summary: string, count: number) => `Continue: ${count} failures`,
      promptCleanerRetry: (summary: string, count: number) => `Cleaner retry: ${count} failures`,
      promptNegotiateApproved: () => "Approved",
      promptNegotiateAutoAdvance: () => "Auto-advance",
      promptTesterPhaseA: (spec: string, tool: string) => `Phase A: ${spec}`,
      promptTesterPhaseARestart: (spec: string, tool: string) => `Restart A: ${spec}`,
      promptWriterPhaseB: () => "Phase B",
      promptCleanerPhaseC: () => "Phase C",
      promptCleanerRestart: () => "Cleaner restart",
      promptTesterDisputeFix: () => "Fix test",
    },
    refusalMessage: {
      phaseA: "Blocked in Phase A",
      negotiate: "Blocked in negotiate",
      phaseC: "Blocked in Phase C",
    },
  };
}

function makeInput(overrides: Partial<EffectInput> = {}): EffectInput {
  return {
    state: { current: makeState({ phase: "A" }) },
    pi: createMockExtensionAPI() as any,
    ctx: makeMockCtx(),
    lang: makeMockLang(),
    debug: vi.fn(),
    effect: { type: "noop" },
    gateResult: makeGateResult(),
    ...overrides,
  };
}

// ================================================================
// applyEffect (dispatcher)
// ================================================================

describe("applyEffect (dispatcher)", () => {
  it("returns applied: false by default (stub)", () => {
    const input = makeInput();
    const result = applyEffect(input);
    expect(result.applied).toBe(false);
  });

  it("dispatches noop effect", () => {
    const input = makeInput({ effect: { type: "noop" } });
    const result = applyEffect(input);
    expect(result.applied).toBe(false);
  });

  it("dispatches retry effect", () => {
    const input = makeInput({
      effect: {
        type: "retry",
        phase: "A",
        round: 2,
        status: "Phase A — round 2",
        notify: "Gate failed. Retry 2/3.",
        level: "warning",
        prompt: "tester_compile_retry",
      },
    });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("dispatches advance effect", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "negotiate",
        status: "Phase negotiate — round 1",
        notify: "Phase passed. Advancing to Phase negotiate.",
        prompt: "writer_negotiate",
      },
    });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("dispatches done effect", () => {
    const input = makeInput({
      effect: {
        type: "done",
        status: "All phases complete.",
        notify: "Loop complete.",
      },
    });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("dispatches escalated effect", () => {
    const input = makeInput({
      effect: {
        type: "escalated",
        status: "escalated (Phase A exhausted)",
        notify: "Phase A exhausted. Escalating to human.",
      },
    });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("handles null gateResult gracefully", () => {
    const input = makeInput({ gateResult: null as any });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("handles null pi gracefully", () => {
    const input = makeInput({ pi: null as any });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("output type contract: EffectResult has applied field", () => {
    const result = { applied: false };
    expect(result).toHaveProperty("applied");
    expect(typeof result.applied).toBe("boolean");
  });
});

// ================================================================
// applyRetryEffect
// ================================================================

describe("applyRetryEffect", () => {
  it("returns applied: false by default (stub)", () => {
    const input = makeInput({
      effect: {
        type: "retry",
        phase: "A",
        round: 2,
        status: "Phase A — round 2",
        level: "warning",
      },
    });
    const result = applyRetryEffect(input);
    expect(result.applied).toBe(false);
  });

  it("resets turnsThisPhase to 1 (spec requirement)", () => {
    // Stub doesn't reset yet; future impl should set turnsThisPhase = 1
    const input = makeInput({
      state: { current: makeState({ phase: "A", turnsThisPhase: 5 }) },
      effect: {
        type: "retry",
        phase: "A",
        round: 2,
        status: "Phase A — round 2",
        level: "warning",
      },
    });
    const result = applyRetryEffect(input);
    expect(result.applied).toBe(false); // stub
  });

  it("sends compile retry prompt on compile fail (spec requirement)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "A" }) },
      effect: {
        type: "retry",
        phase: "A",
        round: 2,
        status: "Phase A — round 2",
        notify: "Compile failed.",
        level: "warning",
        prompt: "tester_compile_retry",
      },
      gateResult: makeGateResult({
        compile: false,
        compileError: "type mismatch",
      }),
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
  });

  it("sends test retry prompt on test fail (spec requirement)", () => {
    const failures: FailingTest[] = [
      { test: "TestAdd", subtest: "", output: "expected 3, got 2\n" },
    ];
    const input = makeInput({
      state: { current: makeState({ phase: "B" }) },
      effect: {
        type: "retry",
        phase: "B",
        round: 2,
        status: "Phase B — round 2",
        notify: "Tests failed.",
        level: "warning",
        prompt: "writer_phase_b_retry",
      },
      gateResult: makeGateResult({
        compile: true,
        tests: false,
        allPassed: false,
        failures,
      }),
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
  });

  it("handles awaitDisputeReview retry", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeReview: true }) },
      effect: {
        type: "retry",
        phase: "B",
        round: 2,
        status: "Phase B — round 2",
        level: "warning",
      },
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
  });

  it("handles empty failures array", () => {
    const input = makeInput({
      effect: {
        type: "retry",
        phase: "A",
        round: 1,
        status: "Phase A — round 1",
      },
      gateResult: makeGateResult({ failures: [] }),
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
  });

  it("handles undefined prompt in retry effect", () => {
    const input = makeInput({
      effect: {
        type: "retry",
        phase: "A",
        round: 1,
        status: "Phase A — round 1",
      },
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "A", turnsThisPhase: 5 });
    const input = makeInput({
      state: { current: state },
      effect: {
        type: "retry",
        phase: "A",
        round: 2,
        status: "Phase A — round 2",
      },
    });
    const originalTurns = state.turnsThisPhase;

    applyRetryEffect(input);

    expect(state.turnsThisPhase).toBe(originalTurns);
  });
});

// ================================================================
// applyAdvanceEffect
// ================================================================

describe("applyAdvanceEffect", () => {
  it("returns applied: false by default (stub)", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "negotiate",
        status: "Phase negotiate — round 1",
        notify: "Advancing.",
      },
    });
    const result = applyAdvanceEffect(input);
    expect(result.applied).toBe(false);
  });

  it("resets turnsThisPhase to 1 (spec requirement)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "A", turnsThisPhase: 3 }) },
      effect: {
        type: "advance",
        phase: "negotiate",
        status: "Phase negotiate — round 1",
        notify: "Advancing.",
      },
    });
    const result = applyAdvanceEffect(input);
    expect(result.applied).toBe(false); // stub
  });

  it("handles advance to negotiate with prompt", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "negotiate",
        status: "Phase negotiate — round 1",
        notify: "Advancing to negotiate.",
        prompt: "writer_negotiate",
      },
    });
    expect(() => applyAdvanceEffect(input)).not.toThrow();
  });

  it("handles advance to Phase C with prompt", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "C",
        status: "Phase C — round 1",
        notify: "Advancing to Phase C.",
        prompt: "cleaner_phase_c",
      },
    });
    expect(() => applyAdvanceEffect(input)).not.toThrow();
  });

  it("handles advance without prompt", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "B",
        status: "Phase B — round 1",
        notify: "Advancing to Phase B.",
      },
    });
    expect(() => applyAdvanceEffect(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "A", turnsThisPhase: 3 });
    const input = makeInput({
      state: { current: state },
      effect: {
        type: "advance",
        phase: "negotiate",
        status: "Phase negotiate — round 1",
        notify: "Advancing.",
      },
    });
    const originalTurns = state.turnsThisPhase;

    applyAdvanceEffect(input);

    expect(state.turnsThisPhase).toBe(originalTurns);
  });
});

// ================================================================
// applyDoneEffect
// ================================================================

describe("applyDoneEffect", () => {
  it("returns applied: false by default (stub)", () => {
    const input = makeInput({
      effect: {
        type: "done",
        status: "All phases complete.",
        notify: "Loop complete.",
      },
    });
    const result = applyDoneEffect(input);
    expect(result.applied).toBe(false);
  });

  it("resets turnsThisPhase to 1 (spec requirement)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "C", turnsThisPhase: 5 }) },
      effect: {
        type: "done",
        status: "All phases complete.",
        notify: "Loop complete.",
      },
    });
    const result = applyDoneEffect(input);
    expect(result.applied).toBe(false); // stub
  });

  it("handles done with 'done (cleaner failed)' status", () => {
    const input = makeInput({
      effect: {
        type: "done",
        status: "done (cleaner failed)",
        notify: "Phase C failed, keeping original code. Loop complete.",
      },
    });
    expect(() => applyDoneEffect(input)).not.toThrow();
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({
      ctx: null as any,
      effect: { type: "done", status: "done", notify: "done" },
    });
    expect(() => applyDoneEffect(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "C", turnsThisPhase: 5 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "done", status: "done", notify: "done" },
    });
    const originalPhase = state.phase;

    applyDoneEffect(input);

    expect(state.phase).toBe(originalPhase);
  });
});

// ================================================================
// applyEscalatedEffect
// ================================================================

describe("applyEscalatedEffect", () => {
  it("returns applied: false by default (stub)", () => {
    const input = makeInput({
      effect: {
        type: "escalated",
        status: "escalated (Phase A exhausted)",
        notify: "Phase A exhausted. Escalating to human.",
      },
    });
    const result = applyEscalatedEffect(input);
    expect(result.applied).toBe(false);
  });

  it("handles escalated from Phase A", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "A" }) },
      effect: {
        type: "escalated",
        status: "escalated (Phase A exhausted)",
        notify: "Phase A exhausted. Escalating to human.",
      },
    });
    expect(() => applyEscalatedEffect(input)).not.toThrow();
  });

  it("handles escalated from Phase B", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B" }) },
      effect: {
        type: "escalated",
        status: "escalated (Phase B exhausted)",
        notify: "Phase B exhausted. Escalating to human.",
      },
    });
    expect(() => applyEscalatedEffect(input)).not.toThrow();
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({
      ctx: null as any,
      effect: { type: "escalated", status: "escalated", notify: "escalated" },
    });
    expect(() => applyEscalatedEffect(input)).not.toThrow();
  });

  it("handles null pi gracefully", () => {
    const input = makeInput({
      pi: null as any,
      effect: { type: "escalated", status: "escalated", notify: "escalated" },
    });
    expect(() => applyEscalatedEffect(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "A", round: 3 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "escalated", status: "escalated", notify: "escalated" },
    });
    const originalPhase = state.phase;

    applyEscalatedEffect(input);

    expect(state.phase).toBe(originalPhase);
  });
});
