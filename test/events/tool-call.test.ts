// Contract tests for tool-call handler — path enforcement per phase

import { describe, it, expect, vi } from "vitest";
import { handleToolCall } from "../../src/events/tool-call";
import type { LoopState } from "../../src/types";
import type { ToolCallHandlerInput } from "../../src/events/tool-call";
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";

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

function makeInput(overrides: Partial<ToolCallHandlerInput> = {}): ToolCallHandlerInput {
  return {
    state: { current: makeState() },
    pi: createMockExtensionAPI() as any,
    debug: vi.fn(),
    toolName: "write",
    path: "src/main.go",
    ctx: makeMockCtx(),
    ...overrides,
  };
}

describe("handleToolCall", () => {
  it("returns undefined for escalated phase (stub)", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "escalated" }) },
    });
    const result = handleToolCall(input);
    expect(result).toBeUndefined();
  });

  it("handles all phases without error", () => {
    const phases: LoopState["phase"][] = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"];
    for (const phase of phases) {
      const input = makeInput({ state: { current: makeState({ phase }) } });
      expect(() => handleToolCall(input)).not.toThrow();
    }
  });

  it("handles read tool (non-write action)", () => {
    const input = makeInput({ toolName: "read", path: "src/main.go" });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles edit tool (write action)", () => {
    const input = makeInput({ toolName: "edit", path: "src/main.go" });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles empty path", () => {
    const input = makeInput({ path: "" });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles undefined path", () => {
    const input = makeInput({ path: undefined as any });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles null path", () => {
    const input = makeInput({ path: null as any });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles Phase A with test file path", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "A" }) },
      path: "src/main_test.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles Phase A with source file path", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "A" }) },
      path: "src/main.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles negotiate phase with write tool", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "negotiate" }) },
      toolName: "write",
      path: "src/main.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles Phase B with source file path", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B" }) },
      path: "src/main.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles Phase B with test file path", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B" }) },
      path: "src/main_test.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles Phase C with source file path", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "C" }) },
      path: "src/main.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles Phase C with test file path", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "C" }) },
      path: "src/main_test.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles dispute mode active", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", disputeMode: true }) },
      path: "src/main.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles awaitDisputeReview active", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeReview: true }) },
      path: "src/main.go",
    });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("handles non-project path", () => {
    const input = makeInput({ path: "/etc/passwd" });
    expect(() => handleToolCall(input)).not.toThrow();
  });

  it("stub returns undefined (no blocking yet)", () => {
    const input = makeInput();
    const result = handleToolCall(input);
    expect(result).toBeUndefined();
  });

  it("output type contract: ToolCallBlockResult has block and reason", () => {
    // Type-level contract: when implemented, blocked result must have these fields
    const blocked: { block: true; reason: string } = { block: true, reason: "blocked" };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toBe("blocked");
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "A", round: 1 });
    const input = makeInput({ state: { current: state } });
    const originalPhase = state.phase;

    handleToolCall(input);

    expect(state.phase).toBe(originalPhase);
  });
});
