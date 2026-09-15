// Behavior contract for the tools.ts split — internal/refactor-tools-split.md
//
// Pinned contract: the split is a PURE file reorganization. Every behavior
// below is pinned against the PRE-SPLIT implementation of src/tools.ts so
// any drift introduced by the move (renamed helper, dropped branch, changed
// string, changed entry type) fails here.
//
// Coverage:
//   1. negotiatePropose / negotiateReview factory surface (name, label,
//      description, parameters schema).
//   2. The (phase × tool) policy matrix — all 8 phases × 2 tools, driven
//      directly through the public factories.
//   3. negotiate-phase handlers: proposal, agree→B advance (field set +
//      prompt), feedback, contract re-review (row 2/row 3 split).
//   4. Phase B dispute handlers: file, concede ("agree" lexical match),
//      resolve (conceded/defended), budget consumption at resolution,
//      escalation at maxDispute.
//   5. Entry-log shapes (loop-negotiate, loop-dispute, loop-refusal) and
//      the persistence invariant: every mutating path persists a loop-state
//      entry as its FINAL entry.
//
// Per CLAUDE.md TEST SPEED RULE: no real toolchain, no npx, no temp-dir
// scaffolding. All process boundaries are mocked at file level.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

// commit() and sendPrompt() write the .pi/loop-status file only in runner
// mode; we never set PI_LOOP_RUNNER, but mock node:fs anyway so no code path
// can perform a real write (unit tests never touch the disk).
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as Tool from "../../src/tools";
import * as GP from "../../src/generic-prompts";
import { initLiveMetrics, clearLiveMetrics, getLiveMetrics } from "../../src/metrics";
import type { LoopState, Phase } from "../../src/types";
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";

// --- Fixtures -----------------------------------------------------------

function makeState(overrides: Partial<LoopState> = {}): { current: LoopState } {
  return {
    current: {
      phase: "negotiate",
      round: 2,
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
      turnsThisPhase: 1,
      lastProposal: "plan X",
      lastPhase: "A",
      justTransitioned: false,
      negotiateReprompted: false,
      negotiateProposed: false,
      negotiateFeedback: "",
      ...overrides,
    },
  };
}

function makeCtx(): any {
  return { ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "tui", hasUI: true };
}

type Pi = ReturnType<typeof createMockExtensionAPI>;

function lastStateEntries(pi: Pi): any[] {
  return pi.appendedEntries.filter((e: any) => e.customType === "loop-state");
}

function lastEntry(pi: Pi): any {
  return pi.appendedEntries[pi.appendedEntries.length - 1];
}

function sentPrompts(pi: Pi): string[] {
  return pi.sentMessages.map((m: any) => m.content);
}

async function runPropose(
  state: { current: LoopState },
  plan: string,
  ctx = makeCtx(),
): Promise<{ pi: Pi; result: { content: { text: string }[] } }> {
  const pi = createMockExtensionAPI();
  const tool = Tool.negotiatePropose(state, pi as any, vi.fn());
  const result = await tool.execute("call-1", { plan }, undefined, undefined, ctx);
  return { pi, result };
}

async function runReview(
  state: { current: LoopState },
  decision: string,
  ctx = makeCtx(),
): Promise<{ pi: Pi; result: { content: { text: string }[] } }> {
  const pi = createMockExtensionAPI();
  const tool = Tool.negotiateReview(state, pi as any, vi.fn());
  const result = await tool.execute("call-2", { decision }, undefined, undefined, ctx);
  return { pi, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearLiveMetrics();
  delete process.env.PI_LOOP_RUNNER;
});

afterEach(() => {
  clearLiveMetrics();
  delete process.env.PI_LOOP_RUNNER;
});

// ================================================================
// 1. Factory surface — the registered tool definitions are unchanged
// ================================================================

describe("factory surface — negotiate_propose", () => {
  it("exposes the pinned name/label/description", () => {
    const tool = Tool.negotiatePropose(makeState(), createMockExtensionAPI() as any, vi.fn());
    expect(tool.name).toBe("negotiate_propose");
    expect(tool.label).toBe("Propose Implementation");
    expect(tool.description).toBe(
      "Propose an implementation approach, dispute a test, or concede with 'agree'.",
    );
  });

  it("exposes the pinned parameters schema (single required string 'plan')", () => {
    const tool = Tool.negotiatePropose(makeState(), createMockExtensionAPI() as any, vi.fn());
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "Implementation approach or 'agree' to accept tests as-is, or a dispute claim.",
        },
      },
      required: ["plan"],
    });
  });

  it("execute is async and returns a result object with a content array", async () => {
    const tool = Tool.negotiatePropose(
      makeState({ phase: "A" }),
      createMockExtensionAPI() as any,
      vi.fn(),
    );
    expect(typeof tool.execute).toBe("function");
    const result = await tool.execute("c", { plan: "x" }, undefined, undefined, makeCtx());
    expect(Array.isArray(result.content)).toBe(true);
    expect(typeof result.content[0].text).toBe("string");
  });
});

