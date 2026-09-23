// Contract tests: fix-just-transitioned-settle-drop
// Spec: internal/fix-just-transitioned-settle-drop.md
//
// The `justTransitioned` flag is set at 4 entry points. Two of them (1:
// resetForPhaseB, 3: executeNegotiateReReview) deliver their prompt
// synchronously inside the tool call — the settle that follows a WORK turn
// after them must run the gate, not be consumed. The other two (2: /loop-patch,
// 4: advanceToPhaseB) are prompt-delivery settles and must be consumed.
//
// The fix adds a persisted marker `justTransitionedBySettle` to distinguish
// them. Pinned contract (spec sections S1-S4, Q1-Q5, Test Strategy 1-6):
//
//  S1 — entry points 2/4 set `justTransitionedBySettle: true`; 1/3 do not.
//  S2 — handleAgentSettled step 4: marker true → consumed (no gate, no
//       message, byte-identical debug line); marker false → clear flag,
//       CONTINUE the pipeline (dispute handlers, then the gate).
//  S3 — clearTransientFlags does NOT clear the marker (it survives restore);
//       justTransitioned still survives (resume trigger).
//  S4 — validator: marker is OPTIONAL (absent accepted, wrong type rejected);
//       clearTransientFlags heals absent → false; initial state and
//       resetPhaseState set it false.
//  Q2 — pair invariant: a saved (true, true) pair is consumed; (true, false)
//       gates. A stale-true marker cannot arise because no path sets
//       justTransitioned without writing the marker fresh.
//  Q3 — an ESC'd tool-triggered work turn leaves justTransitioned cleared
//       (the S2 tool-triggered branch clears it before the gate).
//  TS6 — no prompt double-delivery: after a tool-triggered settle that gates
//       into Phase C, the next before_agent_start delivers the normal Phase C
//       entry prompt, not the resume prompt.
//
// Unit tests only: runGates is mocked (test-speed rule — no real toolchain).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleAgentSettled } from "../src/events/agent-settled/index";
import type { AgentSettledDispatcherInput } from "../src/events/agent-settled/index";
import { handleBeforeAgent } from "../src/events/before-agent";
import type { BeforeAgentHandlerInput } from "../src/events/before-agent";
import { handleSessionStart } from "../src/events/session-start";
import type { SessionStartHandlerInput } from "../src/events/session-start";
import { computeTransition, computeNegotiateTransition } from "../src/transitions";
import { validateLoopState, validationErrors } from "../src/state-validation";
import { resetPhaseState } from "../src/state-helpers";
import { createInitialState } from "../src/commands/loop";
import * as Tool from "../src/tools";
import { cmdPatch } from "../src/commands";
import { runGates } from "../src/gates";
import { getLanguageConfig } from "../src/languages";
import type { LoopState, GateResult } from "../src/types";
import { createMockExtensionAPI } from "./__mocks__/@earendil-works/pi-coding-agent";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/gates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gates")>();
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
    buildTool: "go",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    gateTimeoutSec: 60,
    dispute: { status: "none" },
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    justTransitionedBySettle: false,
    negotiateReprompted: false,
    ...overrides,
  };
}

function gate(overrides: Partial<GateResult> = {}): { kind: "result"; result: GateResult } {
  return {
    kind: "result",
    result: {
      compile: true,
      compileError: "",
      allPassed: true,
      coverage: 85,
      failures: [],
      ...overrides,
    },
  };
}

function makeCtx(): any {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd: "/tmp/test-project",
  };
}

