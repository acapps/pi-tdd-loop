// Contract tests for the gate-transition handler (Phases A/B/C).
// Spec: internal/04-implement-agent-settled-handlers.md (G1, G2, G3, Note).
//
// Pinned contract:
//  - Pure-state: takes a BARE LoopState, never mutates it, returns the new state (G2).
//  - Input carries pi (G1) — applyEffect stays inline here until spec 05.
//  - Output { state, gateResult, applied } — the effect is consumed internally
//    (no effect/prompt fields on the output).
//  - runGates(ctx.cwd, coverageThreshold, language, buildTool, phase).
//  - The handler does NOT set lastGateResult — the dispatcher does (G3).
//  - Effect side effects + debug strings follow the monolith verbatim.
//  - No error handling: gate command failures surface as GateResult fields.
//
// runGates is mocked (the only external I/O); computeTransition is real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleGateTransition, NO_GATE } from "../../../src/events/agent-settled/gate-transition";
import { handleToolCall } from "../../../src/events/tool-call";
import type { GateHandlerInput } from "../../../src/events/agent-settled/gate-transition";
import type { LoopState, GateResult } from "../../../src/types";
import { getLanguageConfig } from "../../../src/languages";
import * as GP from "../../../src/generic-prompts";
import * as archive from "../../../src/spec-archive";
import { runGates, formatFailures } from "../../../src/gates";
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
  gateTimeoutSec: 60,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    dispute: { status: "none" },
    ...overrides};
}

function makeCtx(overrides: { cwd?: string } = {}): any {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd: "/tmp/test-project",
    ...overrides};
}

// runGates now returns a GateOutcome; these fixtures wrap a GateResult in
// the kind: "result" envelope (harness flip for bug-gate-signal-integrity).
function gate(
  overrides: Partial<GateResult> = {}): { kind: "result"; result: GateResult } {
  return {
    kind: "result",
    result: {
      compile: true,
      compileError: "",
      
      allPassed: true,
      coverage: 85,
  failures: [],
      ...overrides}};
}

function gateResult(
  overrides: Partial<GateResult> = {}): GateResult {
  return {
    compile: true,
    compileError: "",
    
  allPassed: true,
  coverage: 85,
  failures: [],
    ...overrides};
}

function makeInput(overrides: Partial<GateHandlerInput> = {}): {
  input: GateHandlerInput;
  pi: any;
  ctx: any;
  debug: ReturnType<typeof vi.fn>;
} {
  const pi = createMockExtensionAPI();
  const ctx = makeCtx();
  const debug = vi.fn();
  const input: GateHandlerInput = {
    state: makeState(),
    pi: pi as any,
    ctx,
    lang: GO,
    debug,
    ...overrides};
  return { input, pi, ctx, debug };
}

/** Deep copy of the input state — proves the pure-state (no-mutation) contract. */
function cloneState(s: LoopState): LoopState {
  return JSON.parse(JSON.stringify(s));
}

let archiveSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runGatesMock.mockReset();
  runGatesMock.mockReturnValue(Promise.resolve(gate())); // default: all pass
  // The B→C archive is the only fs side effect in this file; stub it so the
  // suite never touches the real filesystem. Tests asserting the wiring
  // unstub it locally.
  archiveSpy = vi.spyOn(archive, "archiveSpecFile").mockReturnValue(null);
});

afterEach(() => {
  archiveSpy.mockRestore();
});

// --- Contract basics ---

describe("handleGateTransition — contract basics", () => {
  it("calls runGates with (ctx.cwd, coverageThreshold, language, buildTool, phase)", async () => {
    const { input } = makeInput({
      state: makeState({ phase: "C", round: 2, coverageThreshold: 60, language: "java", buildTool: "gradle" })});
    await handleGateTransition(input);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
    expect(runGatesMock).toHaveBeenCalledWith("/tmp/test-project", 60, "java", "gradle", "C", 60);
  });

  it("passes the gate result through in output (same reference)", async () => {
    const outcome = gate({ coverage: 77 });
    runGatesMock.mockReturnValue(Promise.resolve(outcome));
    const { input } = makeInput();
    const result = await handleGateTransition(input);
    expect(result.gateResult).toBe(outcome.result);
  });

  it("does not set lastGateResult on the returned state (dispatcher's job, G3)", async () => {
    const { input } = makeInput(); // A all-pass → advance effect
    const result = await handleGateTransition(input);
    expect(result.state.lastGateResult).toBeUndefined();
  });

  it("never mutates the input state", async () => {
    const state = makeState({ phase: "A", round: 1 });
    const before = cloneState(state);
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0 })));
    const { input } = makeInput({ state });
    await handleGateTransition(input);
    expect(state).toEqual(before);
  });

  it("returns a new state object for non-noop transitions (input !== output)", async () => {
    const { input } = makeInput({ state: makeState({ phase: "A", round: 1 }) }); // all-pass → advance
    const result = await handleGateTransition(input);
    expect(result.state).not.toBe(input.state);
  });
});

