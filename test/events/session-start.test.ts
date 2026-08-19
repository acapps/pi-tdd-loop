// Contract tests for session-start handler — state restoration on reload

import { describe, it, expect, vi } from "vitest";
import { handleSessionStart } from "../../src/events/session-start";
import type { LoopState } from "../../src/types";
import type { SessionStartHandlerInput } from "../../src/events/session-start";

// Spec 07 shim — the negotiate round markers land on LoopState in the writer
// phase; the cast keeps this contract type-clean before that lands.
type NegotiateMarkers = { negotiateProposed?: boolean; negotiateFeedback?: string };

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

  it("heals a pre-feature restored entry lacking the negotiate markers (defined, not undefined)", () => {
    const saved = makeState({ phase: "negotiate", round: 2 });
    // Simulate a session entry saved before the feature: the optional fields are absent.
    delete (saved as any).negotiateProposed;
    delete (saved as any).negotiateFeedback;
    // Spec 09: the dispute delivery fields are absent too.
    delete (saved as any).disputeDefended;
    delete (saved as any).awaitWriterConcedeFix;
    delete (saved as any).disputeFiler;
    const ctx = makeMockCtx([
      { type: "custom", customType: "loop-state", data: saved },
    ]);
    const input = makeInput({ ctx });

    handleSessionStart(input);

    // clearTransientFlags must define both markers so the transition's
    // `=== true` / `!== ""` checks see a definite value after restore.
    const healed = input.state.current as NegotiateMarkers;
    expect(healed.negotiateProposed).toBe(false);
    expect(healed.negotiateFeedback).toBe("");
    expect(input.state.current.phase).toBe("negotiate");

    // Spec 09: the three new dispute fields are cleared by clearTransientFlags.
    expect(input.state.current.disputeDefended).toBeUndefined();
    expect(input.state.current.awaitWriterConcedeFix).toBe(false);
    expect(input.state.current.disputeFiler).toBeUndefined();
  });

  it("clears the spec 09 dispute fields even when saved with pending values", () => {
    const saved = makeState({
      phase: "B",
      round: 2,
      disputeDefended: "defense text",
      awaitWriterConcedeFix: true,
      disputeFiler: "tester",
    });
    const ctx = makeMockCtx([
      { type: "custom", customType: "loop-state", data: saved },
    ]);
    const input = makeInput({ ctx });

    handleSessionStart(input);

    expect(input.state.current.disputeDefended).toBeUndefined();
    expect(input.state.current.awaitWriterConcedeFix).toBe(false);
    expect(input.state.current.disputeFiler).toBeUndefined();
  });
});