describe("factory surface — negotiate_review", () => {
  it("exposes the pinned name/label/description", () => {
    const tool = Tool.negotiateReview(makeState(), createMockExtensionAPI() as any, vi.fn());
    expect(tool.name).toBe("negotiate_review");
    expect(tool.label).toBe("Review Proposal");
    expect(tool.description).toBe("Approve a proposal or provide feedback.");
  });

  it("exposes the pinned parameters schema (single required string 'decision')", () => {
    const tool = Tool.negotiateReview(makeState(), createMockExtensionAPI() as any, vi.fn());
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        decision: {
          type: "string",
          description: "'approve' to accept, or feedback text.",
        },
      },
      required: ["decision"],
    });
  });
});

// ================================================================
// 2. (phase × tool) policy matrix — 8 phases × 2 tools, closed
// ================================================================

describe("policy matrix — propose", () => {
  const rejects: Array<[Phase, string]> = [
    ["A", "negotiate_propose is not available in this phase."],
    ["C", "negotiate_propose is not available in this phase."],
    ["done", "negotiate_propose is not available in this phase."],
    ["escalated", "negotiate_propose is not available in this phase."],
    ["idle", "negotiate_propose is not available in this phase."],
  ];

  it.each(rejects)("%s × propose → reject text, no state mutation, loop-refusal entry", async (phase, text) => {
    const state = makeState({ phase, lastProposal: "seed" });
    const { pi, result } = await runPropose(state, "stray call");

    expect(result.content[0].text).toBe(text);
    expect(state.current.lastProposal).toBe("seed"); // no poisoning
    expect(lastStateEntries(pi)).toHaveLength(0); // no persistence

    const refusals = pi.appendedEntries.filter((e: any) => e.customType === "loop-refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].data).toEqual({
      phase,
      tool: "negotiate_propose",
      reason: "not-available-in-phase",
    });
  });

  it("negotiate × propose('plan') → proposal recorded, negotiateProposed=true, persisted", async () => {
    const state = makeState({ lastProposal: "old" });
    const { pi, result } = await runPropose(state, "plan Y");

    expect(result.content[0].text).toBe("Proposal recorded. Awaiting review.");
    expect(state.current.lastProposal).toBe("plan Y"); // set by the dispatcher
    expect(state.current.negotiateProposed).toBe(true);
    expect(state.current.phase).toBe("negotiate");

    const entries = lastStateEntries(pi);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.phase).toBe("negotiate");
    expect(entries[0].data.negotiateProposed).toBe(true);

    const log = pi.appendedEntries.find((e: any) => e.customType === "loop-negotiate");
    expect(log).toBeDefined();
    expect(log!.data.action).toBe("propose");
    expect(log!.data.text).toBe("plan Y");
    expect(log!.data.round).toBe(2);
  });

  it("review × propose('approve') → Phase A transition (same transition as /loop-approve)", async () => {
    const state = makeState({ phase: "review", round: 0 });
    const ctx = makeCtx();
    const { pi, result } = await runPropose(state, "approve", ctx);

    expect(result.content[0].text).toBe("Proposal recorded. Moving to Phase A.");
    expect(state.current.phase).toBe("A");
    expect(state.current.round).toBe(1);
    expect(state.current.turnsThisPhase).toBe(1);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Spec review approved. Phase A: Tester writes contract.",
      "info",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase A — round 1");

    // The Tester Phase A prompt was sent (spec + test-file pattern pinned).
    const prompts = sentPrompts(pi);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("You are the TESTER. Write contract tests.");
    expect(prompts[0]).toContain("spec.md");
    expect(prompts[0]).toContain("*_test.go");

    const entries = lastStateEntries(pi);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.phase).toBe("A");
  });

  it("review × propose('feedback text') → lastProposal set, phase stays review, no prompt", async () => {
    const state = makeState({ phase: "review" });
    const ctx = makeCtx();
    const { pi, result } = await runPropose(state, "tighten the API", ctx);

    expect(result.content[0].text).toBe("Feedback recorded. The review continues.");
    expect(state.current.phase).toBe("review");
    expect(state.current.lastProposal).toBe("tighten the API");
    expect(sentPrompts(pi)).toHaveLength(0);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Phase 0: feedback recorded. The review continues — refine the spec or re-run /loop.",
      "info",
    );

    const entries = lastStateEntries(pi);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.phase).toBe("review");
    expect(entries[0].data.lastProposal).toBe("tighten the API");
  });

  it("B × propose('claim') → dispute filed (see dispute section; spot-check the result text)", async () => {
    const state = makeState({ phase: "B" });
    const { result } = await runPropose(state, "test X is wrong");
    expect(result.content[0].text).toBe(
      "Dispute filed. STOP producing tool calls. The review is requested when your turn ends.",
    );
  });
});