// --- Phase A ---

describe("Phase A", () => {
  it("compile fail, round < maxA → retry: new state round+1, turnsThisPhase 1, compile retry prompt", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0, failures: [] })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "A", round: 1 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state).not.toBe(input.state);
    expect(result.state.phase).toBe("A");
    expect(result.state.round).toBe(2);
    expect(result.state.turnsThisPhase).toBe(1);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase A — round 2");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Gate failed. Retry 2/3.", "warning");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptTesterCompileRetry("boom"));
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("retry debug trace — verbatim sequence: gate log, arrow, retry", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0 })));
    const { input, debug } = makeInput({ state: makeState({ phase: "A", round: 1 }) });
    await handleGateTransition(input);
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      "Gate fail (0 failures) [compile=false allPassed=false cov=0%]",
      "→ retry (Phase A round 2)",
      "Retry A round 2",
    ]);
  });

  it("compile fail, round >= maxA → escalated: no prompt, warning notify", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0 })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "A", round: 3, maxA: 3 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.phase).toBe("escalated");
    expect(result.state.lastPhase).toBe("A");
    expect(result.state.turnsThisPhase).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase A exhausted. Escalating to human.", "warning");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "escalated (Phase A exhausted)");
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("all pass → advance to negotiate: new state, writer negotiate prompt", async () => {
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "A", round: 1, specPath: "spec.md" }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state).not.toBe(input.state);
    expect(result.state.phase).toBe("negotiate");
    expect(result.state.round).toBe(1);
    expect(result.state.turnsThisPhase).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase passed. Advancing to Phase negotiate.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase negotiate — round 1");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptWriterNegotiate("spec.md", GO.testFilePattern));
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });
});

// --- Phase B ---

describe("Phase B", () => {
  it("compile fail, round < maxB → retry with writer continue prompt (single failing test)", async () => {
    const failures = [{ test: "TestFoo", subtest: "bar", output: "want X got Y" }];
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0, failures })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "B", round: 1 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.round).toBe(2);
    expect(result.state.turnsThisPhase).toBe(1);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptWriterPhaseBContinue(formatFailures(failures), 1));
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 2");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Gate failed. Retry 2/5.", "warning");
  });

  it("compile fail, round >= maxB → escalated, no prompt", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0 })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "B", round: 5, maxB: 5 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.phase).toBe("escalated");
    expect(result.state.lastPhase).toBe("B");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase B exhausted. Escalating to human.", "warning");
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("allPassed → advance to C: spec archived at the B→C boundary", async () => {
    archiveSpy.mockReturnValue("done-spec.md");
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "B", round: 2 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.phase).toBe("C");
    expect(archive.archiveSpecFile).toHaveBeenCalledWith("spec.md", "/tmp/test-project");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Spec archived: done-spec.md", "info");
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("allPassed → advance to C: cleaner prompt, disputeMode cleared, round reset", async () => {
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "B", round: 2, dispute: { status: "conceded", filer: "writer" } }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.phase).toBe("C");
    expect(result.state.round).toBe(1);
    expect(result.state.turnsThisPhase).toBe(1);
    expect(result.state.dispute?.status === "conceded").toBe(false);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptCleanerPhaseC());
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase passed. Advancing to Phase C.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase C — round 1");
  });

  it("spec 09 — retired dispute branch: stale flag no longer special-cased; normal writer retry path runs", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0, failures: [{ test: "TestAdd", subtest: "", output: "x" }] })));
    const { input, pi, ctx, debug } = makeInput({
      state: makeState({ phase: "B", round: 1, lastProposal: "writer claim" })});
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.round).toBe(2);
    expect(result.state.turnsThisPhase).toBe(1);
    expect(result.state.dispute?.status).toBe("none"); // dispute cleared by handleDisputeFixIncomplete
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptWriterPhaseBContinue("  - TestAdd\nx", 1));
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 2");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Gate failed. Retry 2/5.", "warning");
    expect(debug).not.toHaveBeenCalledWith("Dispute review → retry with prompt"); // retired debug line
  });

  it("dispute fix incomplete (disputeMode, compile pass, tests fail) → disputeMode cleared, round+1, writer continue prompt", async () => {
    const failures = [{ test: "TestFoo", subtest: "", output: "fail" }];
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: true, allPassed: false, coverage: 50, failures })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "B", round: 1, dispute: { status: "conceded", filer: "writer" } }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.dispute?.status === "conceded").toBe(false);
    expect(result.state.round).toBe(2);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptWriterPhaseBContinue(formatFailures(failures), 1));
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 2");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Gate failed. Retry 2/5.", "warning");
  });

  it("dispute fix compile fail (disputeMode) → disputeMode cleared, round+1, compile retry prompt", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "still broken", allPassed: false, coverage: 0 })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "B", round: 1, dispute: { status: "conceded", filer: "writer" } }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.dispute?.status === "conceded").toBe(false);
    expect(result.state.round).toBe(2);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptTesterCompileRetry("still broken"));
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 2");
    expect(ctx.ui.notify).toHaveBeenCalledWith("compile failed after dispute fix.", "warning");
  });

  it("spec 08 regression (session 01a00dba tail): passing gate in B with awaitDisputeReview → C with the flag cleared, tool calls unblocked", async () => {
    const { input, pi, ctx } = makeInput({
      state: makeState({ phase: "B", round: 2, dispute: { status: "conceded", filer: "writer" }, lastProposal: "writer claim" })});
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.phase).toBe("C");
    expect(result.state.dispute?.status === "defended").toBe(false); // cleared at the B→C boundary
    expect(result.state.dispute?.status === "conceded").toBe(false);

    // rule 2 off: a pathless read in Phase C is not blocked (was blocked pre-fix)
    const blocked = handleToolCall({
      state: { current: result.state },
      pi: pi as any,
      debug: vi.fn(),
      toolName: "read",
      path: undefined, // F3: pathless tools extract undefined
      ctx});
    expect(blocked).toBeUndefined();

    // F3: raw events deliver null — same: not blocked
    const blockedNull = handleToolCall({
      state: { current: result.state },
      pi: pi as any,
      debug: vi.fn(),
      toolName: "read",
      path: null as any,
      ctx});
    expect(blockedNull).toBeUndefined();
  });
});

