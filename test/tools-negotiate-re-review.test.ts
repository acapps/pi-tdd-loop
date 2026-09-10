// Contract tests for the negotiate_review approve path — contract re-review.
// Spec: internal/bug-negotiate-drift.md (row 2: an approve of a real contract
// proposal on a Tester turn is a claim about the file; the Tester re-reviews
// the contract file read-only before the loop advances to Phase B).
//
// Pinned contract:
//  - row 2 fires on: decision approve AND even round AND lastProposal !== "agree".
//    Effect: round++, negotiateProposed=false, negotiateFeedback="",
//    justTransitioned=true, persist, send re-review prompt. No phase change.
//  - row 3 (advance to B) fires on: approve AND (odd round OR lastProposal === "agree").
//  - row 1 (feedback) is unchanged: negotiateFeedback = decision, persist.

import { describe, it, expect, vi } from "vitest";
import * as Tool from "../src/tools";
import * as GP from "../src/generic-prompts";
import type { LoopState } from "../src/types";
import { createMockExtensionAPI } from "./__mocks__/@earendil-works/pi-coding-agent";

// --- Fixtures ---

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
      ...overrides}};
}

function makeCtx(): any {
  return { ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "loop", hasUI: true };
}

async function runReview(state: { current: LoopState }, decision: string): Promise<{ pi: any; result: { content: { text: string }[] } }> {
  const pi = createMockExtensionAPI();
  const review = Tool.negotiateReview(state, pi as any, vi.fn());
  const result = await review.execute("call-1", { decision }, undefined, undefined, makeCtx());
  return { pi, result };
}

function lastLoopState(pi: { appendedEntries: any[] }): any {
  const entries = pi.appendedEntries.filter((e: any) => e.customType === "loop-state");
  return entries[entries.length - 1]?.data;
}

// --- Row 2: re-review round ---

describe("negotiate_review — row 2 (contract re-review)", () => {
  it("even round + real proposal + approve → re-review round: round 3, justTransitioned, no phase change, re-review prompt sent, persisted", async () => {
    const state = makeState({ round: 2, lastProposal: "plan X" });
    const { pi, result } = await runReview(state, "approve");

    expect(result.content[0].text).toBe("Proposal accepted. Re-reviewing the contract file before Phase B.");

    expect(state.current.phase).toBe("negotiate"); // no phase change
    expect(state.current.round).toBe(3);
    expect(state.current.justTransitioned).toBe(true);
    expect(state.current.negotiateProposed).toBe(false);
    expect(state.current.negotiateFeedback).toBe("");

    // The re-review prompt was sent, pinned verbatim against the Go pattern.
    // fix-negotiate-confirm-approval-loop §2: the prompt now ends with the
    // pinned advance sentence.
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptNegotiateContractReReview("*_test.go"));
    expect(pi.sentMessages[0].content).toBe(
      `You are the TESTER (contract re-review). The Writer's proposal was accepted. Verify the contract file matches the agreement.\nRead *_test.go. Use negotiate_review: 'approve' only if the file matches; otherwise feedback naming each drifted item.\nNo file writes.\nAn 'approve' here advances the loop to Phase B.`);
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });

    // Persisted AFTER the mutation (a reload mid-re-review must see round 3).
    const last = lastLoopState(pi);
    expect(last.round).toBe(3);
    expect(last.phase).toBe("negotiate");
    expect(last.justTransitioned).toBe(true);
  });

  it("row 2 fires on every even round with a non-agree proposal (round 4)", async () => {
    const state = makeState({ round: 4, lastProposal: "revised plan" });
    const { pi, result } = await runReview(state, "approve");

    expect(result.content[0].text).toBe("Proposal accepted. Re-reviewing the contract file before Phase B.");
    expect(state.current.round).toBe(5);
    expect(state.current.phase).toBe("negotiate");
    expect(pi.sentMessages[0].content).toContain("contract re-review");
  });
});

// --- Row 3: advance to B ---

describe("negotiate_review — row 3 (advance to B)", () => {
  it("odd round (the re-review round itself) + approve → advance directly to B", async () => {
    const state = makeState({ round: 3, lastProposal: "plan X" });
    const { pi, result } = await runReview(state, "approve");

    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.phase).toBe("B");
    expect(state.current.round).toBe(1);
    expect(state.current.justTransitioned).toBe(true);
    // No re-review prompt on the advancing approve.
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("'agree' proposal + even round + approve → advance directly (re-review skipped)", async () => {
    const state = makeState({ round: 2, lastProposal: "agree" });
    const { pi, result } = await runReview(state, "approve");

    expect(result.content[0].text).toBe("Approved.");
    expect(state.current.phase).toBe("B");
    expect(state.current.round).toBe(1);
    expect(pi.sentMessages).toHaveLength(0);
  });
});

// --- Row 1: feedback (unchanged) ---

describe("negotiate_review — row 1 (feedback, incl. on the re-review round)", () => {
  it("re-review round (odd) + feedback → Writer revision round: negotiateFeedback set, no phase change, no prompt", async () => {
    const state = makeState({ round: 3, lastProposal: "plan X" });
    const { pi, result } = await runReview(state, "S1 timeout should be 30s, not 120s");

    expect(result.content[0].text).toBe("Feedback recorded.");
    expect(state.current.phase).toBe("negotiate");
    expect(state.current.round).toBe(3); // round untouched by the tool
    expect(state.current.negotiateFeedback).toBe("S1 timeout should be 30s, not 120s");
    expect(pi.sentMessages).toHaveLength(0);

    const last = lastLoopState(pi);
    expect(last.negotiateFeedback).toBe("S1 timeout should be 30s, not 120s");
  });

  it("even round + feedback → Writer revision round (existing path, re-review NOT fired)", async () => {
    const state = makeState({ round: 2, lastProposal: "plan X" });
    const { pi, result } = await runReview(state, "make it faster");

    expect(result.content[0].text).toBe("Feedback recorded.");
    expect(state.current.phase).toBe("negotiate");
    expect(state.current.negotiateFeedback).toBe("make it faster");
    expect(pi.sentMessages).toHaveLength(0);
  });
});