describe("policy matrix — review", () => {
  const rejects: Array<[Phase]> = [
    ["A"],
    ["C"],
    ["done"],
    ["escalated"],
    ["idle"],
  ];

  it.each(rejects)("%s × review → reject text, no state mutation, loop-refusal entry", async (phase) => {
    const state = makeState({ phase });
    const { pi, result } = await runReview(state, "approve");

    expect(result.content[0].text).toBe("negotiate_review is not available in this phase.");
    expect(lastStateEntries(pi)).toHaveLength(0);

    const refusals = pi.appendedEntries.filter((e: any) => e.customType === "loop-refusal");
    expect(refusals).toHaveLength(1);
    expect(refusals[0].data.tool).toBe("negotiate_review");
    expect(refusals[0].data.reason).toBe("not-available-in-phase");
  });

  it("review × review('approve') and review('approved') → Phase A transition", async () => {
    for (const decision of ["approve", "approved"]) {
      const state = makeState({ phase: "review", round: 0 });
      const { pi, result } = await runReview(state, decision);
      expect(result.content[0].text).toBe("Proposal recorded. Moving to Phase A.");
      expect(state.current.phase).toBe("A");
      expect(lastStateEntries(pi)[0].data.phase).toBe("A");
    }
  });

  it("review × review('feedback') → lastProposal set, phase stays review", async () => {
    const state = makeState({ phase: "review" });
    const { result } = await runReview(state, "scope is too wide");
    expect(result.content[0].text).toBe("Feedback recorded. The review continues.");
    expect(state.current.phase).toBe("review");
    expect(state.current.lastProposal).toBe("scope is too wide");
  });
});

// ================================================================
// 3. negotiate-phase handlers
// ================================================================

describe("negotiate × propose('agree') → Phase B advance", () => {
  it("resets the full transient field set and advances with the Writer Phase B prompt", async () => {
    // Seed EVERY transient field to a live value — the advance must clear all.
    const state = makeState({
      round: 2,
      turnsThisPhase: 4,
      lastPhase: "negotiate",
      dispute: { status: "defended", filer: "writer" },
      negotiateReprompted: true,
      negotiateProposed: true,
      negotiateFeedback: "old feedback",
    });
    const ctx = makeCtx();
    const { pi, result } = await runPropose(state, "agree", ctx);

    expect(result.content[0].text).toBe("Proposal recorded. Moving to Phase B.");
    expect(state.current.phase).toBe("B");
    expect(state.current.lastPhase).toBe("negotiate");
    expect(state.current.round).toBe(1);
    expect(state.current.turnsThisPhase).toBe(1);
    expect(state.current.justTransitioned).toBe(true);
    expect(state.current.dispute).toEqual({ status: "none" });
    expect(state.current.negotiateReprompted).toBe(false);
    expect(state.current.negotiateProposed).toBe(false);
    expect(state.current.negotiateFeedback).toBe("");

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1");

    // The Writer Phase B prompt IS sent in-turn (fix: the Writer needs
    // instructions to write the implementation; without it the loop stalls).
    expect(sentPrompts(pi)).toHaveLength(1);
    expect(sentPrompts(pi)[0]).toContain("Phase B");

    // The persisted state is the FINAL entry (persist happens after the writes).
    const entries = lastStateEntries(pi);
    expect(entries).toHaveLength(1);
    expect(lastEntry(pi).customType).toBe("loop-state");
    expect(entries[0].data.phase).toBe("B");
    expect(entries[0].data.dispute).toEqual({ status: "none" });
  });

  it("empty-state edge: no dispute field at all → advance still normalizes it to {status:'none'}", async () => {
    const state = makeState();
    delete state.current.dispute;
    const { result } = await runPropose(state, "agree");
    expect(result.content[0].text).toBe("Proposal recorded. Moving to Phase B.");
    expect(state.current.dispute).toEqual({ status: "none" });
  });
});

