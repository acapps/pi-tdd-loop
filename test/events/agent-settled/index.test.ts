// Contract tests for the agent_settled dispatcher.
// Spec: internal/04-implement-agent-settled-handlers.md (G2, G3, G5).
//
// Pinned contract:
//  - Step order (exact): terminal short-circuit → lang resolution →
//    checkLoopEscalation → justTransitioned → disputeFix → disputeReview
//    (dead guard — always falls through) → review → negotiate → gate.
//  - Return mapping (G5 table):
//      terminal / escalation / justTransitioned / disputeFix → undefined
//      review → handled boolean · negotiate → always true · gate → applied
//  - G2: negotiate and gate paths REPLACE state.current (computeTransition
//    returns new objects — an unassigned result = silent dropped transition).
//  - G3: the dispatcher sets lastGateResult on the new gate state
//    (user-visible via /loop-status and selectors).
//  - In-place steps (escalation, justTransitioned, dispute guards) mutate
//    state.current in place — same object, no replacement.
//
// Sub-handlers run for real; runGates is mocked (the only external I/O).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAgentSettled } from "../../../src/events/agent-settled/index";
import type { AgentSettledDispatcherInput } from "../../../src/events/agent-settled/index";
import type { LoopState, GateResult } from "../../../src/types";
import { getLanguageConfig } from "../../../src/languages";
import * as GP from "../../../src/generic-prompts";
import { runGates } from "../../../src/gates";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

vi.mock("../../../src/gates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/gates")>();
  return { ...actual, runGates: vi.fn() };
});

const runGatesMock = vi.mocked(runGates);
const GO = getLanguageConfig("go");

// --- Fixtures ---

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "A",
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

function makeCtx(): any {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd: "/tmp/test-project",
  };
}

// runGates now returns a GateOutcome; these fixtures wrap a GateResult in
// the kind: "result" envelope (harness flip for bug-gate-signal-integrity).
function gate(
  overrides: Partial<GateResult> = {},
): { kind: "result"; result: GateResult } {
  return {
    kind: "result",
    result: {
      compile: true,
      compileError: "",
      tests: true,
      allPassed: true,
      coverage: 85,
      failures: [],
      ...overrides,
    },
  };
}

function makeInput(overrides: Partial<AgentSettledDispatcherInput> = {}): {
  input: AgentSettledDispatcherInput;
  pi: any;
  ctx: any;
  debug: ReturnType<typeof vi.fn>;
} {
  const pi = createMockExtensionAPI();
  const ctx = makeCtx();
  const debug = vi.fn();
  const input: AgentSettledDispatcherInput = {
    state: { current: makeState() },
    pi: pi as any,
    ctx,
    debug,
    ...overrides,
  };
  return { input, pi, ctx, debug };
}

beforeEach(() => {
  runGatesMock.mockReset();
  runGatesMock.mockReturnValue(Promise.resolve(gate())); // default: all pass
});

// --- Step 1: terminal short-circuit (BEFORE lang resolution) ---

