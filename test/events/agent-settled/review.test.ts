// Contract tests for the review handler (Phase 0).
// Spec: internal/04-implement-agent-settled-handlers.md
// Auto-approve: internal/phase0-auto-approve.md
//
// Pinned contract (5-row decision table, first-match-wins):
//  1. !awaitingReview → handled: false, zero side effects.
//  2. autoApprove === false → notify + wait for human.
//  3. lastProposal non-empty (feedback) → notify + wait for human.
//  4. dispute filed/in-review → notify + wait for human.
//  5. clean review, auto-approve on → auto-advance to Phase A.

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
    gateTimeoutSec: 60,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false,
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

// --- Row 1: unhandled ---

describe("handleReviewSettled — row 1: unhandled", () => {
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

// --- Row 2: --no-auto-approve ---

describe("handleReviewSettled — row 2: auto-approve disabled", () => {
  it("autoApprove false → notify + wait, no phase change", () => {
    const state = makeState({ awaitingReview: true, autoApprove: false });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(debug).toHaveBeenCalledWith("Phase 0 review: auto-approve disabled, awaiting human /loop-approve");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase 0 — review pending");
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.sentMessages).toHaveLength(0);
    expect(state).toEqual(before); // no mutation
  });

  it("autoApprove false with clean review → still waits (guard takes precedence)", () => {
    const state = makeState({ awaitingReview: true, autoApprove: false, lastProposal: "" });
    const before = cloneState(state);
    const { input, pi, ctx } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
    expect(state).toEqual(before); // no mutation
  });
});

// --- Row 3: feedback recorded ---

describe("handleReviewSettled — row 3: feedback recorded", () => {
  it("lastProposal non-empty → notify + wait, no phase change", () => {
    const state = makeState({ awaitingReview: true, lastProposal: "spec is unclear on edge case X" });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(debug).toHaveBeenCalledWith("Phase 0 review: feedback recorded, awaiting human /loop-approve");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Feedback recorded. Use /loop-approve to proceed.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase 0 — review pending");
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.sentMessages).toHaveLength(0);
    expect(state).toEqual(before); // no mutation
  });

  it("lastProposal non-empty with autoApprove false → row 2 takes precedence", () => {
    const state = makeState({ awaitingReview: true, autoApprove: false, lastProposal: "some feedback" });
    const { input, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    // Row 2 fires before row 3
    expect(debug).toHaveBeenCalledWith("Phase 0 review: auto-approve disabled, awaiting human /loop-approve");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
  });
});

// --- Row 4: dispute pending ---

describe("handleReviewSettled — row 4: dispute pending", () => {
  it("dispute filed → notify + wait, no phase change", () => {
    const state = makeState({
      awaitingReview: true,
      dispute: { status: "filed", filer: "tester", claim: "test is wrong", filedRound: 1 },
    });
    const before = cloneState(state);
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(debug).toHaveBeenCalledWith("Phase 0 review: dispute pending, awaiting human /loop-approve");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Dispute pending. Use /loop-approve to proceed.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase 0 — review pending");
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.sentMessages).toHaveLength(0);
    expect(state).toEqual(before); // no mutation
  });

  it("dispute in-review → notify + wait, no phase change", () => {
    const state = makeState({
      awaitingReview: true,
      dispute: { status: "in-review", filer: "tester", claim: "test is wrong", filedRound: 1 },
    });
    const before = cloneState(state);
    const { input, pi, ctx } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Dispute pending. Use /loop-approve to proceed.", "info");
    expect(state).toEqual(before); // no mutation
  });

  it("dispute none → falls through to row 5 (auto-advance)", () => {
    const state = makeState({
      awaitingReview: true,
      dispute: { status: "none" },
    });
    const { input, pi, ctx } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    // Row 5: auto-advance
    expect(state.phase).toBe("A");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Clean review — auto-advancing to Phase A.", "info");
  });
});

// --- Row 5: clean review, auto-approve on ---

describe("handleReviewSettled — row 5: auto-advance", () => {
  it("clean review, autoApprove undefined (default true) → Phase A", () => {
    const state = makeState({ awaitingReview: true });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(debug).toHaveBeenCalledWith("Phase 0 auto-approve → Phase A, round 1");
    expect(state.phase).toBe("A");
    expect(state.round).toBe(1);
    expect(state.awaitingReview).toBe(false);
    expect(state.turnsThisPhase).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Clean review — auto-advancing to Phase A.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase A — round 1");
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.appendedEntries[0].data.phase).toBe("A");
    // Phase A prompt sent
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("clean review, autoApprove true explicitly → Phase A", () => {
    const state = makeState({ awaitingReview: true, autoApprove: true });
    const { input, pi, ctx } = makeInput({ state: { current: state } });
    const result = handleReviewSettled(input);

    expect(result.handled).toBe(true);
    expect(state.phase).toBe("A");
    expect(state.round).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Clean review — auto-advancing to Phase A.", "info");
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("auto-advance commits the advanced state (phase A, round 1)", () => {
    const state = makeState({ awaitingReview: true, disputeCount: 2 });
    const { input, pi } = makeInput({ state: { current: state } });
    handleReviewSettled(input);

    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].data.phase).toBe("A");
    expect(pi.appendedEntries[0].data.round).toBe(1);
    expect(pi.appendedEntries[0].data.disputeCount).toBe(2);
  });

  it("auto-advance sends the Phase A prompt with workspace root", () => {
    const state = makeState({ awaitingReview: true, specPath: "internal/test-spec.md" });
    const { input, pi } = makeInput({ state: { current: state } });
    handleReviewSettled(input);

    expect(pi.sentMessages).toHaveLength(1);
    // The prompt should mention the spec path
    expect(pi.sentMessages[0].content).toContain("internal/test-spec.md");
  });
});