describe("negotiate × review — row 2 (re-review) vs row 3 (advance)", () => {
  it("even round + real proposal + 'approve' → re-review: round++, no phase change, re-review prompt", async () => {
    const state = makeState({ round: 2, lastProposal: "plan X" });
    const { pi, result } = await runReview(state, "approve");

    expect(result.content[0].text).toBe(
      "Proposal accepted. Re-reviewing the contract file before Phase B.",
    );
    expect(state.current.phase).toBe("negotiate");
    expect(state.current.round).toBe(3);
    expect(state.current.justTransitioned).toBe(true);
    expect(state.current.negotiateProposed).toBe(false);
    expect(state.current.negotiateFeedback).toBe("");

    const prompts = sentPrompts(pi);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe(GP.promptNegotiateContractReReview("*_test.go"));

    const entries = lastStateEntries(pi);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.round).toBe(3);
    expect(entries[0].data.phase).toBe("negotiate");
  });

  it("odd round + real proposal + 'approve' → advance to B (row 3)", async () => {
    const state = makeState({ round: 3, lastProposal: "plan X" });
    const { result } = await runReview(state, "approve");
    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.phase).toBe("B");
    expect(state.current.round).toBe(1);
  });

  it("even round + lastProposal 'agree' + 'approve' → advance to B (row 3 — agree asserts the file)", async () => {
    const state = makeState({ round: 2, lastProposal: "agree" });
    const { result } = await runReview(state, "approve");
    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.phase).toBe("B");
  });

  it("'approved' is an approval alias: even round + real proposal → re-review", async () => {
    const state = makeState({ round: 2, lastProposal: "plan X" });
    const { result } = await runReview(state, "approved");
    expect(result.content[0].text).toBe(
      "Proposal accepted. Re-reviewing the contract file before Phase B.",
    );
    expect(state.current.round).toBe(3);
  });

  it("feedback → negotiateFeedback recorded, persisted, 'Feedback recorded.'", async () => {
    const state = makeState({ round: 2, lastProposal: "plan X" });
    const { pi, result } = await runReview(state, "tighten test 2");

    expect(result.content[0].text).toBe("Feedback recorded.");
    expect(state.current.negotiateFeedback).toBe("tighten test 2");
    expect(state.current.phase).toBe("negotiate");
    expect(state.current.round).toBe(2); // round unchanged

    const entries = lastStateEntries(pi);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.negotiateFeedback).toBe("tighten test 2");

    const log = pi.appendedEntries.find((e: any) => e.customType === "loop-negotiate");
    expect(log!.data.action).toBe("review");
    expect(log!.data.text).toBe("tighten test 2");
  });

  it("long feedback edge: 2000-char decision is recorded verbatim but truncated in the entry log", async () => {
    const decision = "x".repeat(2000);
    const state = makeState({ round: 2, lastProposal: "plan X" });
    const { pi } = await runReview(state, decision);

    expect(state.current.negotiateFeedback).toBe(decision); // verbatim in state
    const log = pi.appendedEntries.find((e: any) => e.customType === "loop-negotiate");
    expect(log!.data.text).toBe("x".repeat(500)); // 500-char cap in the entry
  });
});

// ================================================================
// 4. Phase B dispute handlers
// ================================================================

describe("B × propose — dispute filing", () => {
  it("files the dispute: status filed, filer writer, claim, filedRound; metrics raised; persisted", async () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "B" } as any);
    const state = makeState({ phase: "B", round: 1, dispute: undefined });
    const { pi, result } = await runPropose(state, "test X is wrong");

    expect(result.content[0].text).toBe(
      "Dispute filed. STOP producing tool calls. The review is requested when your turn ends.",
    );
    expect(state.current.dispute).toEqual({
      status: "filed",
      filer: "writer",
      claim: "test X is wrong",
      filedRound: 1,
    });
    expect(state.current.disputeCount).toBe(0); // budget consumed at RESOLUTION, not filing
    expect(state.current.lastProposal).toBe("test X is wrong");

    const metrics = getLiveMetrics()!;
    expect(metrics.disputesRaised).toBe(1);

    const log = pi.appendedEntries.find((e: any) => e.customType === "loop-dispute");
    expect(log).toBeDefined();
    expect(log!.data.filer).toBe("writer");
    expect(log!.data.claim).toBe("test X is wrong");
    expect(log!.data.disputeCount).toBe(0);

    // persisted as the final entry
    expect(lastEntry(pi).customType).toBe("loop-state");
    expect(lastStateEntries(pi)[0].data.dispute?.status).toBe("filed");
  });

  it("preserves a tester-filed dispute's filer on re-filing (re-derivation must not happen)", async () => {
    const state = makeState({
      phase: "B",
      dispute: { status: "defended", filer: "tester", decision: "old" },
    });
    const { result } = await runPropose(state, "still wrong");
    expect(result.content[0].text).toContain("Dispute filed");
    expect(state.current.dispute?.status).toBe("filed");
    expect(state.current.dispute?.filer).toBe("tester");
  });

  it("single-character claim edge: a 1-char plan files normally", async () => {
    const state = makeState({ phase: "B" });
    const { result } = await runPropose(state, "x");
    expect(result.content[0].text).toContain("Dispute filed");
    expect(state.current.dispute?.claim).toBe("x");
  });
});

