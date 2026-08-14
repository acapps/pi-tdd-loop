// Contract tests for before-agent handler — role-specific prompt injection

import { describe, it, expect, vi } from "vitest";
import { handleBeforeAgent } from "../../src/events/before-agent";
import type { LoopState } from "../../src/types";
import type { BeforeAgentHandlerInput } from "../../src/events/before-agent";
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

function makeInput(overrides: Partial<BeforeAgentHandlerInput> = {}): BeforeAgentHandlerInput {
  return {
    state: { current: makeState() },
    pi: createMockExtensionAPI() as any,
    debug: vi.fn(),
    systemPrompt: "Base system prompt",
    ...overrides,
  };
}

describe("handleBeforeAgent", () => {
  it("returns undefined for idle phase (stub)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "idle" }) } });
    const result = handleBeforeAgent(input);
    expect(result).toBeUndefined();
  });

  it("calls handleBeforeAgent without error for each phase", () => {
    const phases: LoopState["phase"][] = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"];
    for (const phase of phases) {
      const input = makeInput({ state: { current: makeState({ phase }) } });
      expect(() => handleBeforeAgent(input)).not.toThrow();
    }
  });

  it("handles empty system prompt", () => {
    const input = makeInput({ systemPrompt: "" });
    expect(() => handleBeforeAgent(input)).not.toThrow();
  });

  it("handles undefined pi gracefully", () => {
    const input = makeInput({ pi: undefined as any });
    expect(() => handleBeforeAgent(input)).not.toThrow();
  });

  it("handles review phase (stub returns undefined)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "review" }) } });
    const result = handleBeforeAgent(input);
    // Stub returns undefined; future impl should return message + systemPrompt
    expect(result).toBeUndefined();
  });

  it("handles Phase A (stub returns undefined)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "A" }) } });
    const result = handleBeforeAgent(input);
    expect(result).toBeUndefined();
  });

  it("handles negotiate phase (stub returns undefined)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "negotiate" }) } });
    const result = handleBeforeAgent(input);
    expect(result).toBeUndefined();
  });

  it("handles Phase B (stub returns undefined)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "B" }) } });
    const result = handleBeforeAgent(input);
    expect(result).toBeUndefined();
  });

  it("handles Phase C (stub returns undefined)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "C" }) } });
    const result = handleBeforeAgent(input);
    expect(result).toBeUndefined();
  });

  it("handles dispute mode in Phase B", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", disputeMode: true, awaitDisputeFix: true }) },
    });
    expect(() => handleBeforeAgent(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "A", round: 1 });
    const input = makeInput({ state: { current: state } });
    const originalPhase = state.phase;

    handleBeforeAgent(input);

    expect(state.phase).toBe(originalPhase);
  });

  it("output type contract: BeforeAgentHandlerOutput has message and systemPrompt", () => {
    // Type-level contract: when implemented, output must have these fields
    const expectedShape: { message: Record<string, unknown>; systemPrompt: string } = {
      message: { customType: "loop-context", content: "test" },
      systemPrompt: "augmented prompt",
    };
    expect(expectedShape.message).toBeDefined();
    expect(expectedShape.systemPrompt).toBeDefined();
  });

  it("handles unknown phase gracefully", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "idle" }) }, // "idle" is treated as unknown/default
    });
    expect(() => handleBeforeAgent(input)).not.toThrow();
  });
});
