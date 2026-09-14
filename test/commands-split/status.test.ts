// Contract tests for src/commands/status.ts — internal/refactor-commands-split.md
//
// Pins cmdStatus, cmdContinue, cmdRestart + their helpers
// (formatStatusLines, buildContinuePrompt, buildRestartPrompt,
// handlePhaseRestart). Behavior is pinned VERBATIM from the current
// src/commands.ts (pure refactor — no behavioral change).
//
// Leaf modules (commit, prompt, languages, generic-prompts, gates,
// phase-max, state-helpers) are mocked so the tests assert on the
// command layer's interpretation — state mutation + prompt content —
// not on the toolchain or disk. Fast + hermetic: no process spawning.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, GateResult } from "../../src/types";

vi.mock("../../src/commit", () => ({ commit: vi.fn() }));
vi.mock("../../src/prompt", () => ({ sendPrompt: vi.fn() }));
vi.mock("../../src/languages", () => ({
  getLanguageConfig: vi.fn(),
  detectProject: vi.fn(),
}));
vi.mock("../../src/generic-prompts", () => ({
  promptWriterNegotiate: vi.fn(),
  promptNegotiateRepromptTester: vi.fn(),
}));
vi.mock("../../src/gates", () => ({ formatFailures: vi.fn((f: unknown[]) => f.join("\n")) }));
vi.mock("../../src/phase-max", () => ({ getPhaseMax: vi.fn(() => 3) }));
vi.mock("../../src/state-helpers", () => ({
  resetPhaseState: vi.fn((s: LoopState) => {
    s.round = 1;
    s.disputeCount = 0;
    s.dispute = { status: "none" };
    s.negotiateReprompted = false;
    s.negotiateProposed = false;
    s.negotiateFeedback = "";
    s.justTransitioned = false;
    s.turnsThisPhase = 1;
  }),
  isIdleOrDone: vi.fn((p: string) => p === "idle" || p === "done"),
  resolvePhaseArg: vi.fn((raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!["review", "a", "negotiate", "b", "c", "done", "escalated", "idle"].includes(t)) {
      throw new Error("Invalid phase");
    }
    return t === "negotiate" ? "negotiate" : (t.toUpperCase() as string);
  }),
}));

import {
  cmdStatus, cmdContinue, cmdRestart,
  formatStatusLines, buildContinuePrompt, buildRestartPrompt, handlePhaseRestart,
} from "../../src/commands/status";
import * as Lang from "../../src/languages";
import * as GP from "../../src/generic-prompts";
import * as Commit from "../../src/commit";
import * as Prompt from "../../src/prompt";
import * as SH from "../../src/state-helpers";
import * as PhaseMax from "../../src/phase-max";
import * as Gates from "../../src/gates";

