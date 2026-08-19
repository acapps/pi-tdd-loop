// Contract tests for the dispute handlers — review scheduling + follow-up delivery.
// Spec: internal/09-wire-dispute-review.md (Tables 1, 3; Filer routing invariant).
//
// Pinned contract:
//  - handleDisputeFix: { state, pi, ctx, lang } — debug is OPTIONAL (R2). No state
//    mutation, no flag clearing (the flag is cleared at prompt-build time, spec 03).
//  - handleDisputeReview (Table 1, rewritten):
//      row 0: flag false → { handled: false, type: "review" }, zero side effects.
//      row 1: flag true → reviewer-addressed prompt (filer "writer" → Tester,
//        filer "tester" → Writer), flag CLEARED this settle, one loop-state entry,
//        status set, { handled: true, type: "review" } — the gate does NOT run
//        this settle (the review turn runs first).
//  - handleDisputeDefend (Table 3 row 1): condition disputeDefended !== undefined;
//    prompt routed by the RECORDED disputeFiler (never re-derived); clears
//    disputeDefended AND disputeFiler; one loop-state entry;
//    { handled: true, type: "defend" }.
//  - handleWriterConcedeFix (Table 3 row 2): condition awaitWriterConcedeFix ===
//    true; promptWriterConcedeFix(lastProposal); clears awaitWriterConcedeFix AND
//    disputeFiler (N2); one loop-state entry; { handled: true, type: "writer-fix" }.
//  - DisputeHandlerOutput.type union: "fix" | "review" | "defend" | "writer-fix".

import { describe, it, expect, vi } from "vitest";
import {
  handleDisputeFix,
  handleDisputeReview,
  handleDisputeDefend,
  handleWriterConcedeFix,
} from "../../../src/events/agent-settled/dispute";
import type { DisputeHandlerInput } from "../../../src/events/agent-settled/dispute";
import type { LoopState } from "../../../src/types";
import { getLanguageConfig } from "../../../src/languages";
import * as GP from "../../../src/generic-prompts";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

const GO = getLanguageConfig("go");

// --- Fixtures ---

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
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