describe("step 1 — terminal short-circuit", () => {
  it.each(["idle", "done", "escalated"] as const)("phase %s → undefined; nothing runs", async (phase) => {
    const { input, pi, ctx, debug } = makeInput({ state: { current: makeState({ phase }) } });
    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(0);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it("terminal + corrupted language → undefined, no throw (lang resolution never reached)", async () => {
    const { input } = makeInput({ state: { current: makeState({ phase: "done", language: "bogus" as any }) } });
    expect(async () => handleAgentSettled(input)).not.toThrow();
    expect(await handleAgentSettled(input)).toBeUndefined();
  });
});

// --- Step 2: lang resolution ---

describe("step 2 — lang resolution", () => {
  it("non-terminal + corrupted language → throws 'Language not available', no gate", async () => {
    const { input } = makeInput({ state: { current: makeState({ phase: "A", language: "bogus" as any }) } });
    expect(async () => await handleAgentSettled(input)).toThrow(/Language not available: bogus/);
    expect(runGatesMock).not.toHaveBeenCalled();
  });
});

// --- Step 3: loop escalation ---

describe("step 3 — loop escalation", () => {
  it("turnsThisPhase+1 > maxTurnsPerPhase → escalates in place, undefined, no gate", async () => {
    const state = makeState({ phase: "A", round: 1, turnsThisPhase: 5, maxTurnsPerPhase: 5 });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(state.phase).toBe("escalated"); // in-place mutation — same object
    expect(state.lastPhase).toBe("A");
    expect(state.turnsThisPhase).toBe(6); // incremented, NOT reset
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop detected in Phase A. Escalating to human.", "warning");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "escalated (loop detected)");
    expect(debug).toHaveBeenCalledWith("Loop detected (6 turns in phase A), escalating");
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("boundary: turnsThisPhase+1 == maxTurnsPerPhase → no escalation, gate runs", async () => {
    const state = makeState({ phase: "A", round: 1, turnsThisPhase: 4, maxTurnsPerPhase: 5 });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true); // retry effect applied
    expect(state.turnsThisPhase).toBe(5); // in-place increment, no escalation
    expect(state.phase).toBe("A"); // original object untouched by the gate path
    expect(input.state.current).not.toBe(state); // G2: gate replaced state.current
    expect(input.state.current.phase).toBe("A");
    expect(input.state.current.round).toBe(2);
    expect(input.state.current.turnsThisPhase).toBe(1); // retry effect
  });

  it("maxTurnsPerPhase 0 → falls back to 5 (|| 5), no escalation", async () => {
    const state = makeState({ phase: "A", round: 1, turnsThisPhase: 4, maxTurnsPerPhase: 0 });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true); // 5 <= 5 → gate, not escalation
    expect(input.state.current.phase).toBe("A");
  });

  it("escalation runs BEFORE justTransitioned: both fire → escalation wins, flag uncleared, no message", async () => {
    const state = makeState({ phase: "B", round: 1, turnsThisPhase: 6, maxTurnsPerPhase: 5, justTransitioned: true });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(state.phase).toBe("escalated");
    expect(state.justTransitioned).toBe(true); // step 4 never ran
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("spec 08 site 9 — escalation clears both dispute flags in place", async () => {
    const state = makeState({ phase: "B", round: 1, turnsThisPhase: 5, maxTurnsPerPhase: 5, awaitDisputeFix: true, awaitDisputeReview: true });
    const { input, ctx } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(state.phase).toBe("escalated");
    expect(state.lastPhase).toBe("B");
    expect(state.awaitDisputeFix).toBe(false); // cleared at the escalation boundary
    expect(state.awaitDisputeReview).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop detected in Phase B. Escalating to human.", "warning");
    expect(runGatesMock).not.toHaveBeenCalled();

    // edge: a single live flag is cleared too
    const one = makeState({ phase: "B", round: 1, turnsThisPhase: 5, maxTurnsPerPhase: 5, awaitDisputeReview: true });
    const { input: inputOne } = makeInput({ state: { current: one } });
    expect(await handleAgentSettled(inputOne)).toBeUndefined();
    expect(one.phase).toBe("escalated");
    expect(one.awaitDisputeFix).toBe(false);
    expect(one.awaitDisputeReview).toBe(false);
  });
});

// --- Step 4: justTransitioned ---

describe("step 4 — justTransitioned", () => {
  it("B round 1 → clears in place, one message (negotiate approved), undefined, no gate", async () => {
    const state = makeState({ phase: "B", round: 1, justTransitioned: true });
    const { input, pi, debug } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(state.justTransitioned).toBe(false); // cleared in place
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptNegotiateApproved());
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("agent_settled: justTransitioned → clearing & triggering turn (Phase B round 1)");
    expect(debug).toHaveBeenCalledWith("agent_settled: triggering Phase B Writer turn");
  });

  it("B round 2 → clears, NO message (spot assert, round-2 variant)", async () => {
    const state = makeState({ phase: "B", round: 2, justTransitioned: true });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(state.justTransitioned).toBe(false);
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("C round 1 → clears, no message (only B r1 triggers)", async () => {
    const state = makeState({ phase: "C", round: 1, justTransitioned: true });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(state.justTransitioned).toBe(false);
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("flag false → falls through to the gate", async () => {
    const state = makeState({ phase: "A", round: 1, justTransitioned: false });
    const { input } = makeInput({ state: { current: state } }); // default all-pass gate → advance

    expect(await handleAgentSettled(input)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
  });
});

// --- Step 5: disputeFix ---

describe("step 5 — disputeFix", () => {
  it("flag true → undefined, tester dispute fix prompt, status, flag NOT cleared, no gate", async () => {
    const state = makeState({ phase: "B", round: 1, awaitDisputeFix: true });
    const { input, pi, ctx } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptTesterDisputeFix());
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1 (dispute fix)");
    expect(state.awaitDisputeFix).toBe(true); // cleared elsewhere (spec 03)
    expect(runGatesMock).not.toHaveBeenCalled();
  });

  it("flag false → gate runs", async () => {
    const state = makeState({ phase: "B", round: 1, awaitDisputeFix: false });
    const { input } = makeInput({ state: { current: state } }); // all-pass → advance to C

    expect(await handleAgentSettled(input)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
  });

  it("takes priority over disputeReview: both flags set → only the fix prompt, no review debug, no snapshot", async () => {
    const state = makeState({ phase: "B", round: 1, awaitDisputeFix: true, awaitDisputeReview: true });
    const { input, pi, debug } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptTesterDisputeFix());
    expect(debug).not.toHaveBeenCalledWith("Dispute review pending");
    expect(pi.appendedEntries).toHaveLength(0);
  });
});

// --- Step 6: disputeReview (dead guard — always falls through to the gate) ---

describe("step 6 — disputeReview (dead guard: falls through to the gate)", () => {
  it("spec 09 — flag true + gate all-pass → Table 1 fires first: writer review prompt, gate SKIPPED, undefined (rewrote the spec 08 all-pass dispatcher test)", async () => {
    const state = makeState({ phase: "B", round: 1, disputeMode: true, awaitDisputeReview: true, lastProposal: "writer claim" });
    runGatesMock.mockReturnValue(Promise.resolve(gate())); // would have advanced to C — but the review turn runs first
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined(); // handled:true → dispatcher short-circuits
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(state.awaitDisputeReview).toBe(false); // cleared at the settle step
    expect(state.phase).toBe("B"); // NOT advanced this settle
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterDisputeReview("writer claim")); // disputeMode true → tester filed → writer reviews
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
  });

  it("spec 09 — flag true + gate would retry → Table 1 fires first: reviewer prompt, flag cleared, gate SKIPPED, undefined", async () => {
    const state = makeState({ phase: "B", round: 1, awaitDisputeReview: true, lastProposal: "writer claim" });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined(); // handled:true → dispatcher short-circuits
    expect(runGatesMock).not.toHaveBeenCalled(); // the review turn runs first; gate resumes next settle
    expect(state.awaitDisputeReview).toBe(false); // cleared at the settle step
    expect(state.phase).toBe("B"); // not advanced
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptTesterReviewWriterDispute("writer claim"));
  });

  it("flag false → no snapshot, gate runs, returns the applied boolean", async () => {
    const state = makeState({ phase: "A", round: 1, awaitDisputeReview: false });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true); // retry applied
    expect(pi.appendedEntries).toHaveLength(0);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
  });

  it("spec 09 — flag true → scheduling runs, gate SKIPPED this settle, returns undefined", async () => {
    const state = makeState({ phase: "B", round: 1, disputeMode: false, awaitDisputeReview: true, lastProposal: "writer claim" });
    const { input, pi, ctx, debug } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined(); // handled:true → dispatcher short-circuits
    expect(runGatesMock).not.toHaveBeenCalled(); // the review turn runs first; gate resumes next settle
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptTesterReviewWriterDispute("writer claim"));
    expect(state.awaitDisputeReview).toBe(false); // cleared at the settle step
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1 (dispute review)");
    expect(debug).toHaveBeenCalledWith("Dispute review → tester review turn");
  });

  it("spec 09 — flag true takes priority over the gate even when the gate would fail", async () => {
    const state = makeState({ phase: "B", round: 1, disputeMode: true, awaitDisputeReview: true, lastProposal: "tester report" });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterDisputeReview("tester report"));
  });
});

// --- Step 6b: disputeDefend delivery (spec 09, Table 3 row 1) ---

describe("step 6b — disputeDefend delivery", () => {
  it("disputeDefended set (filer writer) → undef: writer defend prompt, fields cleared, snapshot, no gate", async () => {
    const state = makeState({ phase: "B", round: 2, disputeDefended: "The test is correct.", disputeFiler: "writer" });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterDisputeDefended("The test is correct."));
    expect(state.disputeDefended).toBeUndefined();
    expect(state.disputeFiler).toBeUndefined();
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
  });

  it("disputeDefended set (filer tester) → tester report-rejected prompt", async () => {
    const state = makeState({ phase: "B", round: 3, disputeDefended: "The refactor is correct.", disputeFiler: "tester" });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages[0].content).toBe(GP.promptTesterReportRejected("The refactor is correct."));
  });

  it("takes priority over the gate: both pending → only the delivery, no gate", async () => {
    const state = makeState({ phase: "B", round: 2, disputeDefended: "defense", disputeFiler: "writer" });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
  });
});