beforeEach(() => {
  vi.clearAllMocks();
  (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
  (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue(null);
  (PhaseMax.getPhaseMax as ReturnType<typeof vi.fn>).mockReturnValue(3);
  (Gates.formatFailures as ReturnType<typeof vi.fn>).mockImplementation((f: unknown[]) => f.join("\n"));
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
    dispute: { status: "none" },
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

function makeLangConfig() {
  return {
    key: "go",
    sourceFilePattern: "*.go",
    testFilePattern: "*_test.go",
    isTestFile: () => false,
    isPhaseAAllowed: () => false,
    prompts: {
      promptTesterPhaseA: vi.fn((spec: string, bt: string, ws: string) => `A:${spec}:${bt}:${ws}`),
      promptTesterPhaseARestart: vi.fn((spec: string, bt: string, ws: string) => `A-R:${spec}:${bt}:${ws}`),
      promptTesterCompileRetry: vi.fn(() => "x"),
      promptNegotiateAutoAdvance: vi.fn(() => "x"),
      promptWriterPhaseB: vi.fn((ws: string) => `B:${ws}`),
      promptWriterPhaseBContinue: vi.fn((sum: string, n: number, ws: string) => `B-C:${sum}:${n}:${ws}`),
      promptCleanerPhaseC: vi.fn((ws: string) => `C:${ws}`),
      promptCleanerRetry: vi.fn((sum: string, n: number, ws: string) => `C-R:${sum}:${n}:${ws}`),
      promptCleanerRestart: vi.fn((ws: string) => `C-RESTART:${ws}`),
      promptTesterDisputeFix: vi.fn(() => "x"),
    },
    refusalMessage: { phaseA: "a", negotiate: "n", phaseC: "c" },
  } as any;
}

// ================================================================
// Module contract
// ================================================================

describe("src/commands/status.ts — module contract", () => {
  it("exports cmdStatus, cmdContinue, cmdRestart + the 4 status helpers", () => {
    expect(typeof cmdStatus).toBe("function");
    expect(typeof cmdContinue).toBe("function");
    expect(typeof cmdRestart).toBe("function");
    expect(typeof formatStatusLines).toBe("function");
    expect(typeof buildContinuePrompt).toBe("function");
    expect(typeof buildRestartPrompt).toBe("function");
    expect(typeof handlePhaseRestart).toBe("function");
  });
});

// ================================================================
// formatStatusLines — verbatim from src/commands.ts:403-413
// ================================================================

describe("formatStatusLines", () => {
  it("renders the 5 pinned lines using getPhaseMax + maxTurnsPerPhase", () => {
    (PhaseMax.getPhaseMax as ReturnType<typeof vi.fn>).mockReturnValue(5);
    const out = formatStatusLines(makeState());
    expect(out).toBe(
      "Phase: B (round 3/5)\n" +
      "Turns this phase: 2/5\n" +
      "Disputes: 1/3\n" +
      "Spec: internal/spec.md\n" +
      "Language: go / go");
  });
});

// ================================================================
// buildContinuePrompt — verbatim from src/commands.ts:38-68
// ================================================================

describe("buildContinuePrompt", () => {
  it("phase A → promptTesterPhaseA(specPath, buildTool, ws)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    const out = buildContinuePrompt(makeState({ phase: "A" }));
    expect(out).toBe("A:internal/spec.md:go:.");
  });

  it("negotiate odd round → promptWriterNegotiate(specPath, testFilePattern)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (GP.promptWriterNegotiate as ReturnType<typeof vi.fn>).mockReturnValue("NEGOTIATE");
    expect(buildContinuePrompt(makeState({ phase: "negotiate", round: 1 }))).toBe("NEGOTIATE");
    expect(GP.promptWriterNegotiate).toHaveBeenCalledWith("internal/spec.md", "*_test.go");
  });

  it("negotiate even round → promptNegotiateRepromptTester() (no args)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (GP.promptNegotiateRepromptTester as ReturnType<typeof vi.fn>).mockReturnValue("REPROMPT");
    expect(buildContinuePrompt(makeState({ phase: "negotiate", round: 2 }))).toBe("REPROMPT");
    expect(GP.promptNegotiateRepromptTester).toHaveBeenCalledWith();
  });

  it("phase B with failing gate → promptWriterPhaseBContinue(failures, count, ws)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (Gates.formatFailures as ReturnType<typeof vi.fn>).mockReturnValue("FAILS");
    const gate: GateResult = {
      compile: true, compileError: "", allPassed: false, coverage: 0,
      failures: [{ test: "T", subtest: "", output: "x" }],
    };
    const out = buildContinuePrompt(makeState({ phase: "B", lastGateResult: gate }));
    expect(out).toBe("B-C:FAILS:1:.");
  });

  it("phase B green/absent gate → promptWriterPhaseB(ws)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    expect(buildContinuePrompt(makeState({ phase: "B" }))).toBe("B:.");
  });

  it("phase C with failing gate → promptCleanerRetry(failures, count, ws)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (Gates.formatFailures as ReturnType<typeof vi.fn>).mockReturnValue("FAILS");
    const gate: GateResult = {
      compile: true, compileError: "", allPassed: false, coverage: 0,
      failures: [{ test: "T", subtest: "", output: "x" }],
    };
    expect(buildContinuePrompt(makeState({ phase: "C", lastGateResult: gate })))
      .toBe("C-R:FAILS:1:.");
  });

  it("phase C green → promptCleanerPhaseC(ws)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    expect(buildContinuePrompt(makeState({ phase: "C" }))).toBe("C:.");
  });

  it("default (done/idle/escalated) → 'Continue.'", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    expect(buildContinuePrompt(makeState({ phase: "done" }))).toBe("Continue.");
  });
});