function makeInput(overrides: Partial<DisputeHandlerInput> = {}): {
  input: DisputeHandlerInput;
  pi: any;
  ctx: any;
  debug: ReturnType<typeof vi.fn>;
} {
  const pi = createMockExtensionAPI();
  const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getEntries: () => [] }, cwd: "/tmp/test-project" };
  const debug = vi.fn();
  const input: DisputeHandlerInput = {
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

// --- handleDisputeFix (unchanged — regression) ---

describe("handleDisputeFix", () => {
  it("flag false → unhandled, zero side effects", () => {
    const { input, pi, ctx, debug } = makeInput({ state: { current: makeState({ awaitDisputeFix: false }) } });
    const result = handleDisputeFix(input);

    expect(result.handled).toBe(false);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(0);
    expect(pi.appendedEntries).toHaveLength(0);
    expect(debug).not.toHaveBeenCalled();
  });

  it("flag true → handled: status + tester dispute fix prompt, flag NOT cleared, no entry", () => {
    const state = makeState({ phase: "B", round: 1, awaitDisputeFix: true });
    const before = cloneState(state);
    const { input, pi, ctx } = makeInput({ state: { current: state } });
    const result = handleDisputeFix(input);

    expect(result.handled).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1 (dispute fix)");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptTesterDisputeFix());
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(state).toEqual(before); // no mutation — flag stays true (spec 03 clears at prompt-build)
    expect(state.awaitDisputeFix).toBe(true);
    expect(pi.appendedEntries).toHaveLength(0);
  });

  it("works without debug (optional per R2)", () => {
    const { input, ctx } = makeInput({ state: { current: makeState({ awaitDisputeFix: true }) }, debug: undefined });
    const result = handleDisputeFix(input);

    expect(result.handled).toBe(true);
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });

  it("status reflects the current round (round 2)", () => {
    const { input, ctx } = makeInput({ state: { current: makeState({ phase: "B", round: 2, awaitDisputeFix: true }) } });
    handleDisputeFix(input);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 2 (dispute fix)");
  });
});

// --- handleDisputeReview (Table 1 — rewritten: scheduling, not a dead guard) ---

describe("handleDisputeReview", () => {
  it("Table 1 row 0 — flag false → unhandled, zero side effects", () => {
    const { input, pi, ctx, debug } = makeInput({ state: { current: makeState({ awaitDisputeReview: false }) } });
    const result = handleDisputeReview(input);

    expect(result).toEqual({ handled: false, type: "review" });
    expect(pi.appendedEntries).toHaveLength(0);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("Table 1 row 1, filer 'writer' → handled:true, tester review prompt, flag CLEARED, entry + status", () => {
    const state = makeState({
      phase: "B",
      round: 1,
      awaitDisputeReview: true,
      disputeMode: false, // Writer filed
      lastProposal: "Test X/edge_case expects nil but spec says return zero-value",
    });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleDisputeReview(input);

    expect(result).toEqual({ handled: true, type: "review" }); // gate does NOT run this settle
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptTesterReviewWriterDispute(state.lastProposal)); // reviewer-addressed (F-C)
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(state.awaitDisputeReview).toBe(false); // cleared this settle
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.appendedEntries[0].data).not.toBe(state); // spread copy, not the live object
    expect(pi.appendedEntries[0].data.awaitDisputeReview).toBe(false); // snapshot taken after the clear
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1 (dispute review)");
    expect(debug).toHaveBeenCalledWith("Dispute review → tester review turn");
  });

  it("Table 1 row 1, filer 'tester' → handled:true, writer review prompt, debug 'writer review turn'", () => {
    const state = makeState({
      phase: "B",
      round: 2,
      awaitDisputeReview: true,
      disputeMode: true, // Tester filed (dispute-fix window)
      lastProposal: "Your refactor broke the retry path",
    });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleDisputeReview(input);

    expect(result).toEqual({ handled: true, type: "review" });
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterDisputeReview(state.lastProposal)); // reviewer-addressed
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(state.awaitDisputeReview).toBe(false);
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 2 (dispute review)");
    expect(debug).toHaveBeenCalledWith("Dispute review → writer review turn");
  });

  it("empty lastProposal edge — prompt still built from the recorded (empty) claim", () => {
    const state = makeState({ phase: "B", round: 1, awaitDisputeReview: true, lastProposal: "" });
    const { input, pi } = makeInput({ state: { current: state } });
    const result = handleDisputeReview(input);

    expect(result.handled).toBe(true);
    expect(pi.sentMessages[0].content).toBe(GP.promptTesterReviewWriterDispute(""));
  });
});

// --- handleDisputeDefend (Table 3 row 1) ---