function makeSettledInput(overrides: Partial<AgentSettledDispatcherInput> = {}): {
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

function makeBeforeAgentInput(overrides: Partial<BeforeAgentHandlerInput> = {}): {
  input: BeforeAgentHandlerInput;
  pi: any;
  debug: ReturnType<typeof vi.fn>;
} {
  const pi = createMockExtensionAPI();
  const debug = vi.fn();
  const input: BeforeAgentHandlerInput = {
    state: { current: makeState() },
    pi: pi as any,
    debug,
    systemPrompt: "Base system prompt",
    ...overrides,
  };
  return { input, pi, debug };
}

function makeSessionInput(
  saved: unknown,
  overrides: Partial<SessionStartHandlerInput> = {},
): { input: SessionStartHandlerInput; ctx: any; debug: ReturnType<typeof vi.fn> } {
  const entries = saved === undefined ? [] : [{ type: "custom", customType: "loop-state", data: saved }];
  const ctx = {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => entries },
    cwd: "/tmp/test",
  };
  const debug = vi.fn();
  const input: SessionStartHandlerInput = {
    state: { current: makeState() },
    ctx,
    debug,
    ...overrides,
  };
  return { input, ctx, debug };
}

// A full valid saved entry (the shape the validator requires). The marker is
// added/removed per test to model pre-fix vs post-fix entries.
function savedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "B",
    round: 1,
    specPath: "spec.md",
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
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "negotiate",
    justTransitioned: true,
    negotiateReprompted: false,
    ...overrides,
  };
}

beforeEach(() => {
  runGatesMock.mockReset();
  runGatesMock.mockReturnValue(Promise.resolve(gate())); // default: all pass
});

// =====================================================================
// S2 — settle consumption only for settle-path flags (the fix)
// =====================================================================

