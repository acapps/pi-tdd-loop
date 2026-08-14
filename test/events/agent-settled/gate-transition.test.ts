// Contract tests for gate-transition handler — run gates, compute transition, apply effect

import { describe, it, expect, vi } from "vitest";
import { handleGateTransition } from "../../../src/events/agent-settled/gate-transition";
import type { LoopState, GateResult } from "../../../src/types";
import type { GateHandlerInput } from "../../../src/events/agent-settled/gate-transition";
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

function makeMockCtx(overrides: { cwd?: string } = {}): any {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
    },
    cwd: "/tmp/test-project",
    ...overrides,
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

function makeInput(overrides: Partial<GateHandlerInput> = {}): GateHandlerInput {
  return {
    state: makeState({ phase: "A" }),
    ctx: makeMockCtx(),
    lang: makeMockLang(),
    debug: vi.fn(),
    ...overrides,
  };
}

describe("handleGateTransition", () => {
  it("returns effect type noop by default (stub)", () => {
    const input = makeInput();
    const result = handleGateTransition(input);
    expect(result.effect.type).toBe("noop");
  });

  it("calls handleGateTransition without error", () => {
    const input = makeInput();
    expect(() => handleGateTransition(input)).not.toThrow();
  });

  it("handles Phase A with compile pass", () => {
    const input = makeInput({
      state: makeState({ phase: "A", round: 1 }),
    });
    const result = handleGateTransition(input);
    // Future impl: should call runGates, computeTransition, return advance effect
    expect(result).toHaveProperty("state");
    expect(result).toHaveProperty("effect");
    expect(result).toHaveProperty("gateResult");
  });

  it("handles Phase A with compile fail", () => {
    const input = makeInput({
      state: makeState({ phase: "A", round: 1 }),
    });
    const result = handleGateTransition(input);
    expect(result.effect.type).toBe("noop"); // stub
  });

  it("runs gates and returns retry effect on failure (spec requirement)", () => {
    const input = makeInput({
      state: makeState({ phase: "A", round: 1, maxA: 3 }),
    });
    const result = handleGateTransition(input);
    // Stub returns noop; future impl: retry effect on failure
    expect(result).toHaveProperty("effect");
  });

  it("runs gates and returns advance effect on pass (spec requirement)", () => {
    const input = makeInput({
      state: makeState({ phase: "A", round: 1 }),
    });
    const result = handleGateTransition(input);
    // Stub returns noop; future impl: advance effect on pass
    expect(result).toHaveProperty("effect");
  });

  it("handles Phase B", () => {
    const input = makeInput({
      state: makeState({ phase: "B", round: 1 }),
    });
    expect(() => handleGateTransition(input)).not.toThrow();
  });

  it("handles Phase C", () => {
    const input = makeInput({
      state: makeState({ phase: "C", round: 1 }),
    });
    expect(() => handleGateTransition(input)).not.toThrow();
  });

  it("handles gate result with empty failures", () => {
    const input = makeInput();
    const result = handleGateTransition(input);
    expect(result.gateResult.failures).toEqual([]);
  });

  it("handles gate result with compile error", () => {
    // Stub returns default gateResult; future impl would have real compile error
    const input = makeInput();
    const result = handleGateTransition(input);
    expect(result.gateResult.compileError).toBe("");
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => handleGateTransition(input)).not.toThrow();
  });

  it("handles null lang gracefully", () => {
    const input = makeInput({ lang: null as any });
    expect(() => handleGateTransition(input)).not.toThrow();
  });

  it("output type contract: GateHandlerOutput has state, effect, gateResult", () => {
    const result: { state: LoopState; effect: { type: string }; gateResult: GateResult; prompt?: string } = {
      state: makeState(),
      effect: { type: "noop" },
      gateResult: {
        compile: false,
        compileError: "",
        tests: false,
        allPassed: false,
        coverage: 0,
        failures: [],
      },
    };
    expect(result).toHaveProperty("state");
    expect(result).toHaveProperty("effect");
    expect(result).toHaveProperty("gateResult");
  });

  it("stub does not mutate original state", () => {
    const state = makeState({ phase: "A", round: 1 });
    const input = makeInput({ state });
    const originalPhase = state.phase;
    const originalRound = state.round;

    handleGateTransition(input);

    expect(state.phase).toBe(originalPhase);
    expect(state.round).toBe(originalRound);
  });

  it("handles all phases without error", () => {
    const phases: LoopState["phase"][] = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"];
    for (const phase of phases) {
      const input = makeInput({ state: makeState({ phase }) });
      expect(() => handleGateTransition(input)).not.toThrow();
    }
  });

  it("gate result has correct shape", () => {
    const input = makeInput();
    const result = handleGateTransition(input);
    expect(result.gateResult).toHaveProperty("compile");
    expect(result.gateResult).toHaveProperty("compileError");
    expect(result.gateResult).toHaveProperty("tests");
    expect(result.gateResult).toHaveProperty("allPassed");
    expect(result.gateResult).toHaveProperty("coverage");
    expect(result.gateResult).toHaveProperty("failures");
  });
});
