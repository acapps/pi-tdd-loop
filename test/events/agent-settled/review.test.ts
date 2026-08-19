// Contract tests for the review handler (Phase 0).
// Spec: internal/04-implement-agent-settled-handlers.md
//
// Pinned contract:
//  - !awaitingReview (false OR undefined) → handled: false, zero side effects.
//  - awaitingReview → notify + status + persist loop-state entry, handled: true.
//  - Never advances, never sends a user message — waits for the human
//    (/loop-approve) or the tools (negotiate_propose).
//  - Takes an unused lang param (dead parameter, preserved for monolith parity).

import { describe, it, expect, vi } from "vitest";
import { handleReviewSettled } from "../../../src/events/agent-settled/review";
import type { ReviewHandlerInput } from "../../../src/events/agent-settled/review";
import type { LoopState } from "../../../src/types";
import { getLanguageConfig } from "../../../src/languages";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

const GO = getLanguageConfig("go");

// --- Fixtures ---

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "review",
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

function makeInput(overrides: Partial<ReviewHandlerInput> = {}): {
  input: ReviewHandlerInput;
  pi: any;
  ctx: any;
  debug: ReturnType<typeof vi.fn>;
} {
  const pi = createMockExtensionAPI();
  const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getEntries: () => [] }, cwd: "/tmp/test-project" };
  const debug = vi.fn();
  const input: ReviewHandlerInput = {
    state: { current: makeState() },
    pi: pi as any,
    ctx,
    lang: GO,
    debug,
    ...overrides,
  };
  return { input, pi, ctx, debug };
}

/** Deep copy — proves the no-mutation contract. */
function cloneState(s: LoopState): LoopState {
  return JSON.parse(JSON.stringify(s));
}

// --- Unhandled path ---

describe("handleReviewSettled — unhandled", () => {
  it("awaitingReview false → handled false, zero side effects", () => {
    const state = makeState({ awaitingReview: false });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(false);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(pi.appendedEntries).toHaveLength(0);
    expect(pi.sentMessages).toHaveLength(0);
    expect(debug).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it("awaitingReview undefined (edge) → handled false", () => {
    const { input, pi, ctx } = makeInput({ state: { current: makeState() } }); // awaitingReview absent
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(false);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(pi.appendedEntries).toHaveLength(0);
  });
});

// --- Handled path ---

describe("handleReviewSettled — handled", () => {
  it("awaitingReview true → handled: notify + status + loop-state entry, no user message", () => {
    const state = makeState({ phase: "review", round: 0, awaitingReview: true, disputeCount: 1 });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(debug).toHaveBeenCalledWith("Phase 0 review: agent settled, awaiting human /loop-approve");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase 0 — review pending");
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.appendedEntries[0].data).not.toBe(state); // spread copy, not the live object
    expect(pi.appendedEntries[0].data.phase).toBe("review");
    expect(pi.appendedEntries[0].data.disputeCount).toBe(1);
    expect(pi.sentMessages).toHaveLength(0); // waits for the human — no agent turn
    expect(state).toEqual(before); // no mutation
  });
});
