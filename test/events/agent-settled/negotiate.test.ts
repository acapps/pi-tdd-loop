// Contract tests for negotiate handler — reprompt / auto-advance to Phase B

import { describe, it, expect, vi } from "vitest";
import { handleNegotiateSettled } from "../../../src/events/agent-settled/negotiate";
import type { LoopState } from "../../../src/types";
import type { NegotiateHandlerInput } from "../../../src/events/agent-settled/negotiate";
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

function makeInput(overrides: Partial<NegotiateHandlerInput> = {}): NegotiateHandlerInput {
  return {
    state: { current: makeState({ phase: "negotiate" }) },
    pi: createMockExtensionAPI() as any,
    ctx: makeMockCtx(),
    lang: makeMockLang(),
    debug: vi.fn(),
    ...overrides,
  };
}

describe("handleNegotiateSettled", () => {
  it("returns handled: false by default (stub)", () => {
    const input = makeInput();
    const result = handleNegotiateSettled(input);
    expect(result.handled).toBe(false);
    expect(result.newState).toBe(input.state.current);
  });

  it("calls handleNegotiateSettled without error", () => {
    const input = makeInput();
    expect(() => handleNegotiateSettled(input)).not.toThrow();
  });

  it("handles odd round (Writer turn, first settle)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "negotiate", round: 1 }) },
    });
    const result = handleNegotiateSettled(input);
    // Future impl: should return reprompt effect for Writer
    expect(result.handled).toBe(false);
  });

  it("handles even round (Tester turn, first settle)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "negotiate", round: 2 }) },
    });
    const result = handleNegotiateSettled(input);
    // Future impl: should return reprompt effect for Tester
    expect(result.handled).toBe(false);
  });

  it("handles negotiateReprompted=true (auto-advance to Phase B)", () => {
    const input = makeInput({
      state: {
        current: makeState({
          phase: "negotiate",
          round: 1,
          negotiateReprompted: true,
        }),
      },
    });
    const result = handleNegotiateSettled(input);
    // Future impl: should return advance effect, newState.phase = "B"
    expect(result.handled).toBe(false);
  });

  it("handles round 0 (even, Tester turn)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "negotiate", round: 0 }) },
    });
    expect(() => handleNegotiateSettled(input)).not.toThrow();
  });

  it("handles maxNegotiate rounds", () => {
    const input = makeInput({
      state: {
        current: makeState({
          phase: "negotiate",
          round: 3,
          maxNegotiate: 3,
        }),
      },
    });
    expect(() => handleNegotiateSettled(input)).not.toThrow();
  });

  it("handles null pi gracefully", () => {
    const input = makeInput({ pi: null as any });
    expect(() => handleNegotiateSettled(input)).not.toThrow();
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => handleNegotiateSettled(input)).not.toThrow();
  });

  it("handles undefined lang gracefully", () => {
    const input = makeInput({ lang: undefined as any });
    expect(() => handleNegotiateSettled(input)).not.toThrow();
  });

  it("output type contract: NegotiateHandlerOutput has handled and newState", () => {
    const result: { handled: boolean; newState: LoopState } = {
      handled: false,
      newState: makeState(),
    };
    expect(result).toHaveProperty("handled");
    expect(result).toHaveProperty("newState");
  });

  it("stub does not mutate original state", () => {
    const state = makeState({ phase: "negotiate", round: 1 });
    const input = makeInput({ state: { current: state } });
    const originalPhase = state.phase;
    const originalRound = state.round;

    handleNegotiateSettled(input);

    expect(state.phase).toBe(originalPhase);
    expect(state.round).toBe(originalRound);
  });
});
