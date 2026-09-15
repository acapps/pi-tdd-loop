// Regression: justTransitioned must be cleared when a dispute is filed or the
// Writer concedes, so the next settle runs the gate instead of being consumed
// by handleJustTransitioned.
//
// Live-session bug (01a0a668): negotiate→B transition set justTransitioned.
// Writer conceded the dispute mid-turn. Agent settled. handleJustTransitioned
// consumed the settle (cleared the flag, no gate). Loop stalled until session
// restore cleared justTransitioned.

import { describe, it, expect, vi } from "vitest";
import { executeWriterConcedeDispute, handleBDisputePropose } from "../src/tools/dispute";
import type { LoopState } from "../src/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolCtx } from "../src/tools/types";

function makeToolCtx(): ToolCtx {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    mode: "loop",
    hasUI: true,
  };
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    specPath: "internal/test-spec.md",
    phase: "B",
    round: 1,
    turnsThisPhase: 0,
    maxA: 5,
    maxNegotiate: 5,
    maxB: 5,
    maxC: 5,
    maxDispute: 3,
    maxTurnsPerPhase: 10,
    lastProposal: "implement the fix",
    negotiateFeedback: "",
    lastGateResult: undefined,
    justTransitioned: true, // ← the critical precondition
    dispute: { status: "filed", filer: "tester", claim: "Test Y is wrong", filedRound: 1 },
    language: "go",
    buildTool: "go",
    gateTimeoutSec: 120,
    coverageThreshold: 80,
    disputeCount: 0,
    lastPhase: "negotiate",
    negotiateReprompted: false,
    ...overrides,
  };
}

function makeMockPi(): ExtensionAPI {
  return {
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionAPI;
}

describe("justTransitioned + dispute interaction", () => {
  it("executeWriterConcedeDispute clears justTransitioned", () => {
    const state = makeState();
    expect(state.justTransitioned).toBe(true);
    expect(state.dispute?.status).toBe("filed");

    const pi = makeMockPi();
    const debug = vi.fn();
    const result = executeWriterConcedeDispute(
      { current: state } as any,
      pi,
      debug,
    );

    expect(result.content[0].text).toContain("Dispute closed");
    expect(state.dispute?.status).toBe("closed");
    expect(state.justTransitioned).toBe(false); // ← the fix
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("clearing justTransitioned"),
    );
  });

  it("executeWriterConcedeDispute does NOT set justTransitioned if already false", () => {
    const state = makeState({ justTransitioned: false });
    expect(state.justTransitioned).toBe(false);

    const pi = makeMockPi();
    const debug = vi.fn();
    executeWriterConcedeDispute({ current: state } as any, pi, debug);

    expect(state.justTransitioned).toBe(false);
    // No "clearing justTransitioned" debug message (it was already false)
    const clearingMsgs = debug.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("clearing justTransitioned"),
    );
    expect(clearingMsgs).toHaveLength(0);
  });

  it("handleBDisputePropose (file path) clears justTransitioned", () => {
    const state = makeState({
      dispute: { status: "none" },
      justTransitioned: true,
    });
    expect(state.justTransitioned).toBe(true);

    const pi = makeMockPi();
    const debug = vi.fn();
    const result = handleBDisputePropose(
      { current: state } as any,
      pi,
      debug,
      makeToolCtx(),
      "Test Y is wrong", // plan parameter
    );

    // Dispute should be filed
    expect(state.dispute?.status).toBe("filed");
    expect(state.justTransitioned).toBe(false); // ← the fix
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("clearing justTransitioned"),
    );
  });

  it("handleBDisputePropose (concede path) clears justTransitioned via executeWriterConcedeDispute", () => {
    const state = makeState({
      dispute: { status: "filed", filer: "tester", claim: "Test Z", filedRound: 1 },
      justTransitioned: true,
    });

    const pi = makeMockPi();
    const debug = vi.fn();
    // "agree" triggers the concede path
    const result = handleBDisputePropose(
      { current: state } as any,
      pi,
      debug,
      makeToolCtx(),
      "agree", // plan parameter
    );

    expect(state.dispute?.status).toBe("closed");
    expect(state.justTransitioned).toBe(false);
  });
});
