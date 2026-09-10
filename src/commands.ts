// --- Command handlers ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Phase, LoopState, LanguageKey, BuildTool, SpecAnalysis } from "./types";
import { getWorkspaceRoot } from "./types";
import type { DebugFn } from "./events";
import { formatStatus, parseLoopArgs } from "./selectors";
import { formatFailures } from "./gates";
import * as GP from "./generic-prompts";
import * as R from "./reviewer";
import { runBaseline, formatBaselineFailure } from "./baseline";
import { setupBranch } from "./git-workflow";
import { getLanguageConfig, detectProject } from "./languages";
import { slugBugName, extractLoopLogs, renderBugSpec, writeBugSpec } from "./bug-spec";
import { commit } from "./commit";
import { sendPrompt } from "./prompt";

// --- Types ---

interface CommandContext {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  sessionManager: {
    getEntries: () => unknown[];
  };
  cwd: string;
}

// --- Helpers ---

function buildContinuePrompt(state: LoopState): string {
  const lang = getLanguageConfig(state.language);
  const gate = state.lastGateResult;
  const ws = getWorkspaceRoot(state.specPath);

  switch (state.phase) {
    case "A": return lang.prompts.promptTesterPhaseA(state.specPath, state.buildTool, ws);
    case "negotiate":
      return state.round % 2 === 1
        ? GP.promptWriterNegotiate(state.specPath, lang.testFilePattern)
        : GP.promptNegotiateRepromptTester();
    case "B":
      if (gate && !gate.allPassed) {
        return lang.prompts.promptWriterPhaseBContinue(
          formatFailures(gate.failures),
          gate.failures.length,
          ws,
        );
      }
      return lang.prompts.promptWriterPhaseB(ws);
    case "C":
      if (gate && !gate.allPassed) {
        return lang.prompts.promptCleanerRetry(
          formatFailures(gate.failures),
          gate.failures.length,
          ws,
        );
      }
      return lang.prompts.promptCleanerPhaseC(ws);
    default:
      return "Continue.";
  }
}

function buildRestartPrompt(state: LoopState, specPath: string): string {
  const lang = getLanguageConfig(state.language);
  const ws = getWorkspaceRoot(specPath);
  switch (state.phase) {
    case "A": return lang.prompts.promptTesterPhaseARestart(specPath, state.buildTool, ws);
    case "negotiate": return GP.promptWriterNegotiate(specPath, lang.testFilePattern);
    case "B": return lang.prompts.promptWriterPhaseB(ws);
    case "C": return lang.prompts.promptCleanerRestart(ws);
    case "review": return `Phase 0: Spec review. Use negotiate_propose to approve or provide feedback.`;
    case "done": return `Phase done. Loop complete.`;
    case "escalated": return `Phase escalated. Awaiting human intervention.`;
    case "idle": return `Phase idle. Run /loop to start.`;
    default: return "";
  }
}

function resetPhaseState(state: LoopState): void {
  state.round = 1;
  state.disputeCount = 0;
  state.dispute = { status: "none" };
  state.negotiateReprompted = false;
  state.negotiateProposed = false;
  state.negotiateFeedback = "";
  state.justTransitioned = false;
  state.dispute = { status: "none" };
  state.turnsThisPhase = 1;
}

function resolvePhaseArg(raw: string): Phase {
  const target = raw.trim().toLowerCase();
  if (!["review", "a", "negotiate", "b", "c", "done", "escalated", "idle"].includes(target)) {
    throw new Error("Invalid phase");
  }
  return target === "negotiate" ? "negotiate" : (target.toUpperCase() as Phase);
}

function createInitialState(
  specPath: string,
  language: LanguageKey,
  buildTool: string,
  coverage: number | undefined,
  timeoutSec?: number,
): LoopState {
  return {
    phase: "A",
    round: 1,
    specPath,
    language,
    buildTool: buildTool as "maven" | "gradle",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: coverage ?? 80,
    gateTimeoutSec: timeoutSec ?? 60,
    dispute: { status: "none" },
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    negotiateProposed: false,
    negotiateFeedback: "",
  };
}

// --- Commands ---

