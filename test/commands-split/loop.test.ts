// Contract tests for src/commands/loop.ts — internal/refactor-commands-split.md
//
// Pins cmdLoop, createInitialState, and buildPhaseZeroPrompt. Behavior is
// pinned VERBATIM from the current src/commands.ts (pure refactor — no
// behavioral change).
//
// Leaf modules (reviewer, baseline, git-workflow, languages, commit,
// prompt, metrics, selectors) are mocked so the tests assert on the
// command layer's interpretation — state mutation + prompt content —
// not on the toolchain or disk. Fast + hermetic: no process spawning.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, SpecAnalysis, Finding } from "../../src/types";

vi.mock("../../src/reviewer", () => ({
  readSpec: vi.fn(),
  analyzeSpec: vi.fn(),
  buildSummaryTable: vi.fn((f: Finding[]) => f.map((x) => x.title).join("\n")),
  formatFinding: vi.fn((f: Finding) => f.title),
}));
vi.mock("../../src/baseline", () => ({
  runBaseline: vi.fn(),
  formatBaselineFailure: vi.fn((r: unknown) => JSON.stringify(r)),
}));
vi.mock("../../src/git-workflow", () => ({ setupBranch: vi.fn() }));
vi.mock("../../src/languages", () => ({ detectProject: vi.fn(), isValidLanguage: vi.fn((k: string) => ["go","java","typescript"].includes(k)) }));
vi.mock("../../src/commit", () => ({ commit: vi.fn() }));
vi.mock("../../src/prompt", () => ({ sendPrompt: vi.fn() }));
vi.mock("../../src/metrics", () => ({ initLiveMetrics: vi.fn() }));
vi.mock("../../src/selectors", () => ({
  parseLoopArgs: vi.fn(),
  loadLoopConfig: vi.fn(() => ({ args: {}, warnings: [] })),
  mergeLoopArgs: vi.fn((a: any, b: any) => ({ ...b, ...a })),
}));

import { cmdLoop, createInitialState, buildPhaseZeroPrompt } from "../../src/commands/loop";
import * as Reviewer from "../../src/reviewer";
import * as Baseline from "../../src/baseline";
import * as Git from "../../src/git-workflow";
import * as Lang from "../../src/languages";
import * as Commit from "../../src/commit";
import * as Prompt from "../../src/prompt";
import * as Metrics from "../../src/metrics";
import * as Selectors from "../../src/selectors";