// --- Step 6c: writer concede fix delivery (spec 09, Table 3 row 2) ---

describe("step 6c — writerConcedeFix delivery", () => {
  it("awaitWriterConcedeFix true → undef: writer concede prompt, flag + disputeFiler cleared, snapshot, no gate", async () => {
    const state = makeState({ phase: "B", round: 2, lastProposal: "Your refactor broke the retry path", awaitWriterConcedeFix: true, disputeFiler: "tester" });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterConcedeFix("Your refactor broke the retry path"));
    expect(state.awaitWriterConcedeFix).toBe(false);
    expect(state.disputeFiler).toBeUndefined();
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
  });

  it("takes priority over the gate: both pending → only the delivery, no gate", async () => {
    const state = makeState({ phase: "B", round: 2, lastProposal: "claim", awaitWriterConcedeFix: true });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
  });
});

// --- Step 7: review ---

describe("step 7 — review", () => {
  it("awaitingReview true → returns true: notify + status + entry, no gate, no user message", async () => {
    const state = makeState({ phase: "review", awaitingReview: true });
    const { input, pi, ctx } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase 0 — review pending");
    expect(pi.appendedEntries).toHaveLength(1);
    expect(pi.appendedEntries[0].customType).toBe("loop-state");
    expect(pi.sentMessages).toHaveLength(0);
    expect(runGatesMock).not.toHaveBeenCalled();
  });

  it("awaitingReview false → returns false, zero side effects, no gate", async () => {
    const state = makeState({ phase: "review", awaitingReview: false });
    const { input, pi, ctx } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(false);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(pi.appendedEntries).toHaveLength(0);
    expect(runGatesMock).not.toHaveBeenCalled();
  });

  it("awaitingReview undefined (edge) → returns false", async () => {
    const state = makeState({ phase: "review" }); // awaitingReview absent
    const { input } = makeInput({ state: { current: state } });
    expect(await handleAgentSettled(input)).toBe(false);
  });
});

