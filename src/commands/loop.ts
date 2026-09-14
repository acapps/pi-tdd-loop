// /loop command — internal/refactor-commands-split.md
//
// cmdLoop + the loop-only helpers: resolveProjectCwd, runPhase0Baseline,
// applyBranchSetup, enterPhase0Review, rejectLoopStart,
// buildPhaseZeroPrompt, createInitialState.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState, LanguageKey, BuildTool, SpecAnalysis } from "../types";
import { getWorkspaceRoot } from "../types";
import * as R from "../reviewer";
import { runBaseline, formatBaselineFailure } from "../baseline";
import { setupBranch } from "../git-workflow";
import { detectProject } from "../languages";
import { commit } from "../commit";
import { sendPrompt } from "../prompt";
import { initLiveMetrics } from "../metrics";
import { parseLoopArgs, loadLoopConfig, mergeLoopArgs } from "../selectors";
import type { DebugFn } from "../events";

export function createInitialState(
  specPath: string,
  language: LanguageKey,
  buildTool: BuildTool,
  coverage: number = 80,
  timeout: number = 60,
  autoApprove?: boolean,
  maxA = 3, maxNegotiate = 3, maxB = 5, maxC = 3,
  maxDispute = 3, maxTurnsPerPhase = 5,
): LoopState {
  return {
    phase: "A", round: 1, specPath, language, buildTool,
    maxA, maxNegotiate, maxB, maxC, maxDispute, maxTurnsPerPhase,
    coverageThreshold: coverage, gateTimeoutSec: timeout,
    dispute: { status: "none" }, disputeCount: 0, turnsThisPhase: 1,
    lastProposal: "", lastPhase: "A", justTransitioned: false,
    negotiateReprompted: false, negotiateProposed: false,
    negotiateFeedback: "", autoApprove,
  };
}

function resolveProjectCwd(specPath: string, cwd: string): string {
  const ws = getWorkspaceRoot(specPath);
  return ws === "." ? cwd : ws;
}

function runPhase0Baseline(
  projectCwd: string, language: LanguageKey, buildTool: BuildTool,
  ctx: CommandContext, debug: DebugFn,
): boolean {
  const baseline = runBaseline(projectCwd, language, buildTool);
  if (!baseline.ok) {
    rejectLoopStart(ctx, debug, baseline);
    return false;
  }
  ctx.ui.notify(
    baseline.noTests
      ? "Baseline: no existing tests — starting from a clean slate."
      : "Baseline: existing test suite is green.",
    "info",
  );
  debug(`Phase 0 baseline: OK (${baseline.noTests ? "no existing tests" : "suite green"})`);
  return true;
}

async function applyBranchSetup(
  state: { current: LoopState }, ctx: CommandContext,
  debug: DebugFn, cwd: string, specPath: string, branchArg: string,
): Promise<boolean> {
  const setup = await setupBranch(cwd, specPath, branchArg || undefined);
  if (setup.kind === "error") {
    ctx.ui.notify(`Branch setup failed: ${setup.error}`, "error");
    ctx.ui.setStatus("loop", "branch setup failed — loop not started");
    debug(`--branch setup: FAIL (${setup.error})`);
    return false;
  }
  state.current.branch = setup.branch;
  ctx.ui.notify(
    `Branch: created '${setup.branch.name}' off '${setup.branch.base}'. The loop will merge it back on completion.`,
    "info",
  );
  debug(`--branch setup: OK (${setup.branch.name} off ${setup.branch.base})`);
  return true;
}

export function cmdLoop(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Start adversarial loop: [--language go|java|typescript] [--coverage N] [--branch [name]] <spec-path>",
    handler: async (args: string, ctx: CommandContext) => {
      const cliArgs = parseLoopArgs(args);
      const config = loadLoopConfig(ctx.cwd);
      for (const w of config.warnings) {
        ctx.ui.notify(w, "warning");
      }
      const merged = mergeLoopArgs(cliArgs, config.args);
      if (!merged.specPath) {
        ctx.ui.notify(
          "Usage: /loop [--language go|java|typescript] [--coverage N] [--branch [name]] <spec-path>",
          "warning",
        );
        return;
      }

      const specText = R.readSpec(merged.specPath, ctx.cwd);
      if (specText === null) {
        ctx.ui.notify(`Spec file not found: ${merged.specPath}`, "error");
        return;
      }

      const projectCwd = resolveProjectCwd(merged.specPath, ctx.cwd);
      const detected = detectProject(projectCwd);
      const language = (merged.language || detected?.language || "go") as LanguageKey;
      const buildTool = (detected?.buildTool || "maven") as BuildTool;
      if (!runPhase0Baseline(projectCwd, language, buildTool, ctx, debug)) return;

      state.current = createInitialState(
        merged.specPath, language, buildTool, merged.coverage, merged.timeout,
        merged.autoApprove, merged.maxA, merged.maxNegotiate, merged.maxB,
        merged.maxC, merged.maxDispute, merged.maxTurnsPerPhase,
      );
      initLiveMetrics({ specPath: merged.specPath, language, phase: "review" });

      if (merged.branch !== undefined) {
        if (!await applyBranchSetup(state, ctx, debug, ctx.cwd, merged.specPath, merged.branch)) return;
      }

      enterPhase0Review(state, pi, ctx, debug, specText);
    },
  };
}

function enterPhase0Review(
  state: { current: LoopState }, pi: ExtensionAPI,
  ctx: CommandContext, debug: DebugFn, specText: string,
): void {
  const analysis = R.analyzeSpec(specText);
  debug(`Phase 0: reviewing spec (${analysis.findings.length} findings)`);
  state.current.phase = "review";
  state.current.specFindings = analysis.findings;
  state.current.awaitingReview = true;

  const reviewPrompt = buildPhaseZeroPrompt(specText, analysis);
  ctx.ui.notify("Phase 0: Review findings before starting.", "info");
  ctx.ui.setStatus("loop", "Phase 0 — review pending");
  commit(state.current, pi, debug);
  sendPrompt(pi, reviewPrompt, state.current, debug);
}

function rejectLoopStart(
  ctx: CommandContext, debug: DebugFn, baseline: ReturnType<typeof runBaseline>,
): void {
  ctx.ui.notify(
    `Baseline check failed: the existing test suite is not green, so the loop cannot continue.\n` +
      formatBaselineFailure(baseline),
    "error",
  );
  ctx.ui.setStatus("loop", "baseline failed — fix the test suite, then re-run /loop");
  debug(`Phase 0 baseline: FAIL (${baseline.failures.length} failing) — loop not started`);
}

export function buildPhaseZeroPrompt(specText: string, analysis: SpecAnalysis): string {
  const findingCount = analysis.findings.length;
  const reasons = analysis.reasons.join(", ");

  const lines = [
    "Phase 0: Spec Review",
    "",
    `The spec meets the threshold for review: ${reasons}`,
    "",
    "Review the spec below and check for ambiguities, missing edge cases, or underspecified behavior.",
    "",
    "Use negotiate_propose to approve (plan='approve') or provide feedback on findings.",
    "",
    `Spec content (${findingCount} potential findings):`,
    "",
    specText,
  ];

  if (findingCount > 0) {
    lines.push("");
    lines.push(R.buildSummaryTable(analysis.findings));
    for (const f of analysis.findings) {
      lines.push("");
      lines.push(R.formatFinding(f));
    }
  }

  return lines.join("\n");
}