beforeEach(() => {
  vi.clearAllMocks();
  (Selectors.parseLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue({ specPath: "internal/spec.md" });
  (Selectors.loadLoopConfig as ReturnType<typeof vi.fn>).mockReturnValue({ args: {}, warnings: [] });
  (Selectors.mergeLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue({
    specPath: "internal/spec.md", language: undefined, coverage: 80,
    timeout: 60, branch: undefined, autoApprove: undefined,
    maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxDispute: 3, maxTurnsPerPhase: 5,
  });
  (Reviewer.readSpec as ReturnType<typeof vi.fn>).mockReturnValue("SPEC");
  (Reviewer.analyzeSpec as ReturnType<typeof vi.fn>).mockReturnValue({ findings: [], reasons: ["always"] });
  (Reviewer.buildSummaryTable as ReturnType<typeof vi.fn>).mockReturnValue("TABLE");
  (Reviewer.formatFinding as ReturnType<typeof vi.fn>).mockReturnValue("F");
  (Baseline.runBaseline as ReturnType<typeof vi.fn>).mockReturnValue(okBaseline());
  (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue({ language: "go", buildTool: "go" });
});

// --- Fixtures -------------------------------------------------------------

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

function okBaseline(over: Partial<ReturnType<typeof Baseline.runBaseline>> = {}) {
  return { ok: true, noTests: false, failures: [], output: "", ...over } as ReturnType<typeof Baseline.runBaseline>;
}

function failBaseline() {
  return { ok: false, noTests: false, failures: [{ test: "T", subtest: "", output: "x" }], output: "boom" } as ReturnType<typeof Baseline.runBaseline>;
}

const debug = vi.fn();

// ================================================================
// Module contract
// ================================================================

describe("src/commands/loop.ts — module contract", () => {
  it("exports cmdLoop, createInitialState, and buildPhaseZeroPrompt", () => {
    expect(typeof cmdLoop).toBe("function");
    expect(typeof createInitialState).toBe("function");
    expect(typeof buildPhaseZeroPrompt).toBe("function");
  });
});

// ================================================================
// createInitialState — verbatim from src/commands.ts:107-131
// ================================================================

describe("createInitialState", () => {
  it("returns a fully-populated Phase A state (all 21 fields)", () => {
    const s = createInitialState("internal/spec.md", "go", "go");
    expect(s.phase).toBe("A");
    expect(s.round).toBe(1);
    expect(s.specPath).toBe("internal/spec.md");
    expect(s.language).toBe("go");
    expect(s.buildTool).toBe("go");
    expect(s.maxA).toBe(3);
    expect(s.maxNegotiate).toBe(3);
    expect(s.maxB).toBe(5);
    expect(s.maxC).toBe(3);
    expect(s.maxDispute).toBe(3);
    expect(s.maxTurnsPerPhase).toBe(5);
    expect(s.coverageThreshold).toBe(80);
    expect(s.gateTimeoutSec).toBe(60);
    expect(s.dispute).toEqual({ status: "none" });
    expect(s.disputeCount).toBe(0);
    expect(s.turnsThisPhase).toBe(1);
    expect(s.lastProposal).toBe("");
    expect(s.lastPhase).toBe("A");
    expect(s.justTransitioned).toBe(false);
    expect(s.negotiateReprompted).toBe(false);
    expect(s.negotiateProposed).toBe(false);
    expect(s.negotiateFeedback).toBe("");
  });

  it("honors every optional override", () => {
    const s = createInitialState(
      "other/spec.md", "java", "maven", 90, 120, true,
      2, 4, 6, 4, 5, 7,
    );
    expect(s.specPath).toBe("other/spec.md");
    expect(s.language).toBe("java");
    expect(s.buildTool).toBe("maven");
    expect(s.coverageThreshold).toBe(90);
    expect(s.gateTimeoutSec).toBe(120);
    expect(s.autoApprove).toBe(true);
    expect(s.maxA).toBe(2);
    expect(s.maxNegotiate).toBe(4);
    expect(s.maxB).toBe(6);
    expect(s.maxC).toBe(4);
    expect(s.maxDispute).toBe(5);
    expect(s.maxTurnsPerPhase).toBe(7);
  });

  it("autoApprove omitted → undefined (not false)", () => {
    const s = createInitialState("s.md", "go", "go");
    expect(s.autoApprove).toBeUndefined();
  });
});

// ================================================================
// buildPhaseZeroPrompt — verbatim from src/commands.ts:334-362
// ================================================================

describe("buildPhaseZeroPrompt", () => {
  it("findings 0 → fixed header + spec, no summary/findings sections", () => {
    const out = buildPhaseZeroPrompt("SPEC", { findings: [], reasons: ["always"] });
    expect(out).toBe(
      "Phase 0: Spec Review\n\n" +
      "The spec meets the threshold for review: always\n\n" +
      "Review the spec below and check for ambiguities, missing edge cases, or underspecified behavior.\n\n" +
      "Use negotiate_propose to approve (plan='approve') or provide feedback on findings.\n\n" +
      "Spec content (0 potential findings):\n\n" +
      "SPEC");
  });

  it("findings 1 → summary table + each finding appended", () => {
    (Reviewer.buildSummaryTable as ReturnType<typeof vi.fn>).mockReturnValue("TABLE");
    (Reviewer.formatFinding as ReturnType<typeof vi.fn>).mockReturnValue("F1");
    const out = buildPhaseZeroPrompt("S", { findings: [{ title: "F1" } as Finding], reasons: [] });
    expect(out).toContain("TABLE");
    expect(out).toContain("F1");
  });

  it("empty reasons → 'The spec meets the threshold for review: '" + " (empty join)", () => {
    const out = buildPhaseZeroPrompt("S", { findings: [], reasons: [] });
    expect(out).toContain("The spec meets the threshold for review: \n");
  });
});

// ================================================================
// cmdLoop — verbatim from src/commands.ts:231-281
// ================================================================

describe("cmdLoop", () => {
  function setup(overrides: {
    parse?: Record<string, unknown>;
    config?: { args?: Record<string, unknown>; warnings?: string[] };
    specText?: string | null;
    detected?: { language: string; buildTool: string } | null;
    baseline?: ReturnType<typeof Baseline.runBaseline>;
    branch?: unknown;
  } = {}) {
    (Selectors.parseLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue(
      overrides.parse ?? { specPath: "internal/spec.md" });
    (Selectors.loadLoopConfig as ReturnType<typeof vi.fn>).mockReturnValue(
      overrides.config ?? { args: {}, warnings: [] });
    (Selectors.mergeLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue(
      { specPath: "internal/spec.md", language: undefined, coverage: 80,
        timeout: 60, branch: overrides.branch, autoApprove: undefined,
        maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxDispute: 3, maxTurnsPerPhase: 5 });
    (Reviewer.readSpec as ReturnType<typeof vi.fn>).mockReturnValue(
      overrides.specText ?? "SPEC");
    (Lang.detectProject as ReturnType<typeof vi.fn>).mockReturnValue(
      overrides.detected ?? { language: "go", buildTool: "go" });
    (Baseline.runBaseline as ReturnType<typeof vi.fn>).mockReturnValue(
      overrides.baseline ?? okBaseline());
    (Reviewer.analyzeSpec as ReturnType<typeof vi.fn>).mockReturnValue({
      findings: [], reasons: ["always"],
    });
    const state = { current: { phase: "idle" } as LoopState };
    return { state, ctx: makeCtx(), pi: makeApi() };
  }

  it("missing specPath → usage warning, no state change", async () => {
    const { state, ctx } = setup();
    (Selectors.mergeLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue({ specPath: "" });
    await cmdLoop(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /loop"), "warning");
    expect(Commit.commit).not.toHaveBeenCalled();
  });

  it("config warnings → each notified as 'warning' before merge", async () => {
    const { ctx } = setup();
    (Selectors.loadLoopConfig as ReturnType<typeof vi.fn>).mockReturnValue(
      { args: {}, warnings: ["w1", "w2"] });
    await cmdLoop({ current: {} as LoopState }, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("w1", "warning");
    expect(ctx.ui.notify).toHaveBeenCalledWith("w2", "warning");
  });

  it("spec file missing → error, loop not started", async () => {
    const { state, ctx } = setup();
    (Reviewer.readSpec as ReturnType<typeof vi.fn>).mockReturnValue(null);
    await cmdLoop(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Spec file not found: internal/spec.md", "error");
    expect(Commit.commit).not.toHaveBeenCalled();
  });

  it("baseline red → rejectLoopStart (error + status), no commit/prompt", async () => {
    const { state, ctx } = setup({ baseline: failBaseline() });
    await cmdLoop(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Baseline check failed"), "error");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "loop", "baseline failed — fix the test suite, then re-run /loop");
    expect(Commit.commit).not.toHaveBeenCalled();
    expect(Prompt.sendPrompt).not.toHaveBeenCalled();
  });

  it("baseline green → starts Phase 0 review (commit + sendPrompt)", async () => {
    const { state, ctx, pi } = setup();
    await cmdLoop(state, pi, debug).handler("", ctx);
    expect(state.current.phase).toBe("review");
    expect(state.current.awaitingReview).toBe(true);
    expect(Metrics.initLiveMetrics).toHaveBeenCalledWith(
      { specPath: "internal/spec.md", language: "go", phase: "review" });
    expect(Commit.commit).toHaveBeenCalledWith(state.current, pi, debug);
    expect(Prompt.sendPrompt).toHaveBeenCalled();
  });

  it("noTests baseline → 'starting from a clean slate' message", async () => {
    const { ctx } = setup({ baseline: okBaseline({ noTests: true }) });
    await cmdLoop({ current: {} as LoopState }, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Baseline: no existing tests — starting from a clean slate.", "info");
  });

  it("--branch ok → branch stored on state", async () => {
    (Git.setupBranch as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "created", branch: { name: "feat/x", base: "main" },
    });
    const { state, pi } = setup({ branch: "" });
    await cmdLoop(state, pi, debug).handler("", makeCtx());
    expect(state.current.branch).toEqual({ name: "feat/x", base: "main" });
  });

  it("--branch error → loop does not start (no commit)", async () => {
    const { state, ctx, pi } = setup({ branch: "" });
    (Git.setupBranch as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "error", error: "boom",
    });
    await cmdLoop(state, pi, debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Branch setup failed: boom", "error");
    expect(Commit.commit).not.toHaveBeenCalled();
  });

  it("language fallback: merged.language > detected.language > 'go'", async () => {
    const { state } = setup();
    (Selectors.mergeLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue({
      specPath: "s.md", language: "java", coverage: 80, timeout: 60,
      branch: undefined, autoApprove: undefined,
      maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxDispute: 3, maxTurnsPerPhase: 5,
    });
    await cmdLoop(state, makeApi(), debug).handler("", makeCtx());
    expect(state.current.language).toBe("java");
  });

  it("invalid --language → error, loop not started (no commit, no baseline)", async () => {
    const { state, ctx } = setup();
    (Selectors.mergeLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue({
      specPath: "s.md", language: "tyepscript", coverage: 80, timeout: 60,
      branch: undefined, autoApprove: undefined,
      maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxDispute: 3, maxTurnsPerPhase: 5,
    });
    await cmdLoop(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid language: 'tyepscript'"), "error");
    expect(Baseline.runBaseline).not.toHaveBeenCalled();
    expect(Commit.commit).not.toHaveBeenCalled();
    expect(state.current.phase).toBe("idle");
  });

  it("valid --language → no error, loop proceeds", async () => {
    const { state, ctx } = setup();
    (Selectors.mergeLoopArgs as ReturnType<typeof vi.fn>).mockReturnValue({
      specPath: "s.md", language: "typescript", coverage: 80, timeout: 60,
      branch: undefined, autoApprove: undefined,
      maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxDispute: 3, maxTurnsPerPhase: 5,
    });
    await cmdLoop(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Invalid language"), "error");
    expect(state.current.language).toBe("typescript");
    expect(state.current.phase).toBe("review");
  });
});
