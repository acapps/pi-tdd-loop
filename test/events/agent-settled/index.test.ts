// Contract tests for agent-settled dispatcher — routes to phase handler

import { describe, it, expect, vi } from "vitest";
import { handleAgentSettled } from "../../../src/events/agent-settled/index";
import type { LoopState } from "../../../src/types";
import type { AgentSettledDispatcherInput } from "../../../src/events/agent-settled/index";
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

function makeInput(overrides: Partial<AgentSettledDispatcherInput> = {}): AgentSettledDispatcherInput {
  return {
    state: { current: makeState() },
    pi: createMockExtensionAPI() as any,
    debug: vi.fn(),
    ctx: makeMockCtx(),
    ...overrides,
  };
}

describe("handleAgentSettled (dispatcher)", () => {
  it("returns undefined for idle phase (terminal)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "idle" }) } });
    const result = handleAgentSettled(input);
    expect(result).toBeUndefined();
  });

  it("returns undefined for done phase (terminal)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "done" }) } });
    const result = handleAgentSettled(input);
    expect(result).toBeUndefined();
  });

  it("returns undefined for escalated phase (terminal)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "escalated" }) } });
    const result = handleAgentSettled(input);
    expect(result).toBeUndefined();
  });

  it("calls handleAgentSettled without error for any phase", () => {
    const phases: LoopState["phase"][] = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"];
    for (const phase of phases) {
      const input = makeInput({ state: { current: makeState({ phase }) } });
      expect(() => handleAgentSettled(input)).not.toThrow();
    }
  });

  it("handles review phase (should route to review handler)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "review" }) } });
    const result = handleAgentSettled(input);
    // Stub returns undefined; future impl routes to handleReviewSettled
    expect(result).toBeUndefined();
  });

  it("handles negotiate phase (should route to negotiate handler)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "negotiate" }) } });
    const result = handleAgentSettled(input);
    // Stub returns undefined; future impl routes to handleNegotiateSettled
    expect(result).toBeUndefined();
  });

  it("handles Phase A (should route to gate-transition handler)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "A" }) } });
    const result = handleAgentSettled(input);
    // Stub returns undefined; future impl routes to handleGateTransition
    expect(result).toBeUndefined();
  });

  it("handles Phase B (should route to gate-transition handler)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "B" }) } });
    const result = handleAgentSettled(input);
    expect(result).toBeUndefined();
  });

  it("handles Phase C (should route to gate-transition handler)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "C" }) } });
    const result = handleAgentSettled(input);
    expect(result).toBeUndefined();
  });

  it("handles loop escalation check (turnsThisPhase > maxTurnsPerPhase)", () => {
    const input = makeInput({
      state: {
        current: makeState({
          phase: "A",
          turnsThisPhase: 6,
          maxTurnsPerPhase: 5,
        }),
      },
    });
    expect(() => handleAgentSettled(input)).not.toThrow();
    // Future impl: should escalate to "escalated" phase
  });

  it("handles justTransitioned flag", () => {
    const input = makeInput({
      state: {
        current: makeState({
          phase: "B",
          round: 1,
          justTransitioned: true,
        }),
      },
    });
    expect(() => handleAgentSettled(input)).not.toThrow();
    // Future impl: should clear flag and trigger Writer turn
  });

  it("handles awaitDisputeFix flag", () => {
    const input = makeInput({
      state: {
        current: makeState({
          phase: "B",
          awaitDisputeFix: true,
        }),
      },
    });
    expect(() => handleAgentSettled(input)).not.toThrow();
    // Future impl: should route to handleDisputeFix
  });

  it("handles awaitDisputeReview flag", () => {
    const input = makeInput({
      state: {
        current: makeState({
          phase: "B",
          awaitDisputeReview: true,
        }),
      },
    });
    expect(() => handleAgentSettled(input)).not.toThrow();
    // Future impl: should route to handleDisputeReview, fall through to gate
  });

  it("handles awaitingReview flag in review phase", () => {
    const input = makeInput({
      state: {
        current: makeState({
          phase: "review",
          awaitingReview: true,
        }),
      },
    });
    expect(() => handleAgentSettled(input)).not.toThrow();
    // Future impl: should route to handleReviewSettled
  });

  it("handles null ctx gracefully", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => handleAgentSettled(input)).not.toThrow();
  });

  it("handles null pi gracefully", () => {
    const input = makeInput({ pi: null as any });
    expect(() => handleAgentSettled(input)).not.toThrow();
  });

  it("handles null debug gracefully", () => {
    const input = makeInput({ debug: null as any });
    expect(() => handleAgentSettled(input)).not.toThrow();
  });

  it("stub does not mutate state", () => {
    const state = makeState({ phase: "A", round: 1 });
    const input = makeInput({ state: { current: state } });
    const originalPhase = state.phase;

    handleAgentSettled(input);

    expect(state.phase).toBe(originalPhase);
  });

  it("output type contract: returns boolean | undefined", () => {
    const input = makeInput();
    const result = handleAgentSettled(input);
    // Stub returns undefined; future impl returns true/false for handled/not-handled
    expect(result === undefined || typeof result === "boolean").toBe(true);
  });
});
