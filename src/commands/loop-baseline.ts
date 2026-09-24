// /loop command — Phase 0 start-path helpers (baseline, branch setup,
// review entry). Split out of commands/loop.ts to keep that file under
// the 200-line budget (internal/refactor-commands-split.md AC5).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState, LanguageKey, BuildTool, SpecAnalysis } from "../types";
import { getWorkspaceRoot } from "../types";
import * as R from "../reviewer";
import { runBaseline, formatBaselineFailure } from "../baseline";
import { setupBranch } from "../git-workflow";
import { commit } from "../commit";
import { sendPrompt } from "../prompt";
import { buildPhaseZeroPrompt } from "./loop";
import type { DebugFn } from "../events";

export function resolveProjectCwd(specPath: string, cwd: string): string {
  const ws = getWorkspaceRoot(specPath);
  return ws === "." ? cwd : ws;
}

export function runPhase0Baseline(
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

export async function applyBranchSetup(
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

export function enterPhase0Review(
  state: { current: LoopState }, pi: ExtensionAPI,
  ctx: CommandContext, debug: DebugFn, specText: string,
): void {
  const analysis: SpecAnalysis = R.analyzeSpec(specText);
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

export function rejectLoopStart(
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
