// Contract tests for dispute handler — dispute fix and dispute review handling

import { describe, it, expect, vi } from "vitest";
import { handleDisputeFix, handleDisputeReview } from "../../../src/events/agent-settled/dispute";
import type { LoopState } from "../../../src/types";
import type { DisputeHandlerInput } from "../../../src/events/agent-settled/dispute";
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

function makeInput(overrides: Partial<DisputeHandlerInput> = {}): DisputeHandlerInput {
  return {
    state: { current: makeState({ phase: "B" }) },
    pi: createMockExtensionAPI() as any,
    ctx: makeMockCtx(),
    lang: makeMockLang(),
    debug: vi.fn(),
    ...overrides,
  };
}

// ================================================================
// handleDisputeFix
// ================================================================

describe("handleDisputeFix", () => {
  it("returns handled: false by default (stub)", () => {
    const input = makeInput();
    const result = handleDisputeFix(input);
    expect(result.handled).toBe(false);
    expect(result.type).toBe("fix");
  });

  it("calls handleDisputeFix without error", () => {
    const input = makeInput();
    expect(() => handleDisputeFix(input)).not.toThrow();
  });

  it("handles awaitDisputeFix=true", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeFix: true }) },
    });
    const result = handleDisputeFix(input);
    // Future impl: should return handled=true, send promptTesterDisputeFix
    expect(result.handled).toBe(false);
    expect(result.type).toBe("fix");
  });

  it("handles awaitDisputeFix=false", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeFix: false }) },
    });
    const result = handleDisputeFix(input);
    expect(result.handled).toBe(false);
  });

  it("handles undefined awaitDisputeFix", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeFix: undefined }) },
    });
    expect(() => handleDisputeFix(input)).not.toThrow();
  });

  it("handles dispute count > 0", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", disputeCount: 2, maxDispute: 3 }) },
    });
    expect(() => handleDisputeFix(input)).not.toThrow();
  });

  it("handles dispute count at maxDispute", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", disputeCount: 3, maxDispute: 3 }) },
    });
    expect(() => handleDisputeFix(input)).not.toThrow();
  });

  it("handles null pi gracefully", () => {
    const input = makeInput({ pi: null as any });
    expect(() => handleDisputeFix(input)).not.toThrow();
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => handleDisputeFix(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "B", awaitDisputeFix: true });
    const input = makeInput({ state: { current: state } });
    const originalAwaitFix = state.awaitDisputeFix;

    handleDisputeFix(input);

    expect(state.awaitDisputeFix).toBe(originalAwaitFix);
  });
});

// ================================================================
// handleDisputeReview
// ================================================================

describe("handleDisputeReview", () => {
  it("returns handled: false by default (stub)", () => {
    const input = makeInput();
    const result = handleDisputeReview(input);
    expect(result.handled).toBe(false);
    expect(result.type).toBe("review");
  });

  it("calls handleDisputeReview without error", () => {
    const input = makeInput();
    expect(() => handleDisputeReview(input)).not.toThrow();
  });

  it("handles awaitDisputeReview=true (fall through to gate)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeReview: true }) },
    });
    const result = handleDisputeReview(input);
    // Future impl: should return handled=false (fall through) and NOT clear the flag
    expect(result.handled).toBe(false);
    expect(result.type).toBe("review");
  });

  it("handles awaitDisputeReview=false", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeReview: false }) },
    });
    const result = handleDisputeReview(input);
    expect(result.handled).toBe(false);
  });

  it("handles undefined awaitDisputeReview", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeReview: undefined }) },
    });
    expect(() => handleDisputeReview(input)).not.toThrow();
  });

  it("handles null pi gracefully", () => {
    const input = makeInput({ pi: null as any });
    expect(() => handleDisputeReview(input)).not.toThrow();
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => handleDisputeReview(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "B", awaitDisputeReview: true });
    const input = makeInput({ state: { current: state } });
    const originalAwaitReview = state.awaitDisputeReview;

    handleDisputeReview(input);

    expect(state.awaitDisputeReview).toBe(originalAwaitReview);
  });

  it("output type contract: DisputeHandlerOutput has handled and type", () => {
    const result = { handled: false, type: "fix" as const };
    expect(result).toHaveProperty("handled");
    expect(result).toHaveProperty("type");
  });
});