// --- Phase C ---

describe("Phase C", () => {
  it("tests fail, round < maxC → retry with cleaner prompt", async () => {
    const failures = [{ test: "TestA", subtest: "x", output: "boom" }];
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: true, allPassed: false, coverage: 60, failures })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "C", round: 1 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.round).toBe(2);
    expect(result.state.turnsThisPhase).toBe(1);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GO.prompts.promptCleanerRetry(formatFailures(failures), 1));
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase C — round 2");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Gate failed. Retry 2/3.", "warning");
  });

  // Spec 10 (rewrite 4): the done effect now delivers a completion message
  // through the handleGateTransition → applyEffect → applyDoneEffect chain.
  // Fixture: specPath "spec.md", disputeCount 0, cleanerFailed true derived
  // from the producer status "done (cleaner failed)".
  it("tests fail, round >= maxC → done (cleaner failed): completion message sent", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: true, allPassed: false, coverage: 40 })));
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "C", round: 3, maxC: 3 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.phase).toBe("done");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Phase C failed, keeping original code. Loop complete.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "done (cleaner failed)");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptLoopComplete("spec.md", 0, true));
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  // Spec 10 (rewrite 5): clean-finish variant — status "done" (not the
  // producer's notify string) selects cleanerFailed: false.
  it("all pass → done: completion message sent", async () => {
    const { input, pi, ctx } = makeInput({ state: makeState({ phase: "C", round: 1 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(true);
    expect(result.state.phase).toBe("done");
    expect(result.state.turnsThisPhase).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("All phases complete.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "done");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(GP.promptLoopComplete("spec.md", 0, false));
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });
});

// --- noop ---

describe("noop (non A/B/C phase)", () => {
  it("applied false, same state object, no UI side effects, gate log still emitted", async () => {
    const { input, pi, ctx, debug } = makeInput({ state: makeState({ phase: "review", round: 1 }) });
    const result = await handleGateTransition(input);

    expect(result.applied).toBe(false);
    expect(result.state).toBe(input.state); // computeTransition's noop returns the same object
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(pi.sentMessages).toHaveLength(0);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalled();
  });
});

// --- Debug strings (verbatim) ---

describe("debug strings (verbatim)", () => {
  it("all pass → 'Gate pass [...]' without a failure count, then done trace", async () => {
    const { input, debug } = makeInput({ state: makeState({ phase: "C", round: 1 }) }); // all-pass → done
    await handleGateTransition(input);
    expect(debug.mock.calls.map((c) => c[0])).toEqual([
      "Gate pass [compile=true allPassed=true cov=85%]",
      "→ done (Phase done round 1)",
      "Done",
    ]);
  });

  it("tests ran, some failed → 'Gate fail (N failures) [...]'", async () => {
    const failures = [
      { test: "TestA", subtest: "", output: "a" },
      { test: "TestB", subtest: "", output: "b" },
    ];
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: true, allPassed: false, coverage: 75, failures })));
    const { input, debug } = makeInput({ state: makeState({ phase: "B", round: 1 }) });
    await handleGateTransition(input);
    expect(debug).toHaveBeenCalledWith("Gate fail (2 failures) [compile=true allPassed=false cov=75%]");
  });

  it("tests failed → 'Gate fail (N failures) [...]' (singular '1 failures' preserved)", async () => {
    const failures = [{ test: "TestA", subtest: "", output: "a" }];
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, allPassed: false, coverage: 0, failures })));
    const { input, debug } = makeInput({ state: makeState({ phase: "A", round: 1 }) });
    await handleGateTransition(input);
    expect(debug).toHaveBeenCalledWith("Gate fail (1 failures) [compile=false allPassed=false cov=0%]");
  });
});