export function cmdLoop(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Start adversarial loop: [--language go|java|typescript] [--coverage N] [--branch [name]] <spec-path>",
    handler: async (args: string, ctx: CommandContext) => {
      const { specPath, coverage, language: argLanguage, branch: branchArg, timeout: timeoutArg } = parseLoopArgs(args);
      if (!specPath) {
        ctx.ui.notify(
          "Usage: /loop [--language go|java|typescript] [--coverage N] [--branch [name]] <spec-path>",
          "warning",
        );
        return;
      }

      // Validate spec file exists
      const specText = R.readSpec(specPath, ctx.cwd);
      if (specText === null) {
        ctx.ui.notify(`Spec file not found: ${specPath}`, "error");
        return;
      }

      // Golden projects: detect and run baseline in the workspace root,
      // not ctx.cwd. Self-refactor: workspaceRoot is "." → same as ctx.cwd.
      const projectCwd = getWorkspaceRoot(specPath);
      const detected = detectProject(projectCwd === "." ? ctx.cwd : projectCwd);
      const language = (argLanguage || detected?.language || "go") as LanguageKey;
      const buildTool = (detected?.buildTool || "maven") as BuildTool;

      // Phase 0 baseline: the existing test suite must be green (or absent)
      // before the loop starts. On failure, state stays idle — the loop
      // does not start.
      const baselineCwd = projectCwd === "." ? ctx.cwd : projectCwd;
      const baseline = runBaseline(baselineCwd, language, buildTool);
      if (!baseline.ok) {
        rejectLoopStart(ctx, debug, baseline);
        return;
      }
      ctx.ui.notify(
        baseline.noTests
          ? "Baseline: no existing tests — starting from a clean slate."
          : "Baseline: existing test suite is green.",
        "info",
      );
      debug(`Phase 0 baseline: OK (${baseline.noTests ? "no existing tests" : "suite green"})`);

      state.current = createInitialState(specPath, language, buildTool, coverage, timeoutArg);
      const lang = getLanguageConfig(language);

      // Git branch workflow (opt-in via --branch): create the feature branch
      // off the mainline before Phase 0. On failure the loop does not start.
      // `--branch` with no value → default name derived from the spec path.
      if (branchArg !== undefined) {
        const setup = await setupBranch(ctx.cwd, specPath, branchArg || undefined);
        if (setup.kind === "error") {
          ctx.ui.notify(`Branch setup failed: ${setup.error}`, "error");
          ctx.ui.setStatus("loop", "branch setup failed — loop not started");
          debug(`--branch setup: FAIL (${setup.error})`);
          return;
        }
        applyBranchSetup(state, ctx, debug, setup.branch);
      }

      // Phase 0: Spec Review (always runs)
      const analysis = R.analyzeSpec(specText);
      debug(`Phase 0: reviewing spec (${analysis.findings.length} findings)`);
      state.current.phase = "review" as Phase;
      state.current.specFindings = analysis.findings;
      state.current.awaitingReview = true;

      const reviewPrompt = buildPhaseZeroPrompt(specText, analysis);
      ctx.ui.notify(
        `Phase 0: Review findings before starting.`,
        "info",
      );
      ctx.ui.setStatus("loop", "Phase 0 — review pending");
      commit(state.current, pi, debug);
      sendPrompt(pi, reviewPrompt, state.current, debug);
      return;
    },
  };
}

function rejectLoopStart(
  ctx: CommandContext,
  debug: DebugFn,
  baseline: ReturnType<typeof runBaseline>,
): void {
  ctx.ui.notify(
    `Baseline check failed: the existing test suite is not green, so the loop cannot continue.\n` +
      formatBaselineFailure(baseline),
    "error",
  );
  ctx.ui.setStatus("loop", "baseline failed — fix the test suite, then re-run /loop");
  debug(`Phase 0 baseline: FAIL (${baseline.failures.length} failing) — loop not started`);
}

function applyBranchSetup(
  state: { current: LoopState },
  ctx: CommandContext,
  debug: DebugFn,
  branch: { name: string; base: string; merged: boolean },
): void {
  state.current.branch = branch;
  ctx.ui.notify(
    `Branch: created '${branch.name}' off '${branch.base}'. The loop will merge it back on completion.`,
    "info",
  );
  debug(`--branch setup: OK (${branch.name} off ${branch.base})`);
}