describe("B × propose — writer concession", () => {
  it("'agree' closes the dispute in-turn: status closed, feedback cleared, persisted; NO budget consumed, NO escalation", async () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "B" } as any);
    const state = makeState({
      phase: "B",
      dispute: { status: "filed", filer: "writer", claim: "c", filedRound: 1 },
      disputeCount: 2, // at maxDispute-1: concession must NOT escalate
      negotiateFeedback: "old feedback",
    });
    const { pi, result } = await runPropose(state, "agree");

    expect(result.content[0].text).toBe(
      "Dispute closed. The tests stand. Continue Phase B; the gate runs when your turn ends.",
    );
    expect(state.current.dispute).toEqual({ status: "closed" });
    expect(state.current.negotiateFeedback).toBe("");
    expect(state.current.phase).toBe("B"); // no phase change
    expect(state.current.disputeCount).toBe(2); // unchanged

    const metrics = getLiveMetrics()!;
    expect(metrics.disputesRaised).toBe(0);
    expect(metrics.disputesConceded).toBe(0);
    expect(metrics.disputesDefended).toBe(0);

    // no loop-dispute entry on the concede-via-propose path (only the close persists)
    expect(pi.appendedEntries.filter((e: any) => e.customType === "loop-dispute")).toHaveLength(0);
    expect(lastEntry(pi).customType).toBe("loop-state");
    expect(lastStateEntries(pi)[0].data.dispute?.status).toBe("closed");
  });

  it.each(["AGREE", "  agree  "])(
    "concession is case-insensitive and trimmed: %j",
    async (plan) => {
      const state = makeState({
        phase: "B",
        dispute: { status: "filed", filer: "writer", claim: "c", filedRound: 1 },
      });
      const { result } = await runPropose(state, plan);
      expect(result.content[0].text).toContain("Dispute closed");
    },
  );

  it.each(["agreed", "I agree", "agree to everything", "agreement"])(
    "non-concession edge %j still files a dispute (exact lexical match only)",
    async (plan) => {
      const state = makeState({
        phase: "B",
        dispute: { status: "filed", filer: "writer", claim: "c", filedRound: 1 },
      });
      const { result } = await runPropose(state, plan);
      expect(result.content[0].text).toContain("Dispute filed");
      expect(state.current.dispute?.status).toBe("filed");
      expect(state.current.dispute?.claim).toBe(plan);
    },
  );

  it("concession with no live dispute (undefined dispute) still closes cleanly", async () => {
    const state = makeState({ phase: "B", dispute: undefined });
    const { result } = await runPropose(state, "agree");
    expect(result.content[0].text).toContain("Dispute closed");
    expect(state.current.dispute).toEqual({ status: "closed" });
  });
});