// --- Duplicate-settle lock (spec: internal/bug-gate-slow-settle-duplicate.md) ---
//
// A second agent_settled landing while the first gate run is still in flight
// must be dropped (NO_GATE sentinel: no runGates, no effect, no prompt). The
// lock is module-local and cleared in `finally` so a thrown gate cannot wedge
// the loop. The live-toolchain variant (real runGates, nonexistent cwd) is the
// probe from the spec's Problem §2; it is not included here — the mocked
// deferred below pins the same contract at the unit boundary (CLAUDE.md
// test-speed rule: no real toolchain in unit tests).

describe("duplicate settle while gate in flight", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("second settle while the first gate is in flight → NO_GATE, no runGates, no prompt, no effect", async () => {
    const d = deferred<Awaited<ReturnType<typeof gate>>>();
    runGatesMock.mockReturnValueOnce(d.promise);

    const { input: first, pi: pi1, ctx: ctx1 } = makeInput({ state: makeState({ phase: "B", round: 1 }) });
    const p1 = handleGateTransition(first);

    // The first gate is now in flight (its runGates promise is held open).
    const { input: second, pi: pi2, ctx: ctx2, debug: debug2 } = makeInput({ state: makeState({ phase: "B", round: 1 }) });
    const result2 = await handleGateTransition(second);

    expect(result2).toBe(NO_GATE);
    expect(result2.applied).toBe(false);
    expect(result2.gateResult).toBeNull();
    // The dropped settle ran no gate, sent no prompt, touched no UI.
    expect(runGatesMock).toHaveBeenCalledTimes(1);
    expect(pi2.sentMessages).toHaveLength(0);
    expect(ctx2.ui.notify).not.toHaveBeenCalled();
    expect(ctx2.ui.setStatus).not.toHaveBeenCalled();
    expect(debug2).toHaveBeenCalled(); // the drop is logged

    // Resolve the first gate → it applies exactly once.
    d.resolve(gate());
    const result1 = await p1;
    expect(result1.applied).toBe(true);
    expect(result1).not.toBe(NO_GATE);
    expect(pi1.sentMessages).toHaveLength(1);
    expect(runGatesMock).toHaveBeenCalledTimes(1);
  });

  it("after a settled gate, the next settle runs normally (lock cleared — no wedge)", async () => {
    runGatesMock.mockReturnValue(Promise.resolve(gate({ compile: false, compileError: "boom", allPassed: false, coverage: 0 })));
    const { input: first } = makeInput({ state: makeState({ phase: "A", round: 1 }) });
    await handleGateTransition(first);

    // Lock must be cleared: the next settle runs the gate again.
    const { input: second } = makeInput({ state: makeState({ phase: "A", round: 2 }) });
    const result = await handleGateTransition(second);
    expect(result).not.toBe(NO_GATE);
    expect(result.applied).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(2);
  });

  it("wedge regression: the first gate throws → lock still cleared, next settle runs", async () => {
    runGatesMock.mockReturnValueOnce(Promise.reject(new Error("gate tool exploded")));
    const { input: first } = makeInput({ state: makeState({ phase: "A", round: 1 }) });
    await expect(handleGateTransition(first)).rejects.toThrow("gate tool exploded");

    // The `finally` cleared the lock despite the throw.
    runGatesMock.mockReturnValue(Promise.resolve(gate()));
    const { input: second } = makeInput({ state: makeState({ phase: "A", round: 1 }) });
    const result = await handleGateTransition(second);
    expect(result).not.toBe(NO_GATE);
    expect(result.applied).toBe(true);
    expect(runGatesMock).toHaveBeenCalledTimes(2);
  });
});