function buildPhaseZeroPrompt(specText: string, analysis: SpecAnalysis): string {
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

export function cmdStatus(state: { current: LoopState }) {
  return {
    description: "Show current loop status",
    handler: async (_args: string, ctx: CommandContext) => {
      const s = state.current;
      if (s.phase === "idle") {
        ctx.ui.notify("Loop is not running.", "info");
        return;
      }
      if (s.phase === "done") {
        ctx.ui.notify(
          `Loop complete. (Phase ${s.lastPhase}, round ${s.round})`,
          "info",
        );
        return;
      }
      if (s.phase === "escalated") {
        ctx.ui.notify(
          `Loop escalated at Phase ${s.lastPhase}, round ${s.round}. Run /loop-continue to resume.`,
          "warning",
        );
        return;
      }
      const maxTurns = s.maxTurnsPerPhase ?? 5;
      const phaseMax = (s as any)[`max${s.phase}`] ?? 5;
      const lines = [
        `Phase: ${s.phase} (round ${s.round}/${phaseMax})`,
        `Turns this phase: ${s.turnsThisPhase}/${maxTurns}`,
        `Disputes: ${s.disputeCount}/${s.maxDispute}`,
        `Spec: ${s.specPath}`,
        `Language: ${s.language} / ${s.buildTool}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  };
}

export function cmdContinue(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Continue from current phase with fresh round",
    handler: async (_args: string, ctx: CommandContext) => {
      if (isIdleOrDone(state.current.phase)) {
        ctx.ui.notify("Nothing to continue. Run /loop <spec-path> to start.", "warning");
        return;
      }
      if (state.current.phase === "escalated") {
        state.current.phase = state.current.lastPhase;
        debug(`Command: /loop-continue → resumed from escalated to phase ${state.current.lastPhase}`);
      }
      resetPhaseState(state.current);
      ctx.ui.notify(`Continued from Phase ${state.current.phase}, round 1.`, "info");
      ctx.ui.setStatus("loop", `Phase ${state.current.phase} — round 1`);
      commit(state.current, pi, debug);
      sendPrompt(pi, buildContinuePrompt(state.current), state.current, debug);
    },
  };
}

function isIdleOrDone(phase: string): boolean {
  return phase === "idle" || phase === "done";
}

export function cmdRestart(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Restart from a specific phase: A, negotiate, B, or C",
    handler: async (args: string, ctx: CommandContext) => {
      try {
        const phase = resolvePhaseArg(args);
        handlePhaseRestart(state, pi, debug, ctx, phase);
      } catch {
        ctx.ui.notify("Usage: /loop-restart <A|negotiate|B|C>", "warning");
      }
    },
  };
}

function handlePhaseRestart(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
  ctx: CommandContext,
  phase: Phase,
): void {
  const detected = detectProject(ctx.cwd);
  if (phase === "A" && detected) {
    state.current.language = detected.language;
    state.current.buildTool = detected.buildTool as BuildTool;
  }

  state.current.phase = phase;
  resetPhaseState(state.current);
  state.current.lastPhase = phase;
  debug(`Command: /loop-restart ${phase} → round 1`);
  ctx.ui.notify(`Restarted from Phase ${phase}, round 1.`, "info");
  ctx.ui.setStatus("loop", `Phase ${phase} — round 1`);
  commit(state.current, pi, debug);
  sendPrompt(pi, buildRestartPrompt(state.current, state.current.specPath), state.current, debug);
}

export function cmdDebug(
  state: { current: LoopState },
  debug: DebugFn,
) {
  return {
    description: "Show loop debug log",
    handler: async (args: string, ctx: CommandContext) => {
      // Argument parsing (pinned — internal/log-bug-spec.md): whitespace-split;
      // leftmost --log-bug / --log-bug=* token selects log-bug mode. Space form
      // consumes following non--- tokens joined with " "; equals form takes the
      // remainder verbatim. All other args are ignored in both modes.
      const parsed = parseLogBugArgs(args);
      if (parsed === null) {
        showDebugLog(ctx);
        return;
      }
      runLogBug(state, debug, ctx, parsed.name);
    },
  };
}

// Parsed /loop-debug args: null = legacy mode (no --log-bug flag),
// otherwise the bug name to slugify.
function parseLogBugArgs(args: string): { name: string } | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--log-bug") {
      const nameTokens: string[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].startsWith("--")) break;
        nameTokens.push(tokens[j]);
      }
      return { name: nameTokens.join(" ") };
    }
    if (tokens[i].startsWith("--log-bug=")) {
      return { name: tokens[i].slice("--log-bug=".length) };
    }
  }
  return null;
}

function showDebugLog(ctx: CommandContext): void {
  const logs = extractDebugLogs(ctx.sessionManager.getEntries());
  ctx.ui.notify(
    `Loop debug (${logs.length} entries):\n${logs.slice(-20).join("\n")}`,
    "info",
  );
}

function runLogBug(
  state: { current: LoopState },
  debug: DebugFn,
  ctx: CommandContext,
  name: string,
): void {
  const slug = slugBugName(name);
  if (slug === "") {
    ctx.ui.notify("Usage: /loop-debug --log-bug <name>", "warning");
    return;
  }

  const markdown = renderBugSpec({
    name,
    slug,
    phase: state.current.phase,
    round: state.current.round,
    specPath: state.current.specPath,
    language: state.current.language,
    lines: extractLoopLogs(ctx.sessionManager.getEntries()),
    now: new Date(),
  });
  const result = writeBugSpec(ctx.cwd, slug, markdown);
  if (result.ok) {
    debug(`log-bug: wrote ${result.path}`);
    ctx.ui.notify(
      `Wrote bug-fix-${slug}.md\nNext: fill in Observed problem / Proposed fix, then /loop bug-fix-${slug}.md`,
      "info",
    );
    return;
  }
  if (result.reason === "exists") {
    ctx.ui.notify(
      `bug-fix-${slug}.md already exists. Pick a different name.`,
      "error",
    );
    return;
  }
  ctx.ui.notify(
    `Failed to write bug-fix-${slug}.md: ${result.message}`,
    "error",
  );
}

function extractDebugLogs(entries: unknown[]): string[] {
  const validTypes = [
    "loop-debug",
    "loop-gate",
    "loop-refusal",
    "loop-negotiate",
    "loop-dispute",
  ];
  return entries
    .filter((e) => (e as Record<string, unknown>).type === "custom" &&
      validTypes.includes((e as Record<string, string>).customType))
    .map((e) => {
      const entry = e as Record<string, unknown>;
      const d = entry.data as { ts?: number } | null | undefined;
      const ts = typeof d?.ts === "number" ? new Date(d.ts).toISOString() : typeof entry.timestamp === "string" ? entry.timestamp : "-";
      return `[${ts}] ${entry.customType}: ${JSON.stringify(entry).slice(0, 120)}`;
    });
}

export function cmdCancel(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Cancel the loop and return to idle",
    handler: async (_args: string, ctx: CommandContext) => {
      state.current.phase = "idle";
      state.current.dispute = { status: "none" };
      state.current.round = 0;
      debug("Command: /loop-cancel → idle");
      ctx.ui.notify("Loop cancelled.", "info");
      ctx.ui.setStatus("loop", "idle");
      commit(state.current, pi, debug);
    },
  };
}

export function cmdApprove(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Approve Phase 0 review and proceed to Phase A",
    handler: async (_args: string, ctx: CommandContext) => {
      if (state.current.phase !== "review") {
        ctx.ui.notify("Not in Phase 0 review. Run /loop <spec-path> to start.", "warning");
        return;
      }

      debug("Command: /loop-approve → Phase A, round 1");
      state.current.phase = "A";
      state.current.round = 1;
      state.current.awaitingReview = false;
      state.current.turnsThisPhase = 1;

      const lang = getLanguageConfig(state.current.language);
      ctx.ui.notify("Spec review approved. Phase A: Tester writes contract.", "info");
      ctx.ui.setStatus("loop", "Phase A — round 1");
      commit(state.current, pi, debug);

      sendPrompt(
        pi,
        lang.prompts.promptTesterPhaseA(state.current.specPath, state.current.buildTool),
        state.current,
        debug,
      );
    },
  };
}

export function cmdStop(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Stop the loop, preserving state for /loop-continue",
    handler: async (_args: string, ctx: CommandContext) => {
      if (isIdleOrDone(state.current.phase)) {
        ctx.ui.notify("Loop is not running.", "warning");
        return;
      }
      const prevPhase = state.current.phase;
      const round = state.current.round;
      state.current.phase = "escalated";
      state.current.lastPhase = prevPhase;
      commit(state.current, pi, debug);
      ctx.ui.notify(
        `Loop stopped at Phase ${prevPhase}, round ${round}. Run /loop-continue to resume.`,
        "info",
      );
      ctx.ui.setStatus("loop", `Stopped — Phase ${prevPhase} round ${round}`);
      debug(`Command: /loop-stop → phase ${prevPhase} → escalated`);
    },
  };
}
