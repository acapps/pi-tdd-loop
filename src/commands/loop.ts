// /loop command — internal/refactor-commands-split.md
//
// cmdLoop + createInitialState + buildPhaseZeroPrompt. The Phase 0
// start-path helpers (baseline, branch setup, review entry) live in
// commands/loop-baseline.ts to keep this file under the 200-line budget.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState, LanguageKey, BuildTool, SpecAnalysis } from "../types";
import * as R from "../reviewer";
import { detectProject, isValidLanguage } from "../languages";
import { initLiveMetrics } from "../metrics";
import { parseLoopArgs, loadLoopConfig, mergeLoopArgs } from "../selectors";
import {
  resolveProjectCwd, runPhase0Baseline, applyBranchSetup, enterPhase0Review,
} from "./loop-baseline";
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
    lastProposal: "", lastPhase: "A", justTransitioned: false, justTransitionedBySettle: false,
    negotiateReprompted: false, negotiateProposed: false,
    negotiateFeedback: "", autoApprove,
  };
}

export function cmdLoop(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Start adversarial loop: [--language go|java|typescript] [--coverage N] [--branch [name]] <spec-path>",
    handler: async (args: string, ctx: CommandContext) => {
      const merged = parseAndMerge(args, ctx);
      if (!merged) return;

      const specText = R.readSpec(merged.specPath, ctx.cwd);
      if (specText === null) {
        ctx.ui.notify(`Spec file not found: ${merged.specPath}`, "error");
        return;
      }

      const projectCwd = resolveProjectCwd(merged.specPath, ctx.cwd);
      const detected = detectProject(projectCwd);
      if (merged.language && !isValidLanguage(merged.language)) {
        ctx.ui.notify(
          `Invalid language: '${merged.language}'. Valid options: go, java, typescript.`,
          "error",
        );
        return;
      }
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

// Parse CLI args + local config, merge them, and validate the result.
// Emits warnings/usage errors on ctx and returns null when the loop
// must not start.
function parseAndMerge(args: string, ctx: CommandContext) {
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
    return null;
  }
  return merged;
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
  ];

  if (findingCount > 0) {
    lines.push(
      "Auto-generated findings below are heuristic candidates, not verified defects: verify each against the spec text; if a candidate is a false positive, reject it in a single negotiate_propose call (plan='reject-findings: <per-finding rationale>') before approving.",
      "",
    );
  }

  lines.push(
    `Spec content (${findingCount} potential findings):`,
    "",
    specText,
  );

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