describe("B × review — dispute resolution (budget at resolution)", () => {
  function stateAtBudget(overrides: Partial<LoopState> = {}): { current: LoopState } {
    return makeState({
      phase: "B",
      dispute: { status: "filed", filer: "writer", claim: "c", filedRound: 1 },
      disputeCount: 1, // maxDispute=3: the NEXT resolution (→2) stays below the limit
      ...overrides,
    });
  }

  it("approve below the limit → dispute conceded, 'Approved.', budget consumed", async () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "B" } as any);
    const state = stateAtBudget();
    const { pi, result } = await runReview(state, "approve");

    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.disputeCount).toBe(2);
    expect(state.current.dispute).toEqual({
      status: "conceded",
      decision: "concede",
      filer: "writer",
      claim: "c",
      filedRound: 1,
    });
    expect(state.current.phase).toBe("B"); // no escalation below limit
    expect(getLiveMetrics()!.disputesConceded).toBe(1);

    const logs = pi.appendedEntries.filter((e: any) => e.customType === "loop-dispute");
    expect(logs).toHaveLength(1); // the resolution log only
    expect(logs[0].data.filer).toBe("writer");

    // no loop-dispute concede entry for a writer-filed dispute
    expect(logs[0].data.action).toBeUndefined();
    expect(lastEntry(pi).customType).toBe("loop-state");
  });

  it("approve AT the limit → escalation: phase escalated, dispute reset, warning notify, 'Approved.' returned", async () => {
    const state = stateAtBudget({ disputeCount: 3 }); // 3 >= maxDispute=3
    const ctx = makeCtx();
    const { result } = await runReview(state, "approve", ctx);

    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.phase).toBe("escalated");
    expect(state.current.dispute).toEqual({ status: "none" });
    expect(state.current.disputeCount).toBe(4); // consumed before the check

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Dispute limit reached. Escalating to human.",
      "warning",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "escalated (dispute limit)");
  });

  it("feedback below the limit → dispute defended with the decision text, 'Feedback recorded.'", async () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "B" } as any);
    const state = stateAtBudget();
    const decision = "Edge case Y is handled; the report misread the spec.";
    const { pi, result } = await runReview(state, decision);

    expect(result.content[0].text).toBe("Feedback recorded.");
    expect(state.current.disputeCount).toBe(2);
    expect(state.current.dispute).toEqual({
      status: "defended",
      decision,
      filer: "writer",
      claim: "c",
      filedRound: 1,
    });
    expect(state.current.phase).toBe("B");
    expect(state.current.round).toBe(2); // round unchanged by the review tool
    expect(getLiveMetrics()!.disputesDefended).toBe(1);

    const logs = pi.appendedEntries.filter((e: any) => e.customType === "loop-dispute");
    expect(logs).toHaveLength(1);
    expect(logs[0].data.text).toBe(decision);
    expect(lastEntry(pi).customType).toBe("loop-state");
  });

  it("feedback AT the limit → escalation, dispute reset, 'Feedback recorded.' returned", async () => {
    const state = stateAtBudget({ disputeCount: 3 });
    const ctx = makeCtx();
    const { result } = await runReview(state, "the test is wrong", ctx);

    expect(result.content[0].text).toBe("Feedback recorded.");
    expect(state.current.phase).toBe("escalated");
    expect(state.current.dispute).toEqual({ status: "none" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Dispute limit reached. Escalating to human.",
      "warning",
    );
  });

  it("single-element budget edge: maxDispute=1, disputeCount=0 → first resolution escalates", async () => {
    const state = stateAtBudget({ maxDispute: 1, disputeCount: 0 });
    const ctx = makeCtx();
    const { result } = await runReview(state, "approve", ctx);
    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.disputeCount).toBe(1);
    expect(state.current.phase).toBe("escalated");
  });

  it("tester-filed dispute + approve → extra loop-dispute concede entry (action: 'concede')", async () => {
    const state = stateAtBudget({
      dispute: { status: "filed", filer: "tester", claim: "c", filedRound: 1 },
    });
    const { pi } = await runReview(state, "approve");
    const logs = pi.appendedEntries.filter((e: any) => e.customType === "loop-dispute");
    expect(logs).toHaveLength(2);
    expect(logs[logs.length - 1].data.action).toBe("concede");
  });

  it("undefined-dispute edge: review in B with dispute unset → no crash, 'Approved.'", async () => {
    const state = makeState({ phase: "B", dispute: undefined, disputeCount: 0 });
    const { result } = await runReview(state, "approve");
    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.phase).toBe("B");
    expect(state.current.disputeCount).toBe(1);
  });
});

// ================================================================
// 5. isAgreeProposal — public API preserved at the same import path
// ================================================================

describe("isAgreeProposal — public contract (importable from src/tools)", () => {
  it.each([
    ["agree", true],
    ["AGREE", true],
    ["Agree", true],
    ["  agree  ", true],
    ["agree: confirmed", true],
    ["agree — confirmed", true],
    ["agree - confirmed", true],
    ["agreement reached", false],
    ["I agree", false],
    ["agreed", false],
    ["disagree", false],
    ["", false],
  ])("isAgreeProposal(%j) → %s", (input, expected) => {
    expect(Tool.isAgreeProposal(input)).toBe(expected);
  });
});
