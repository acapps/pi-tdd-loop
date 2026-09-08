// Contract tests for the two validateLoopState call sites —
// internal/refactor-state-model-divergence.md (Interface, call sites 1–2).
//
// 1. src/commit.ts:commit — validate before persist; on failure log the
//    pinned debug line and STILL persist (quirk Q1).
// 2. src/events/session-start.ts:handleSessionStart — validate the restored
//    entry; on failure quarantine with the pinned status + debug strings.
//
// No real processes: everything here is pure state + mock UI/sessionManager.

import { describe, it, expect, vi } from "vitest";
import { commit } from "../src/commit";
import { handleSessionStart } from "../src/events/session-start";
import type { SessionStartHandlerInput } from "../src/events/session-start";
import type { LoopState } from "../src/types";

// --- Shared fixture builders ---

function makeState(overrides?: Partial<LoopState>): LoopState {
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
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides};
}

function makeInitialState(): LoopState {
  return makeState({
    phase: "idle",
    round: 0,
    specPath: "",
    turnsThisPhase: 0,
    lastPhase: "idle"});
}

function stateEntry(data: unknown): Record<string, unknown> {
  return { type: "custom", customType: "loop-state", data };
}

// ================================================================
// Call site 1 — commit(): validate-then-persist (Q1)
// ================================================================

describe("commit — valid state", () => {
  it("persists the state as a loop-state entry", () => {
    const appendEntry = vi.fn();
    const debug = vi.fn();
    commit(makeState(), { appendEntry }, debug);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith("loop-state", expect.objectContaining({ phase: "A", round: 1 }));
  });

  it("does not log a validation-failure debug line", () => {
    const debug = vi.fn();
    commit(makeState(), { appendEntry: vi.fn() }, debug);
    expect(debug).not.toHaveBeenCalledWith(
      expect.stringContaining("commit: state failed validation")
    );
  });

  it("persists the live initial idle state (round 0, turnsThisPhase 0)", () => {
    const appendEntry = vi.fn();
    commit(makeInitialState(), { appendEntry }, vi.fn());
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });

  it("persists a done state that keeps its round (row 1)", () => {
    const appendEntry = vi.fn();
    const debug = vi.fn();
    commit(makeState({ phase: "done", round: 3, lastPhase: "C" }), { appendEntry }, debug);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("failed validation"));
  });

  it("persists the A-escalation state (row 2)", () => {
    const appendEntry = vi.fn();
    commit(makeState({ phase: "escalated", lastPhase: "A" }), { appendEntry }, vi.fn());
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });
});

describe("commit — broken state (Q1: persist anyway)", () => {
  it("persists AND logs the pinned debug line for an invalid state", () => {
    const appendEntry = vi.fn();
    const debug = vi.fn();
    const broken = makeState({ phase: "escalated", lastPhase: "idle" }); // row 2 violation
    commit(broken, { appendEntry }, debug);

    // Q1: the broken state is STILL persisted.
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith("loop-state", expect.objectContaining({ phase: "escalated" }));
    // Pinned debug prefix.
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("commit: state failed validation —")
    );
  });

  it("persists a shape-broken state (wrong-typed field)", () => {
    const appendEntry = vi.fn();
    const debug = vi.fn();
    commit(makeState({ round: "one" } as unknown as Partial<LoopState>), { appendEntry }, debug);
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("commit: state failed validation"));
  });

  it("never throws on a broken state", () => {
    expect(() =>
      commit(makeState({ phase: "nope" as never }), { appendEntry: vi.fn() }, vi.fn())
    ).not.toThrow();
  });
});

// ================================================================
// Call site 2 — handleSessionStart: quarantine on invalid restore
// Pinned strings (refactor-single-commit-point.md):
//   status: "state corrupted — run /loop to restart"
//   debug:  "session_start: restored entry failed validation — quarantining"
// ================================================================