describe("handleDisputeDefend", () => {
  it("Table 3 row 1, filer 'writer' → promptWriterDisputeDefended, both fields cleared, handled:true", () => {
    const state = makeState({
      phase: "B",
      round: 2, // round was ++'d by the defend cell
      disputeMode: false, // cleared by the defend cell — NOT a reliable signal (F-B)
      disputeDefended: "The test is correct. The spec clearly states this behavior.",
      disputeFiler: "writer",
    });
    // Snapshot the decision BEFORE calling the handler: the handler's own
    // contract is to clear state.current.disputeDefended, so reading
    // state.disputeDefended afterwards would be undefined.
    const decision = state.disputeDefended as string;
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleDisputeDefend(input);

    expect(result).toEqual({ handled: true, type: "defend" }); // gate skipped this settle
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterDisputeDefended(decision));
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(state.disputeDefended).toBeUndefined(); // cleared
    expect(state.disputeFiler).toBeUndefined(); // cleared
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.appendedEntries[0].data.disputeDefended).toBeUndefined(); // snapshot after the clears
    expect(debug).toHaveBeenCalledWith("Dispute defend → delivering decision");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled(); // Table 3 row 1 has no status step
  });

  it("Table 3 row 1, filer 'tester' → promptTesterReportRejected, both fields cleared", () => {
    const state = makeState({
      phase: "B",
      round: 3,
      disputeMode: false, // row 4 window-close — routing MUST use the recorded filer, not this
      disputeDefended: "The refactor is correct; the report misread the spec.",
      disputeFiler: "tester",
    });
    // Snapshot before the call — the handler clears disputeDefended (see above).
    const decision = state.disputeDefended as string;
    const { input, pi } = makeInput({ state: { current: state } });
    const result = handleDisputeDefend(input);

    expect(result).toEqual({ handled: true, type: "defend" });
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptTesterReportRejected(decision));
    expect(state.disputeDefended).toBeUndefined();
    expect(state.disputeFiler).toBeUndefined();
    expect(pi.appendedEntries).toHaveLength(1);
  });

  it("routes by the RECORDED filer even when disputeMode disagrees (F-B invariant)", () => {
    const state = makeState({
      phase: "B",
      round: 2,
      disputeMode: true, // stale/contradictory — must be ignored
      disputeDefended: "defense text",
      disputeFiler: "writer",
    });
    const { input, pi } = makeInput({ state: { current: state } });
    handleDisputeDefend(input);

    expect(pi.sentMessages[0].content).toBe(GP.promptWriterDisputeDefended("defense text"));
    // disputeMode is untouched by this handler
    expect(state.disputeMode).toBe(true);
  });

  it("condition false (disputeDefended undefined) → unhandled, zero side effects", () => {
    const state = makeState({ phase: "B", round: 2, disputeDefended: undefined, disputeFiler: "writer" });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleDisputeDefend(input);

    expect(result.handled).toBe(false);
    expect(pi.sentMessages).toHaveLength(0);
    expect(pi.appendedEntries).toHaveLength(0);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(state.disputeFiler).toBe("writer"); // untouched when unhandled
  });

  it("edge — disputeDefended present, disputeFiler undefined → writer prompt (else branch)", () => {
    const state = makeState({ phase: "B", round: 2, disputeDefended: "defense" });
    const { input, pi } = makeInput({ state: { current: state } });
    const result = handleDisputeDefend(input);

    expect(result.handled).toBe(true);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterDisputeDefended("defense"));
    expect(state.disputeDefended).toBeUndefined();
  });
});

// --- handleWriterConcedeFix (Table 3 row 2) ---

describe("handleWriterConcedeFix", () => {
  it("Table 3 row 2 → promptWriterConcedeFix(lastProposal), awaitWriterConcedeFix + disputeFiler cleared, handled:true", () => {
    const state = makeState({
      phase: "B",
      round: 2,
      lastProposal: "Your refactor broke the retry path",
      awaitWriterConcedeFix: true,
      disputeFiler: "tester",
    });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleWriterConcedeFix(input);

    expect(result).toEqual({ handled: true, type: "writer-fix" }); // gate skipped this settle
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterConcedeFix(state.lastProposal));
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(state.awaitWriterConcedeFix).toBe(false); // cleared
    expect(state.disputeFiler).toBeUndefined(); // N2: cleared on this row too
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.appendedEntries[0].data.awaitWriterConcedeFix).toBe(false);
    expect(debug).toHaveBeenCalledWith("Writer conceded → fix turn");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled(); // Table 3 row 2 has no status step
  });

  it("edge — no disputeFiler set (approve cell linger absent) → still delivers and clears the flag", () => {
    const state = makeState({ phase: "B", round: 2, lastProposal: "claim", awaitWriterConcedeFix: true });
    const { input, pi } = makeInput({ state: { current: state } });
    const result = handleWriterConcedeFix(input);

    expect(result.handled).toBe(true);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterConcedeFix("claim"));
    expect(state.awaitWriterConcedeFix).toBe(false);
  });

  it("condition false (flag false) → unhandled, zero side effects", () => {
    const state = makeState({ phase: "B", round: 2, awaitWriterConcedeFix: false, disputeFiler: "tester" });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });
    const result = handleWriterConcedeFix(input);

    expect(result.handled).toBe(false);
    expect(pi.sentMessages).toHaveLength(0);
    expect(pi.appendedEntries).toHaveLength(0);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
    expect(state.disputeFiler).toBe("tester"); // untouched when unhandled
  });

  it("edge — flag undefined (pre-feature saved state) → unhandled", () => {
    const state = makeState({ phase: "B", round: 2 }); // awaitWriterConcedeFix absent
    const { input, pi } = makeInput({ state: { current: state } });
    const result = handleWriterConcedeFix(input);

    expect(result.handled).toBe(false);
    expect(pi.sentMessages).toHaveLength(0);
  });
});