// ================================================================
// buildRestartPrompt — verbatim from src/commands.ts:72-86
// ================================================================

describe("buildRestartPrompt", () => {
  it.each([
    ["review", "Phase 0: Spec review. Use negotiate_propose to approve or provide feedback."],
    ["done", "Phase done. Loop complete."],
    ["escalated", "Phase escalated. Awaiting human intervention."],
    ["idle", "Phase idle. Run /loop to start."],
  ] as const)("returns the pinned literal for %j", (phase, expected) => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    expect(buildRestartPrompt(makeState({ phase }), "internal/spec.md")).toBe(expected);
  });

  it("phase A → promptTesterPhaseARestart(specPath, buildTool, ws)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    expect(buildRestartPrompt(makeState({ phase: "A" }), "other/spec.md"))
      .toBe("A-R:other/spec.md:go:.");
  });

  it("negotiate → promptWriterNegotiate(specPath, testFilePattern)", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (GP.promptWriterNegotiate as ReturnType<typeof vi.fn>).mockReturnValue("NEG");
    expect(buildRestartPrompt(makeState({ phase: "negotiate", round: 4 }), "s.md")).toBe("NEG");
  });
});

// ================================================================
// cmdStatus — verbatim from src/commands.ts:346-372
// ================================================================

describe("cmdStatus", () => {
  it("idle → 'Loop is not running.'", async () => {
    const ctx = makeCtx();
    await cmdStatus({ current: makeState({ phase: "idle" }) }).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop is not running.", "info");
  });

  it("done → completion message with lastPhase + round", async () => {
    const ctx = makeCtx();
    await cmdStatus({ current: makeState({ phase: "done", lastPhase: "C", round: 2 }) }).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Loop complete. (Phase C, round 2)", "info");
  });

  it("escalated → resume hint (warning)", async () => {
    const ctx = makeCtx();
    await cmdStatus({ current: makeState({ phase: "escalated", lastPhase: "B", round: 4 }) }).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Loop escalated at Phase B, round 4. Run /loop-continue to resume.", "warning");
  });

  it("active phase → the 5 status lines", async () => {
    (PhaseMax.getPhaseMax as ReturnType<typeof vi.fn>).mockReturnValue(5);
    const ctx = makeCtx();
    await cmdStatus({ current: makeState() }).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Phase: B (round 3/5)"), "info");
  });
});

// ================================================================
// cmdContinue — verbatim from src/commands.ts:374-397
// ================================================================

describe("cmdContinue", () => {
  it("idle → 'Nothing to continue' (no reset, no commit, no prompt)", async () => {
    const state = { current: makeState({ phase: "idle" }) };
    const ctx = makeCtx();
    await cmdContinue(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Nothing to continue. Run /loop <spec-path> to start.", "warning");
    expect(SH.resetPhaseState).not.toHaveBeenCalled();
    expect(Commit.commit).not.toHaveBeenCalled();
    expect(Prompt.sendPrompt).not.toHaveBeenCalled();
  });

  it("done → same refusal (isIdleOrDone covers both)", async () => {
    const state = { current: makeState({ phase: "done" }) };
    const ctx = makeCtx();
    await cmdContinue(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to continue"), "warning");
  });

  it("escalated → resumes at lastPhase, then resets + commits + prompts", async () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    const state = { current: makeState({ phase: "escalated", lastPhase: "B" }) };
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdContinue(state, pi, debug).handler("", ctx);
    expect(state.current.phase).toBe("B");
    expect(SH.resetPhaseState).toHaveBeenCalledWith(state.current);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Continued from Phase B, round 1.", "info");
    expect(Commit.commit).toHaveBeenCalledWith(state.current, pi, debug);
    expect(Prompt.sendPrompt).toHaveBeenCalled();
  });

  it("active phase → stays, resets, commits, sends the continue prompt", async () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    const state = { current: makeState({ phase: "C" }) };
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdContinue(state, pi, debug).handler("", ctx);
    expect(state.current.phase).toBe("C");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase C — round 1");
    const sent = (Prompt.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sent).toBe("C:.");
  });
});