describe("S2 — handleAgentSettled step 4", () => {
  it("consumed case unchanged: (true, true) → handled, both flags cleared, no gate, no message, byte-identical debug line", async () => {
    const state = makeState({ phase: "B", round: 1, justTransitioned: true, justTransitionedBySettle: true });
    const { input, pi, debug } = makeSettledInput({ state: { current: state } });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(state.justTransitioned).toBe(false);
    expect(state.justTransitionedBySettle).toBe(false); // cleared together (Q2)
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(
      "agent_settled: justTransitioned → clearing (no second prompt — the advance effect already sent it) (Phase B round 1)",
    );
  });

  it("consumed case in every non-terminal phase: (true, true) → no gate, no message (C round 1, A round 2)", async () => {
    for (const [phase, round] of [["C", 1], ["A", 2]] as const) {
      const state = makeState({ phase, round, justTransitioned: true, justTransitionedBySettle: true });
      const { input, pi } = makeSettledInput({ state: { current: state } });
      expect(await handleAgentSettled(input)).toBeUndefined();
      expect(state.justTransitioned).toBe(false);
      expect(state.justTransitionedBySettle).toBe(false);
      expect(pi.sentMessages).toHaveLength(0);
    }
    expect(runGatesMock).not.toHaveBeenCalled();
  });

  it("the fix: tool-triggered work settle (true, false) → gate runs, flag cleared, advance to C on green gate, commit point #2 persists", async () => {
    const stateRef = { current: makeState({ phase: "B", round: 1, justTransitioned: true, justTransitionedBySettle: false }) };
    const { input, pi, debug } = makeSettledInput({ state: stateRef });

    expect(await handleAgentSettled(input)).toBe(true); // applied
    expect(runGatesMock).toHaveBeenCalledTimes(1);
    expect(stateRef.current.phase).toBe("C"); // advanced by the green gate
    expect(stateRef.current.justTransitioned).toBe(false); // cleared in place
    // The tool-triggered debug line (new), not the consumed one.
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("justTransitioned (tool-triggered) → clearing, gate runs (work settle)"),
    );
    // Commit point #2 persisted the cleared flag + gate outcome.
    const loopEntries = pi.appendedEntries.filter((e: any) => e.customType === "loop-state");
    expect(loopEntries.length).toBeGreaterThanOrEqual(1);
    const last = loopEntries[loopEntries.length - 1].data as LoopState;
    expect(last.justTransitioned).toBe(false);
    expect(last.phase).toBe("C");
  });

  it("tool-triggered settle with a failing gate → retry round, flag still cleared, no escalation", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ allPassed: false, compile: true })));
    const stateRef = { current: makeState({ phase: "B", round: 1, maxB: 5, justTransitioned: true, justTransitionedBySettle: false }) };
    const { input } = makeSettledInput({ state: stateRef });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(stateRef.current.phase).toBe("B"); // stays in B
    expect(stateRef.current.round).toBe(2); // retry round
    expect(stateRef.current.justTransitioned).toBe(false);
  });

  it("flag false, marker false (no transition) → falls through to the gate (regression: normal work settle)", async () => {
    const stateRef = { current: makeState({ phase: "A", round: 1, justTransitioned: false, justTransitionedBySettle: false }) };
    const { input } = makeSettledInput({ state: stateRef });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
    expect(stateRef.current.phase).toBe("negotiate"); // A green gate advances
  });

  it("flag false, marker TRUE (corrupted/stale pair) → gate runs; the marker is never read when justTransitioned is false (Q2)", async () => {
    const stateRef = { current: makeState({ phase: "B", round: 1, justTransitioned: false, justTransitionedBySettle: true }) };
    const { input } = makeSettledInput({ state: stateRef });

    expect(await handleAgentSettled(input)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
    expect(stateRef.current.phase).toBe("C");
  });

  it("escalation still runs BEFORE step 4: both fire → escalation wins, flags untouched (Q4)", async () => {
    const stateRef = {
      current: makeState({
        phase: "B", round: 1, turnsThisPhase: 6, maxTurnsPerPhase: 5,
        justTransitioned: true, justTransitionedBySettle: false,
      }),
    };
    const { input, pi } = makeSettledInput({ state: stateRef });

    expect(await handleAgentSettled(input)).toBeUndefined();
    expect(stateRef.current.phase).toBe("escalated");
    expect(stateRef.current.justTransitioned).toBe(true); // step 4 never ran
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("Q3: an ESC'd tool-triggered work turn leaves justTransitioned cleared — the S2 tool-triggered branch clears it before the gate (both a green and a failing gate clear it)", async () => {
    // Green gate: the tool-triggered branch clears the flag, then the gate
    // advances. After the turn, justTransitioned is false — a reload would
    // deliver the full entry prompt, not the resume prompt.
    const stateRef = { current: makeState({ phase: "B", round: 1, justTransitioned: true, justTransitionedBySettle: false }) };
    const { input } = makeSettledInput({ state: stateRef });
    await handleAgentSettled(input);
    expect(stateRef.current.justTransitioned).toBe(false);
  });
});

// =====================================================================
// S1 — mark the settle-path entry points
// =====================================================================

describe("S1 — entry points set the marker", () => {
  it("entry point 4: advanceToPhaseB output (via computeTransition, A green gate) carries justTransitioned AND justTransitionedBySettle", () => {
    const state = makeState({ phase: "A", round: 1, justTransitioned: false, justTransitionedBySettle: false });
    const { state: next } = computeTransition(state, {
      compile: true, compileError: "", allPassed: true, coverage: 85, failures: [],
    });

    expect(next.phase).toBe("negotiate");
    // The settle-path B advance is reached from negotiate; exercise it
    // directly through the same pure transition the settle path uses.
    // (negotiateReprompted → autoAdvanceToPhaseB → advanceToPhaseB.)
    const negotiateState = makeState({ phase: "negotiate", round: 1, negotiateReprompted: true, justTransitioned: false, justTransitionedBySettle: false });
    const { state: phaseB } = computeNegotiateTransition(negotiateState);

    expect(phaseB.phase).toBe("B");
    expect(phaseB.justTransitioned).toBe(true);
    expect(phaseB.justTransitionedBySettle).toBe(true); // settle-path: consumed
  });

  it("entry point 2: /loop-patch sets justTransitionedBySettle (re-entry prompt → consumed semantics)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-marker-"));
    mkdirSync(join(tmpDir, "internal"), { recursive: true });
    writeFileSync(join(tmpDir, "internal", "test-spec.md"), "# spec\n");
    try {
      const state = { current: makeState({ phase: "B", round: 3, specPath: "internal/test-spec.md", lastPhase: "A" }) };
      const pi = createMockExtensionAPI();
      const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() }, cwd: tmpDir };
      const cmd = cmdPatch(state, pi as any, vi.fn());
      await cmd.handler("", ctx as any);

      expect(state.current.phase).toBe("A"); // no --from → restart from A
      expect(state.current.justTransitioned).toBe(true);
      expect(state.current.justTransitionedBySettle).toBe(true); // the marker
      // The re-entry prompt was delivered synchronously.
      expect(pi.sentMessages).toHaveLength(1);
      expect(pi.sentMessages[0].content).toContain("patched");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("entry point 1: resetForPhaseB (negotiate_review row 3, odd round approve) sets justTransitioned but NOT the marker", async () => {
    const stateRef = { current: makeState({
      phase: "negotiate", round: 3, lastProposal: "plan X",
      justTransitioned: false, justTransitionedBySettle: false,
    }) };
    const pi = createMockExtensionAPI();
    const review = Tool.negotiateReview(stateRef, pi as any, vi.fn());
    await review.execute("call-1", { decision: "approve" }, undefined, undefined, {
      ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "loop", hasUI: true,
    } as any);

    expect(stateRef.current.phase).toBe("B");
    expect(stateRef.current.justTransitioned).toBe(true);
    expect(stateRef.current.justTransitionedBySettle).toBe(false); // tool-triggered: gate runs
  });

  it("entry point 3: executeNegotiateReReview (row 2, even round approve) sets justTransitioned but NOT the marker", async () => {
    const stateRef = { current: makeState({
      phase: "negotiate", round: 2, lastProposal: "plan X",
      justTransitioned: false, justTransitionedBySettle: false,
    }) };
    const pi = createMockExtensionAPI();
    const review = Tool.negotiateReview(stateRef, pi as any, vi.fn());
    await review.execute("call-1", { decision: "approve" }, undefined, undefined, {
      ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "loop", hasUI: true,
    } as any);

    expect(stateRef.current.phase).toBe("negotiate"); // no phase change
    expect(stateRef.current.round).toBe(3); // re-review round
    expect(stateRef.current.justTransitioned).toBe(true);
    expect(stateRef.current.justTransitionedBySettle).toBe(false); // tool-triggered: gate runs
  });
});