// --- Step 8: negotiate (always true; G2 reassignment) ---

describe("step 8 — negotiate (always true; replaces state.current, G2)", () => {
  it("odd round → writer reprompt: state.current replaced, original unmutated, no gate", async () => {
    const state = makeState({ phase: "negotiate", round: 1 });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(input.state.current).not.toBe(state); // G2 — reassignment happened
    expect(state.round).toBe(1); // original object unmutated
    expect(state.negotiateReprompted).toBe(false);
    expect(input.state.current.negotiateReprompted).toBe(true);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateRepromptWriter());
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(runGatesMock).not.toHaveBeenCalled();
  });

  it("even round → tester reprompt, always true", async () => {
    const state = makeState({ phase: "negotiate", round: 2 });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateRepromptTester());
  });

  it("negotiateReprompted → auto-advance: state.current is B r1 justTransitioned", async () => {
    const state = makeState({ phase: "negotiate", round: 3, negotiateReprompted: true });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(input.state.current).not.toBe(state); // G2
    expect(input.state.current.phase).toBe("B");
    expect(input.state.current.round).toBe(1);
    expect(input.state.current.justTransitioned).toBe(true);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptNegotiateAutoAdvance());
    expect(runGatesMock).not.toHaveBeenCalled();
  });
});

// --- Step 9: gate (G2 reassignment + G3 lastGateResult) ---

describe("step 9 — gate (replaces state.current, sets lastGateResult, G2/G3)", () => {
  it("A all-pass → advance: new state negotiate r1, lastGateResult set (identity), writer negotiate prompt", async () => {
    const state = makeState({ phase: "A", round: 1, specPath: "spec.md" });
    const g = gate({ coverage: 91 });
    runGatesMock.mockReturnValue(Promise.resolve(g));
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledWith("/tmp/test-project", 80, "go", "maven", "A");
    expect(input.state.current).not.toBe(state); // G2
    expect(state.round).toBe(1); // original unmutated
    expect(state.phase).toBe("A");
    expect(input.state.current.phase).toBe("negotiate");
    expect(input.state.current.round).toBe(1);
    expect(input.state.current.lastGateResult).toBe(g.result); // G3 — same reference
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterNegotiate("spec.md", GO.testFilePattern));
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
  });

  it("A compile fail → retry: round increments on the new state, compile retry prompt, lastGateResult set", async () => {
    const state = makeState({ phase: "A", round: 1 });
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", tests: false, allPassed: false, coverage: 0 })));
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(input.state.current.round).toBe(2);
    expect(input.state.current.lastGateResult).toBeDefined();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptTesterCompileRetry("boom"));
  });

  // Spec 10: the done effect delivers a completion message through the full
  // dispatcher chain (handleAgentSettled → gate → applyEffect → applyDoneEffect).
  // Fixture: specPath "spec.md", disputeCount 0, status "done" → clean variant.
  it("C all-pass → done: new state phase done, completion prompt sent", async () => {
    const state = makeState({ phase: "C", round: 1 });
    const { input, pi } = makeInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(input.state.current.phase).toBe("done");
    expect(input.state.current.lastGateResult).toBeDefined();
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptLoopComplete("spec.md", 0, false));
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true });
  });

  it("runGates receives state values (coverageThreshold, language, buildTool, phase)", async () => {
    const state = makeState({ phase: "C", round: 2, coverageThreshold: 60, language: "java", buildTool: "gradle" });
    const { input } = makeInput({ state: { current: state } });

    await handleAgentSettled(input);
    expect(runGatesMock).toHaveBeenCalledWith("/tmp/test-project", 60, "java", "gradle", "C");
  });
});
