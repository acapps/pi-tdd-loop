// Regression: bug-negotiate-settle-not-persisted.md
// The negotiate settle path commits the advanced state (commit point #1 of
// refactor-single-commit-point). A reload at any point in the negotiate cycle
// restores a machine in sync with the conversation: no re-prompt of the agent
// who just acted, no re-delivery of an already-delivered proposal/feedback.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleAgentSettled } from "../src/events/agent-settled/index";
import type { LoopState } from "../src/types";

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "negotiate", round: 1, specPath: "spec.md", language: "go", buildTool: "go",
    maxA: 3, maxNegotiate: 3, maxB: 3, maxC: 3, maxDispute: 3, maxTurnsPerPhase: 5,
  coverageThreshold: 80, disputeCount: 0, turnsThisPhase: 1,
  gateTimeoutSec: 60,
    lastProposal: "propose X", lastPhase: "A", justTransitioned: false,
    negotiateReprompted: false, ...overrides};
}

interface Env {
  state: { current: LoopState };
  pi: ExtensionAPI;
  appendEntry: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  ctx: never;
}

function makeEnv(overrides: Partial<LoopState> = {}): Env {
  const state = { current: makeState(overrides) };
  const appendEntry = vi.fn();
  const sendUserMessage = vi.fn();
  const pi = { appendEntry, sendUserMessage } as unknown as ExtensionAPI;
  const ctx = { pi, ui: { notify: vi.fn(), setStatus: vi.fn() }, cwd: "/tmp" } as never;
  return { state, pi, appendEntry, sendUserMessage, ctx };
}

function loopEntries(appendEntry: ReturnType<typeof vi.fn>): LoopState[] {
  return appendEntry.mock.calls.filter((c) => c[0] === "loop-state").map((c) => c[1] as LoopState);
}

describe("bug-negotiate-settle-not-persisted — settle commits the advanced state", () => {
  it("proposal delivered → commit carries round N+1 with markers cleared (reload row 1)", async () => {
    // Writer proposed (round 1, odd): the settle delivers the review request to
    // Tester and commits the advanced round. A reload restores round 2 (even)
    // with no markers → the next settle re-prompts Tester, not Writer.
    const { state, pi, appendEntry, sendUserMessage, ctx } = makeEnv({
      negotiateProposed: true});
    await handleAgentSettled({ state, pi, debug: () => {}, ctx });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const entries = loopEntries(appendEntry);
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(last.round).toBe(2);
    expect(last.negotiateProposed).toBe(false);
    expect(last.negotiateFeedback).toBe("");
    expect(last.phase).toBe("negotiate");
  });

  it("feedback delivered → commit carries round N+1 with feedback cleared (reload row 2)", async () => {
    // Tester reviewed (round 2, even): the settle delivers the feedback to
    // Writer and commits. A reload must NOT re-deliver the same feedback.
    const { state, pi, appendEntry, sendUserMessage, ctx } = makeEnv({
      round: 2,
      negotiateFeedback: "add edge cases"});
    await handleAgentSettled({ state, pi, debug: () => {}, ctx });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const entries = loopEntries(appendEntry);
    const last = entries[entries.length - 1];
    expect(last.round).toBe(3);
    expect(last.negotiateFeedback).toBe("");
    expect(last.phase).toBe("negotiate");
  });

  it("reprompt delivered → commit carries negotiateReprompted (reload row 3)", async () => {
    // No marker set: parity reprompt. The committed flag is transient (cleared
    // on restore by clearTransientFlags) — pinned: the current behavior.
    const { state, pi, appendEntry, ctx } = makeEnv({ round: 1 });
    await handleAgentSettled({ state, pi, debug: () => {}, ctx });
    const entries = loopEntries(appendEntry);
    const last = entries[entries.length - 1];
    expect(last.negotiateReprompted).toBe(true);
    expect(last.round).toBe(1);
  });

  it("auto-advance to B → commit carries phase B, round 1 (reload row 4)", async () => {
    const { state, pi, appendEntry, ctx } = makeEnv({ negotiateReprompted: true });
    await handleAgentSettled({ state, pi, debug: () => {}, ctx });
    const entries = loopEntries(appendEntry);
    const last = entries[entries.length - 1];
    expect(last.phase).toBe("B");
    expect(last.round).toBe(1);
  });

  it("escalation → commit carries phase escalated (reload row 5)", async () => {
    // maxNegotiate exhausted: feedback at round 5 → (5+2)/2 = 3.5 > 3.
    // (Round 4 is the boundary: (4+2)/2 = 3 <= 3 still advances.)
    const { state, pi, appendEntry, ctx } = makeEnv({
      round: 5,
      negotiateFeedback: "one more"});
    await handleAgentSettled({ state, pi, debug: () => {}, ctx });
    const entries = loopEntries(appendEntry);
    const last = entries[entries.length - 1];
    expect(last.phase).toBe("escalated");
  });
});
