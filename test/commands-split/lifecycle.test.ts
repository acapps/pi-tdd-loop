// Contract tests for src/commands/lifecycle.ts — internal/refactor-commands-split.md
//
// Pins cmdCancel, cmdApprove, cmdStop. Behavior is pinned VERBATIM from the
// current src/commands.ts (pure refactor — no behavioral change).
//
// Leaf modules (commit, phase-a, prompt) are mocked; tests assert on the
// command layer's state mutation + notification decisions.
// Fast + hermetic: no process spawning.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState } from "../../src/types";

vi.mock("../../src/commit", () => ({ commit: vi.fn() }));
vi.mock("../../src/phase-a", () => ({ startPhaseA: vi.fn() }));
vi.mock("../../src/prompt", () => ({ sendPrompt: vi.fn() }));
vi.mock("../../src/state-helpers", () => ({
  isIdleOrDone: vi.fn((p: string) => p === "idle" || p === "done"),
}));

import { cmdCancel, cmdApprove, cmdStop } from "../../src/commands/lifecycle";
import * as Commit from "../../src/commit";
import * as PhaseA from "../../src/phase-a";

beforeEach(() => {
  vi.clearAllMocks();
  (PhaseA.startPhaseA as ReturnType<typeof vi.fn>).mockImplementation((s: any, pi: any) => {
    s.phase = "A";
    s.round = 1;
  });
});

// --- Fixtures -------------------------------------------------------------

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
    round: 3,
    specPath: "internal/spec.md",
    language: "go",
    buildTool: "go",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    gateTimeoutSec: 60,
    dispute: { status: "filed", filer: "tester", claim: "x" },
    disputeCount: 1,
    turnsThisPhase: 2,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides,
  };
}

function makeApi(): ExtensionAPI {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    state: { cwd: "/tmp/proj", model: { id: "test" } },
  } as unknown as ExtensionAPI;
}

function makeCtx(cwd = "/tmp/proj") {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd,
  } as any;
}

const debug = vi.fn();

// ================================================================
// Module contract
// ================================================================

describe("src/commands/lifecycle.ts — module contract", () => {
  it("exports cmdCancel, cmdApprove, cmdStop", () => {
    expect(typeof cmdCancel).toBe("function");
    expect(typeof cmdApprove).toBe("function");
    expect(typeof cmdStop).toBe("function");
  });
});

// ================================================================
// cmdCancel — verbatim from src/commands.ts:584-599
// ================================================================

describe("cmdCancel", () => {
  it("unconditionally returns to idle, clears dispute, zeroes round, commits", async () => {
    const state = { current: makeState({ phase: "C", round: 5 }) };
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdCancel(state, pi, debug).handler("", ctx);
    expect(state.current.phase).toBe("idle");
    expect(state.current.dispute).toEqual({ status: "none" });
    expect(state.current.round).toBe(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop cancelled.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "idle");
    expect(Commit.commit).toHaveBeenCalledWith(state.current, pi, debug);
    expect(debug).toHaveBeenCalledWith("Command: /loop-cancel → idle");
  });

  it("works from any phase, including review/done (no guard)", async () => {
    const state = { current: makeState({ phase: "done" }) };
    const ctx = makeCtx();
    await cmdCancel(state, makeApi(), debug).handler("", ctx);
    expect(state.current.phase).toBe("idle");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop cancelled.", "info");
  });
});

// ================================================================
// cmdApprove — verbatim from src/commands.ts:601-619
// ================================================================

describe("cmdApprove", () => {
  it("phase !== 'review' → warning, no startPhaseA", async () => {
    for (const phase of ["A", "B", "C", "done", "idle", "escalated", "negotiate"] as const) {
      const state = { current: makeState({ phase }) };
      const ctx = makeCtx();
      await cmdApprove(state, makeApi(), debug).handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Not in Phase 0 review. Run /loop <spec-path> to start.", "warning");
      expect(PhaseA.startPhaseA).not.toHaveBeenCalled();
    }
  });

  it("phase 'review' → delegates to startPhaseA(state, pi, ctx, debug)", async () => {
    const state = { current: makeState({ phase: "review" }) };
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdApprove(state, pi, debug).handler("", ctx);
    expect(PhaseA.startPhaseA).toHaveBeenCalledWith(state, pi, ctx, debug);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});

// ================================================================
// cmdStop — verbatim from src/commands.ts:621-643
// ================================================================

describe("cmdStop", () => {
  it("idle → 'Loop is not running.' (no commit)", async () => {
    const state = { current: makeState({ phase: "idle" }) };
    const ctx = makeCtx();
    await cmdStop(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop is not running.", "warning");
    expect(Commit.commit).not.toHaveBeenCalled();
    expect(state.current.phase).toBe("idle");
  });

  it("done → 'Loop is not running.' (isIdleOrDone covers both)", async () => {
    const state = { current: makeState({ phase: "done" }) };
    const ctx = makeCtx();
    await cmdStop(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop is not running.", "warning");
    expect(state.current.phase).toBe("done");
  });

  it("active phase → escalated, lastPhase preserved, round preserved in message", async () => {
    const state = { current: makeState({ phase: "C", round: 4 }) };
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdStop(state, pi, debug).handler("", ctx);
    expect(state.current.phase).toBe("escalated");
    expect(state.current.lastPhase).toBe("C");
    expect(Commit.commit).toHaveBeenCalledWith(state.current, pi, debug);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Loop stopped at Phase C, round 4. Run /loop-continue to resume.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Stopped — Phase C round 4");
    expect(debug).toHaveBeenCalledWith("Command: /loop-stop → phase C → escalated");
  });
});