describe("handleSessionStart — restore validation (quarantine)", () => {
  function makeInput(entries: unknown[], overrides: Partial<SessionStartHandlerInput> = {}): SessionStartHandlerInput {
    return {
      state: { current: makeState() },
      ctx: {
        ui: { notify: vi.fn(), setStatus: vi.fn() },
        sessionManager: { getEntries: () => entries },
        cwd: "/tmp/test"} as never,
      debug: vi.fn(),
      ...overrides};
  }

  it("quarantines an invalid restored entry: pinned status + debug, state NOT loaded", () => {
    const input = makeInput([
      stateEntry(makeState({ phase: "escalated", lastPhase: "idle" })), // row 2 violation
    ]);
    handleSessionStart(input);

    const ui = (input.ctx as unknown as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui;
    expect(ui.setStatus).toHaveBeenCalledWith("loop", "state corrupted — run /loop to restart");
    expect(input.debug).toHaveBeenCalledWith(
      "session_start: restored entry failed validation — quarantining"
    );
    // Quarantined: the broken state must NOT be loaded into state.current.
    expect(input.state.current.phase).not.toBe("escalated");
  });

  it("quarantines a shape-broken entry (wrong-typed round)", () => {
    const input = makeInput([stateEntry({ ...makeState(), round: "one" })]);
    handleSessionStart(input);
    expect((input.ctx as any).ui.setStatus).toHaveBeenCalledWith(
      "loop",
      "state corrupted — run /loop to restart"
    );
    expect(input.debug).toHaveBeenCalledWith(
      "session_start: restored entry failed validation — quarantining"
    );
  });

  it("quarantines an entry with null data", () => {
    const input = makeInput([{ type: "custom", customType: "loop-state", data: null }]);
    handleSessionStart(input);
    expect((input.ctx as any).ui.setStatus).toHaveBeenCalledWith(
      "loop",
      "state corrupted — run /loop to restart"
    );
  });

  it("restores a valid entry normally (no quarantine status)", () => {
    const input = makeInput([stateEntry(makeState({ phase: "B", lastPhase: "A", round: 2 }))]);
    handleSessionStart(input);
    const ui = (input.ctx as any).ui;
    expect(ui.setStatus).not.toHaveBeenCalledWith("loop", "state corrupted — run /loop to restart");
    expect(input.state.current.phase).toBe("B");
    expect(input.state.current.round).toBe(2);
  });

  it("restores the live initial idle state (round 0 / turnsThisPhase 0) — the old validator rejected it", () => {
    const input = makeInput([stateEntry(makeInitialState())]);
    handleSessionStart(input);
    expect((input.ctx as any).ui.setStatus).not.toHaveBeenCalledWith(
      "loop",
      "state corrupted — run /loop to restart"
    );
    expect(input.state.current.phase).toBe("idle");
  });

  it("still clears transient flags on a valid restore", () => {
    const saved = makeState({
      justTransitioned: true,
      negotiateReprompted: true});
    const input = makeInput([stateEntry(saved)]);
    handleSessionStart(input);
    expect(input.state.current.justTransitioned).toBe(false);
    expect(input.state.current.negotiateReprompted).toBe(false);
    expect(input.state.current.dispute?.status === "conceded").toBe(false);
    expect(input.state.current.dispute?.status === "defended").toBe(false);
  });

  it("ignores entries that are not loop-state entries (no quarantine, no restore)", () => {
    const input = makeInput([{ type: "custom", customType: "loop-debug", data: { msg: "x" } }]);
    handleSessionStart(input);
    expect((input.ctx as any).ui.setStatus).not.toHaveBeenCalledWith(
      "loop",
      "state corrupted — run /loop to restart"
    );
  });

  it("quarantines only the LAST loop-state entry (earlier valid entries are irrelevant)", () => {
    const input = makeInput([
      stateEntry(makeState({ phase: "B", lastPhase: "A" })),
      stateEntry(makeState({ phase: "escalated", lastPhase: "idle" })), // last = broken
    ]);
    handleSessionStart(input);
    expect((input.ctx as any).ui.setStatus).toHaveBeenCalledWith(
      "loop",
      "state corrupted — run /loop to restart"
    );
  });
});