// ================================================================
// cmdRestart + handlePhaseRestart — verbatim from src/commands.ts:415-455
// ================================================================

describe("cmdRestart", () => {
  it("invalid phase → usage warning (no state change, no prompt)", async () => {
    const state = { current: makeState() };
    const ctx = makeCtx();
    await cmdRestart(state, makeApi(), debug).handler("zzz", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /loop-restart <A|negotiate|B|C>", "warning");
    expect(state.current.phase).toBe("B");
    expect(Prompt.sendPrompt).not.toHaveBeenCalled();
  });

  it("empty args → usage warning (resolvePhaseArg throws on '')", async () => {
    const state = { current: makeState() };
    const ctx = makeCtx();
    await cmdRestart(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /loop-restart <A|negotiate|B|C>", "warning");
  });

  it("valid phase → resets, sets lastPhase, commits, sends restart prompt", async () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const state = { current: makeState({ phase: "C" }) };
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdRestart(state, pi, debug).handler("a", ctx);
    expect(state.current.phase).toBe("A");
    expect(state.current.lastPhase).toBe("A");
    expect(SH.resetPhaseState).toHaveBeenCalledWith(state.current);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Restarted from Phase A, round 1.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase A — round 1");
    expect(Commit.commit).toHaveBeenCalledWith(state.current, pi, debug);
    const sent = (Prompt.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sent).toBe("A-R:internal/spec.md:go:.");
  });

  it("phase A with a detected project → language/buildTool updated before reset", async () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue({
      language: "java", buildTool: "maven",
    });
    const state = { current: makeState({ phase: "C", language: "go", buildTool: "go" }) };
    await cmdRestart(state, makeApi(), debug).handler("A", makeCtx());
    expect(state.current.language).toBe("java");
    expect(state.current.buildTool).toBe("maven");
  });

  it("phase B (no detection) → language/buildTool untouched", async () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const state = { current: makeState({ language: "go", buildTool: "go" }) };
    await cmdRestart(state, makeApi(), debug).handler("b", makeCtx());
    expect(state.current.language).toBe("go");
    expect(state.current.buildTool).toBe("go");
  });

  it("detectProject is called unconditionally (not just for phase A)", async () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const state = { current: makeState() };
    await cmdRestart(state, makeApi(), debug).handler("B", makeCtx());
    expect(Lang.detectProject).toHaveBeenCalled();
  });
});

// ================================================================
// handlePhaseRestart — direct unit (the mutation core)
// ================================================================

describe("handlePhaseRestart", () => {
  it("mutates phase + lastPhase, resets, commits, notifies, prompts", () => {
    (Lang.getLanguageConfig as ReturnType<typeof vi.fn>).mockReturnValue(makeLangConfig());
    (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const state = { current: makeState() };
    const ctx = makeCtx();
    const pi = makeApi();
    handlePhaseRestart(state, pi, debug, ctx, "C");
    expect(state.current.phase).toBe("C");
    expect(state.current.lastPhase).toBe("C");
    expect(SH.resetPhaseState).toHaveBeenCalled();
    expect(Commit.commit).toHaveBeenCalled();
    expect(Prompt.sendPrompt).toHaveBeenCalled();
  });
});