// =====================================================================
// S3 — reload-resume composition (clearTransientFlags)
// =====================================================================

describe("S3 — reload-resume composition", () => {
  it("clearTransientFlags does NOT clear the marker (it survives restore): (true, true) stays (true, true)", () => {
    const { input } = makeSessionInput(savedEntry({ justTransitionedBySettle: true }));
    handleSessionStart(input);

    expect(input.state.current.justTransitioned).toBe(true); // resume trigger survives
    expect(input.state.current.justTransitionedBySettle).toBe(true); // marker survives
    expect(input.state.current.phase).toBe("B");
  });

  it("justTransitioned still survives restore (resume trigger — unchanged by the fix)", () => {
    const { input } = makeSessionInput(savedEntry({}));
    handleSessionStart(input);

    expect(input.state.current.justTransitioned).toBe(true);
  });

  it("post-resume settle semantics: a restored (true, true) settle-path flag is CONSUMED on the next settle (TS5 — the marker wins, must not gate)", async () => {
    const { input } = makeSessionInput(savedEntry({ justTransitionedBySettle: true }));
    handleSessionStart(input);

    // Now settle the resumed turn: the marker true → consumed, no gate.
    const { input: settled, pi } = makeSettledInput({ state: input.state });
    expect(await handleAgentSettled(settled)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();
    expect(input.state.current.justTransitioned).toBe(false);
    expect(input.state.current.justTransitionedBySettle).toBe(false);
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("post-resume settle semantics: a restored tool-triggered (true, false) flag GATES on the next settle (S3 pin)", async () => {
    const { input } = makeSessionInput(savedEntry({ justTransitionedBySettle: false }));
    handleSessionStart(input);

    const { input: settled } = makeSettledInput({ state: input.state });
    expect(await handleAgentSettled(settled)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
    expect(input.state.current.justTransitioned).toBe(false);
    expect(input.state.current.phase).toBe("C");
  });

  it("S3 + TS6: after a tool-triggered settle gates into Phase C, the next before_agent_start delivers the NORMAL Phase C entry prompt, not the resume prompt", async () => {
    // Settle: tool-triggered work settle gates B → C.
    const stateRef = { current: makeState({ phase: "B", round: 1, justTransitioned: true, justTransitionedBySettle: false }) };
    const { input: settled } = makeSettledInput({ state: stateRef });
    await handleAgentSettled(settled);

    // Next turn: flag false → normal entry prompt (row 3), not resume (row 2).
    const { input: before, debug } = makeBeforeAgentInput({ state: stateRef });
    const out = handleBeforeAgent(before);
    expect(out).toBeDefined();
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining("resume prompt"));
    // The normal Phase C entry prompt is the Cleaner prompt from the Go config.
    // The message is the loop-context envelope; the content carries the
    // normal Phase C entry prompt (the Cleaner prompt from the Go config).
    expect(out!.message).toHaveProperty("customType", "loop-context");
    expect(String(out!.message.content)).toContain(GO.prompts.promptCleanerPhaseC("."));
  });
});

// =====================================================================
// S4 — validator, heal, and initial state
// =====================================================================

describe("S4 — validator, heal, initial state", () => {
  it("validator accepts a PRE-FIX entry with the marker ABSENT (optional field)", () => {
    const entry = savedEntry();
    delete entry.justTransitionedBySettle; // pre-fix: field absent
    expect(validateLoopState(entry)).toBe(true);
  });

  it("validator accepts the marker present (both values)", () => {
    expect(validateLoopState(savedEntry({ justTransitionedBySettle: true }))).toBe(true);
    expect(validateLoopState(savedEntry({ justTransitionedBySettle: false }))).toBe(true);
  });

  it("validator REJECTS a wrong-type marker (a string is not a boolean)", () => {
    const entry = savedEntry({ justTransitionedBySettle: "yes" });
    expect(validateLoopState(entry)).toBe(false);
    expect(validationErrors(entry).some((e) => e.includes("justTransitionedBySettle"))).toBe(true);
  });

  it("heal: clearTransientFlags on a pre-fix entry (field absent, justTransitioned true) → justTransitionedBySettle === false", () => {
    const entry = savedEntry(); // justTransitioned: true, marker absent
    delete entry.justTransitionedBySettle;
    const { input } = makeSessionInput(entry);
    handleSessionStart(input);

    expect(input.state.current.justTransitionedBySettle).toBe(false); // healed
    expect(input.state.current.justTransitioned).toBe(true); // still the resume trigger
  });

  it("heal: the healed pre-fix entry resumes, and the post-work settle RUNS THE gate (TS4 + S4)", async () => {
    const entry = savedEntry(); // B, justTransitioned true, marker absent
    delete entry.justTransitionedBySettle;
    const { input } = makeSessionInput(entry);
    handleSessionStart(input);

    const { input: settled } = makeSettledInput({ state: input.state });
    expect(await handleAgentSettled(settled)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1); // healed false → tool-triggered → gate
    expect(input.state.current.justTransitioned).toBe(false);
    expect(input.state.current.phase).toBe("C");
  });

  it("initial state (createInitialState) sets justTransitionedBySettle: false", () => {
    const state = createInitialState("spec.md", "go", "go");
    expect(state.justTransitioned).toBe(false);
    expect(state.justTransitionedBySettle).toBe(false);
  });

  it("resetPhaseState sets justTransitionedBySettle: false (human restarts clear the pair)", () => {
    const state = makeState({ phase: "B", round: 3, justTransitioned: true, justTransitionedBySettle: true });
    resetPhaseState(state);
    expect(state.justTransitioned).toBe(false);
    expect(state.justTransitionedBySettle).toBe(false); // marker cleared too
  });
});

// =====================================================================
// TS3 — regression fixture: the 01a0ba95 sequence
// =====================================================================

describe("TS3 — regression fixture (01a0ba95)", () => {
  it("negotiate→B via entry point 1, Writer works, settle → gate runs, advances to C; flag cleared; no prompt re-delivery", async () => {
    // 1. Entry point 1: the Tester's negotiate_review(approve) on the
    //    re-review round (odd round) fires resetForPhaseB → phase B.
    const stateRef = { current: makeState({
      phase: "negotiate", round: 3, lastProposal: "plan X",
      justTransitioned: false, justTransitionedBySettle: false,
    }) };
    const toolPi = createMockExtensionAPI();
    const review = Tool.negotiateReview(stateRef, toolPi as any, vi.fn());
    await review.execute("call-1", { decision: "approve" }, undefined, undefined, {
      ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "loop", hasUI: true,
    } as any);

    expect(stateRef.current.phase).toBe("B");
    expect(stateRef.current.justTransitioned).toBe(true);
    expect(stateRef.current.justTransitionedBySettle).toBe(false); // entry point 1

    // 2. The Writer does its work (a work turn — no further tool calls).
    // 3. agent_settled fires. Pre-fix this settle was swallowed (no gate, no
    //    commit, no advance). Post-fix it must run the gate and advance to C.
    const { input, pi, debug } = makeSettledInput({ state: stateRef });
    expect(await handleAgentSettled(input)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1); // the gate RAN (the fix)
    expect(stateRef.current.phase).toBe("C"); // advanced
    expect(stateRef.current.justTransitioned).toBe(false); // flag cleared
    expect(stateRef.current.justTransitionedBySettle).toBe(false); // pair invariant
    // No prompt was re-delivered by the settle (the advance effect's prompt is
    // the Phase C entry prompt, delivered via the effect — not a second
    // justTransitioned prompt). The consumed-case debug line must NOT appear.
    expect(debug).not.toHaveBeenCalledWith(
      expect.stringContaining("no second prompt"),
    );
    // The settle delivered the Phase C advance prompt exactly once.
    const cleanerPrompts = pi.sentMessages.filter((m: any) =>
      typeof m.content === "string" && m.content.includes("Phase C"),
    );
    expect(cleanerPrompts).toHaveLength(1);
  });
});

// =====================================================================
// Q2 — pair invariant (single logical signal)
// =====================================================================

describe("Q2 — pair invariant", () => {
  it("a saved (true, true) pair is CONSUMED; a (true, false) pair GATES — the marker is the discriminator", async () => {
    const consumed = makeState({ phase: "B", round: 1, justTransitioned: true, justTransitionedBySettle: true });
    const { input: inC } = makeSettledInput({ state: { current: consumed } });
    expect(await handleAgentSettled(inC)).toBeUndefined();
    expect(runGatesMock).not.toHaveBeenCalled();

    runGatesMock.mockReset();
    runGatesMock.mockReturnValue(Promise.resolve(gate()));
    const gated = makeState({ phase: "B", round: 1, justTransitioned: true, justTransitionedBySettle: false });
    const { input: inG } = makeSettledInput({ state: { current: gated } });
    expect(await handleAgentSettled(inG)).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
  });

  it("the S2 tool-triggered branch deliberately does NOT clear the marker — it relies on the pair invariant (marker stays as-is; flag cleared)", async () => {
    // A (true, false) work settle: after it, justTransitioned is false. The
    // marker is not read while the flag is false (Q2), so its value is
    // immaterial — pin that the flag is what the dispatcher keys on.
    const stateRef = { current: makeState({ phase: "B", round: 1, justTransitioned: true, justTransitionedBySettle: false }) };
    const { input } = makeSettledInput({ state: stateRef });
    await handleAgentSettled(input);
    expect(stateRef.current.justTransitioned).toBe(false);
  });
});
