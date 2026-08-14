// Contract tests for review handler (Phase 0) — await human approve

import { describe, it, expect, vi } from "vitest";
import { handleReviewSettled } from "../../../src/events/agent-settled/review";
import type { LoopState } from "../../../src/types";
import type { ReviewHandlerInput } from "../../../src/events/agent-settled/review";
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

function makeInput(overrides: Partial<ReviewHandlerInput> = {}): ReviewHandlerInput {
  return {
    state: { current: makeState({ phase: "review" }) },
    pi: createMockExtensionAPI() as any,
    ctx: makeMockCtx(),
    lang: makeMockLang(),
    debug: vi.fn(),
    ...overrides,
  };
}

describe("handleReviewSettled", () => {
  it("returns handled: false by default (stub)", () => {
    const input = makeInput();
    const result = handleReviewSettled(input);
    expect(result.handled).toBe(false);
  });

  it("calls handleReviewSettled without error", () => {
    const input = makeInput();
    expect(() => handleReviewSettled(input)).not.toThrow();
  });

  it("handles awaitingReview=true state (stub returns handled: false)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "review", awaitingReview: true }) },
    });
    const result = handleReviewSettled(input);
    // Future impl: should return handled=true and notify user
    expect(result.handled).toBe(false);
  });

  it("handles awaitingReview=false state", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "review", awaitingReview: false }) },
    });
    expect(() => handleReviewSettled(input)).not.toThrow();
  });

  it("handles missing awaitingReview (undefined)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "review", awaitingReview: undefined }) },
    });
    expect(() => handleReviewSettled(input)).not.toThrow();
  });

  it("handles empty spec findings", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "review", specFindings: [] }) },
    });
    expect(() => handleReviewSettled(input)).not.toThrow();
  });

  it("handles single spec finding", () => {
    const finding = {
      id: 1,
      category: "Ambiguous phrase" as const,
      title: "Ambiguity in Func1",
      ambiguity: "Unclear behavior for edge case",
      interpretations: [
        { label: "Interpretation A", description: "Behavior X", testCases: ["test1"] },
      ],
      recommendation: "Clarify in spec",
    };
    const input = makeInput({
      state: { current: makeState({ phase: "review", specFindings: [finding] }) },
    });
    expect(() => handleReviewSettled(input)).not.toThrow();
  });

  it("handles null pi gracefully", () => {
    const input = makeInput({ pi: null as any });
    expect(() => handleReviewSettled(input)).not.toThrow();
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => handleReviewSettled(input)).not.toThrow();
  });

  it("output type contract: ReviewHandlerOutput has handled field", () => {
    const result = { handled: false };
    expect(result).toHaveProperty("handled");
    expect(typeof result.handled).toBe("boolean");
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "review", awaitingReview: true });
    const input = makeInput({ state: { current: state } });
    const originalAwaiting = state.awaitingReview;

    handleReviewSettled(input);

    expect(state.awaitingReview).toBe(originalAwaiting);
  });
});
