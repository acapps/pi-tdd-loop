// Contract tests for session-start handler — state restoration on reload

import { describe, it, expect, vi } from "vitest";
import { handleSessionStart } from "../../src/events/session-start";
import type { LoopState } from "../../src/types";
import type { SessionStartHandlerInput } from "../../src/events/session-start";

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

function makeMockCtx(entries: unknown[] = [], cwd = "/tmp/test"): any {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => entries,
    },
    cwd,
  };
}

function makeInput(overrides: Partial<SessionStartHandlerInput> = {}): SessionStartHandlerInput {
  return {
    state: { current: makeState() },
    ctx: makeMockCtx(),
    debug: vi.fn(),
    ...overrides,
  };
}

describe("handleSessionStart", () => {
  it("calls handleSessionStart without error", () => {
    const input = makeInput();
    expect(() => handleSessionStart(input)).not.toThrow();
  });

  it("handles empty entries array (no previous state)", () => {
    const input = makeInput({
      ctx: makeMockCtx([]),
    });
    handleSessionStart(input);
    expect(input.debug).toHaveBeenCalled();
  });

  it("handles undefined entries gracefully", () => {
    const ctx = makeMockCtx();
    ctx.sessionManager.getEntries = () => undefined as unknown as unknown[];
    const input = makeInput({ ctx });
    expect(() => handleSessionStart(input)).not.toThrow();
  });

  it("handles null cwd in context", () => {
    const ctx = makeMockCtx();
    ctx.cwd = null;
    const input = makeInput({ ctx });
    expect(() => handleSessionStart(input)).not.toThrow();
  });

  it("does not throw when state has all optional fields undefined", () => {
    const state = makeState({
      specFindings: undefined,
      awaitingReview: undefined,
      skipPhase0: undefined,
      lastGateResult: undefined,
    });
    const input = makeInput({ state: { current: state } });
    expect(() => handleSessionStart(input)).not.toThrow();
  });

  it("stub returns without side effects", () => {
    const state = makeState({ phase: "A", round: 5 });
    const ctx = makeMockCtx();
    const debug = vi.fn();
    const input = makeInput({ state: { current: state }, ctx, debug });
    const result = handleSessionStart(input);

    // Stub should not return anything meaningful yet
    expect(result).toBeUndefined();
  });

  it("calls debug with session_start message (stub)", () => {
    const debug = vi.fn();
    const input = makeInput({ debug });
    handleSessionStart(input);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("session_start"));
  });

  it("preserves original state reference (immutability check for future impl)", () => {
    const state = makeState({ phase: "B", round: 3 });
    const input = makeInput({ state: { current: state } });
    const originalPhase = state.phase;

    handleSessionStart(input);

    // Stub should not mutate state
    expect(state.phase).toBe(originalPhase);
  });
});
