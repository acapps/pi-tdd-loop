// Contract tests for the negotiate handler.
// Spec: internal/04-implement-agent-settled-handlers.md (R1, G2).
//
// Pinned contract:
//  - Pure-state: takes a BARE LoopState (R1 — no wrapper), returns
//    { handled, newState }, never mutates the input; the dispatcher
//    reassigns state.current (G2).
//  - Always handled: true. The effect is applied internally (side effects
//    allowed — pi/ctx — but the state is returned, not replaced).
//  - Reachable effects (computeNegotiateTransition): reprompt (odd/even
//    round) or advance (negotiateReprompted).

import { describe, it, expect, vi } from "vitest";
import { handleNegotiateSettled } from "../../../src/events/agent-settled/negotiate";
import type { NegotiateHandlerInput } from "../../../src/events/agent-settled/negotiate";
import type { LoopState } from "../../../src/types";
import { getLanguageConfig } from "../../../src/languages";
import * as GP from "../../../src/generic-prompts";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

// Spec 07 shim — the negotiate round markers land on LoopState in the writer
// phase; the casts keep this contract type-clean before that lands.
type NegotiateMarkers = { negotiateProposed?: boolean; negotiateFeedback?: string };

const GO = getLanguageConfig("go");

// --- Fixtures ---

function makeState(overrides: Partial<LoopState> & NegotiateMarkers = {}): LoopState {
  return {
    phase: "negotiate",
    round: 1,
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
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
    ...overrides,
  };
}

function makeInput(overrides: Partial<NegotiateHandlerInput> = {}): {
  input: NegotiateHandlerInput;
  pi: any;
  ctx: any;
  debug: ReturnType<typeof vi.fn>;
} {
  const pi = createMockExtensionAPI();
  const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getEntries: () => [] }, cwd: "/tmp/test-project" };
  const debug = vi.fn();
  const input: NegotiateHandlerInput = {
    state: makeState(),
    pi: pi as any,
    ctx,
    lang: GO,
    debug,
    ...overrides,
  };
  return { input, pi, ctx, debug };
}

/** Deep copy of the input state — proves the pure-state (no-mutation) contract. */
function cloneState(s: LoopState): LoopState {
  return JSON.parse(JSON.stringify(s));
}

// --- Reprompt path ---

describe("handleNegotiateSettled — reprompt", () => {
  it("odd round, not reprompted → writer reprompt: new state with negotiateReprompted true, input unmutated", () => {
    const state = makeState({ round: 1, negotiateReprompted: false });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    expect(result.newState).not.toBe(state);
    expect(result.newState.negotiateReprompted).toBe(true);
    expect(result.newState.round).toBe(1); // round untouched by reprompt
    expect(state).toEqual(before); // input never mutated

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateRepromptWriter());
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Writer must use negotiate_propose tool.", "warning");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("Negotiate: settle (round 1, proposed=false, feedback=false, reprompted=false)");
  });

  it("even round → tester reprompt, negotiateReprompted becomes true (row 5)", () => {
    const state = makeState({ round: 2 });
    const { input, pi, ctx, debug } = makeInput({ state });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    // Row 5 (CHANGED): the flag is now set so a never-reviewing Tester
    // auto-advances on the next settle instead of being reprompted forever.
    expect(result.newState.negotiateReprompted).toBe(true);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateRepromptTester());
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tester must use negotiate_review tool.", "warning");
    expect(debug).toHaveBeenCalledWith("Negotiate: settle (round 2, proposed=false, feedback=false, reprompted=false)");
  });

  it("round 0 (even edge) → tester reprompt", () => {
    const { input, pi } = makeInput({ state: makeState({ round: 0 }) });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateRepromptTester());
  });

  it("input state is never mutated in any path", () => {
    const state = makeState({ round: 3, negotiateReprompted: false });
    const before = cloneState(state);
    const { input } = makeInput({ state });
    handleNegotiateSettled(input);
    expect(state).toEqual(before);
  });
});

// --- Auto-advance path ---

describe("handleNegotiateSettled — auto-advance", () => {
  it("negotiateReprompted true → advance to B r1: justTransitioned set, auto-advance prompt", () => {
    const state = makeState({ round: 3, negotiateReprompted: true });
    const { input, pi, ctx, debug } = makeInput({ state });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    expect(result.newState).not.toBe(state);
    expect(result.newState.phase).toBe("B");
    expect(result.newState.round).toBe(1);
    expect(result.newState.turnsThisPhase).toBe(1);
    expect(result.newState.justTransitioned).toBe(true);
    expect(result.newState.lastPhase).toBe("negotiate");
    expect(result.newState.negotiateReprompted).toBe(false); // reset on advance

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptNegotiateAutoAdvance());
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Advancing to Phase B without explicit proposal.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1");
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      "Negotiate: settle (round 3, proposed=false, feedback=false, reprompted=true)",
      "Negotiate: auto-advancing to Phase B",
    ]);
  });

  it("auto-advance wins over the odd/even reprompt (round 1 + reprompted)", () => {
    const { input, pi } = makeInput({ state: makeState({ round: 1, negotiateReprompted: true }) });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    expect(result.newState.phase).toBe("B");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptNegotiateAutoAdvance());
  });
});

// --- Review round (rows 1–2 + newly-producible escalated) ---

describe("handleNegotiateSettled — review round", () => {
  it("review-request: one message = proposal-for-review, triggerTurn, notify, branch debug; input unmutated", () => {
    const state = makeState({ round: 1, lastProposal: "plan X", negotiateProposed: true });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    expect(result.newState.round).toBe(2); // odd → even (Tester turn)
    expect((result.newState as NegotiateMarkers).negotiateProposed).toBe(false);
    expect(result.newState.lastProposal).toBe("plan X"); // transition does not touch it
    expect(state).toEqual(before); // input never mutated

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateProposalForReview("plan X"));
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Writer proposed — Tester reviewing.", "info");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      "Negotiate: settle (round 1, proposed=true, feedback=false, reprompted=false)",
      "Negotiate: proposal → Tester review (round 2)",
    ]);
  });

  it("feedback: one message = feedback prompt, triggerTurn, notify, branch debug; input unmutated", () => {
    const state = makeState({ round: 4, negotiateFeedback: "make it faster" });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    expect(result.newState.round).toBe(5); // even → odd (Writer turn)
    expect((result.newState as NegotiateMarkers).negotiateFeedback).toBe("");
    expect(state).toEqual(before); // input never mutated

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateFeedback("make it faster"));
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tester feedback recorded — Writer revising.", "info");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      "Negotiate: settle (round 4, proposed=false, feedback=true, reprompted=false)",
      "Negotiate: feedback → Writer revision (round 5)",
    ]);
  });

  it("escalated (row 2b): notify + setStatus, no sendUserMessage", () => {
    const state = makeState({ round: 6, negotiateFeedback: "still wrong", maxNegotiate: 3 });
    const { input, pi, ctx, debug } = makeInput({ state });
    const result = handleNegotiateSettled(input);

    expect(result.handled).toBe(true);
    expect(result.newState.phase).toBe("escalated");
    expect(result.newState.lastPhase).toBe("negotiate");
    expect(result.newState.turnsThisPhase).toBe(1);

    expect(pi.sentMessages).toHaveLength(0); // escalated sends no user message
    expect(ctx.ui.notify).toHaveBeenCalledWith("Negotiation limit reached. Escalating to human.", "warning");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "escalated (Phase negotiate exhausted)");
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      "Negotiate: settle (round 6, proposed=false, feedback=true, reprompted=false)",
      "Negotiate: limit reached → escalating",
    ]);
  });

  it("empty feedback ('') means no feedback pending → even-round reprompt, not feedback effect", () => {
    const state = makeState({ round: 2, negotiateFeedback: "" });
    const { input, pi } = makeInput({ state });
    const result = handleNegotiateSettled(input);

    expect(result.newState.round).toBe(2);
    expect(result.newState.negotiateReprompted).toBe(true);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateRepromptTester());
  });
});
