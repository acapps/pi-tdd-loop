// --- Command handlers ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Phase, LoopState, LanguageKey, BuildTool, SpecAnalysis } from "./types";
import { getWorkspaceRoot } from "./types";
import type { DebugFn } from "./events";
import { formatStatus, parseLoopArgs, loadLoopConfig, mergeLoopArgs, normalizeSpecPath } from "./selectors";
import { getPhaseMax } from "./phase-max";
import { formatFailures } from "./gates";
import * as GP from "./generic-prompts";
import * as R from "./reviewer";
import { runBaseline, formatBaselineFailure } from "./baseline";
import { setupBranch } from "./git-workflow";
import { getLanguageConfig, detectProject } from "./languages";
import { slugBugName, extractLoopLogs, renderBugSpec, writeBugSpec } from "./bug-spec";
import { commit } from "./commit";
import { sendPrompt } from "./prompt";
import { startPhaseA } from "./phase-a";
import { initLiveMetrics, clearLiveMetrics } from "./metrics";

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
  buildTool: BuildTool,
  coverage: number | undefined,
  timeoutSec?: number,
  autoApprove?: boolean,
  maxA?: number,
  maxNegotiate?: number,
  maxB?: number,
  maxC?: number,
  maxDispute?: number,
  maxTurnsPerPhase?: number,
): LoopState {
  return {
    phase: "A",
    round: 1,
    specPath,
    language,
    buildTool,
    maxA: maxA ?? 3,
    maxNegotiate: maxNegotiate ?? 3,
    maxB: maxB ?? 5,
    maxC: maxC ?? 3,
    maxDispute: maxDispute ?? 3,
    maxTurnsPerPhase: maxTurnsPerPhase ?? 5,
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
    autoApprove,
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
      const cliArgs = parseLoopArgs(args);
      const config = loadLoopConfig(ctx.cwd);
      for (const w of config.warnings) {
        ctx.ui.notify(w, "warning");
      }
      const { specPath, coverage, language: argLanguage, branch: branchArg, timeout: timeoutArg, autoApprove, maxA, maxNegotiate, maxB, maxC, maxDispute, maxTurnsPerPhase } = mergeLoopArgs(cliArgs, config.args);
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

      state.current = createInitialState(specPath, language, buildTool, coverage, timeoutArg, autoApprove, maxA, maxNegotiate, maxB, maxC, maxDispute, maxTurnsPerPhase);
      initLiveMetrics({ specPath, language, phase: "review" });

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
      state.current.phase = "review";
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
      ctx.ui.notify(formatStatusLines(s), "info");
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

function isIdleOrDone(phase: Phase): boolean {
  return phase === "idle" || phase === "done";
}

function formatStatusLines(s: LoopState): string {
  const maxTurns = s.maxTurnsPerPhase ?? 5;
  const phaseMax = getPhaseMax(s, s.phase);
  return [
    `Phase: ${s.phase} (round ${s.round}/${phaseMax})`,
    `Turns this phase: ${s.turnsThisPhase}/${maxTurns}`,
    `Disputes: ${s.disputeCount}/${s.maxDispute}`,
    `Spec: ${s.specPath}`,
    `Language: ${s.language} / ${s.buildTool}`,
  ].join("\n");
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

interface SessionEntry {
  type?: unknown;
  customType?: unknown;
  timestamp?: unknown;
  data?: { ts?: unknown } | null;
}

const DEBUG_LOG_TYPES = new Set([
  "loop-debug",
  "loop-gate",
  "loop-refusal",
  "loop-negotiate",
  "loop-dispute",
]);

function isDebugLogEntry(entry: SessionEntry): entry is SessionEntry & { customType: string } {
  return entry.type === "custom" && typeof entry.customType === "string" && DEBUG_LOG_TYPES.has(entry.customType);
}

function entryTimestamp(entry: SessionEntry): string {
  const dataTs = entry.data?.ts;
  if (typeof dataTs === "number") return new Date(dataTs).toISOString();
  if (typeof entry.timestamp === "string") return entry.timestamp;
  return "-";
}

function extractDebugLogs(entries: unknown[]): string[] {
  return entries
    .map((e) => e as SessionEntry)
    .filter(isDebugLogEntry)
    .map((entry) => `[${entryTimestamp(entry)}] ${entry.customType}: ${JSON.stringify(entry).slice(0, 120)}`);
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

      startPhaseA(state, pi, ctx, debug);
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

export function cmdPatch(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Patch the spec and restart from a phase: [spec-path] [--from <phase>]",
    handler: async (args: string, ctx: CommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let specPath = state.current.specPath;
      let fromPhase: Phase | undefined;

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--from" && i + 1 < parts.length) {
          const target = parts[++i].trim().toLowerCase();
          if (["a", "negotiate", "b", "c"].includes(target)) {
            fromPhase = target === "negotiate" ? "negotiate" : (target.toUpperCase() as Phase);
          } else {
            ctx.ui.notify(`Invalid --from value: ${parts[i]}. Use A, negotiate, B, or C.`, "warning");
            return;
          }
        } else if (!parts[i].startsWith("--")) {
          specPath = normalizeSpecPath(parts[i]);
        }
      }

      // Decision table
      if (isIdleOrDone(state.current.phase)) {
        ctx.ui.notify(
          state.current.phase === "done"
            ? "Loop is complete. Use /loop <spec> to start a new loop."
            : "Loop is not running. Use /loop <spec> to start.",
          "warning",
        );
        return;
      }

      // Validate spec file exists
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const fullSpecPath = resolve(ctx.cwd, specPath);
      if (!existsSync(fullSpecPath)) {
        ctx.ui.notify(`Spec file not found: ${specPath}`, "error");
        return;
      }

      const oldPhase = state.current.phase;
      const targetPhase = fromPhase ?? (state.current.phase === "escalated" ? (state.current.lastPhase as Phase) : "A");

      // Record the patch event
      try {
        pi.appendEntry("loop-spec-patch", {
          specPath,
          fromPhase: oldPhase,
          toPhase: targetPhase,
          ts: new Date().toISOString(),
        });
      } catch {
        // Best-effort in print mode
      }

      // Mutate state
      state.current.specPath = specPath;
      state.current.phase = targetPhase;
      state.current.lastPhase = oldPhase;
      resetPhaseState(state.current);
      state.current.justTransitioned = true;

      commit(state.current, pi, debug);
      ctx.ui.notify(`Spec patched. Restarting from Phase ${targetPhase}, round 1.`, "info");
      ctx.ui.setStatus("loop", `Phase ${targetPhase} — round 1 (patched)`);
      debug(`Command: /loop-patch → ${oldPhase} → ${targetPhase} (spec: ${specPath})`);

      sendPrompt(
        pi,
        `The spec at ${specPath} has been patched. Re-read it carefully.\nRestarting from Phase ${targetPhase} (round 1).\nFocus on the changes — the previous tests/implementation may encode the old behavior.`,
        state.current,
        debug,
      );
    },
  };
}

export function cmdDecompose(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Decompose a spec into sub-specs: <spec-path> [--out <dir>] [--prefix <slug>]",
    handler: async (args: string, ctx: CommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let specPath = "";
      let outDir = "internal";
      let prefix = "";

      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === "--out" && i + 1 < parts.length) {
          outDir = parts[++i];
        } else if (parts[i].startsWith("--out=")) {
          outDir = parts[i].split("=").slice(1).join("=");
        } else if (parts[i] === "--prefix" && i + 1 < parts.length) {
          prefix = parts[++i];
        } else if (parts[i].startsWith("--prefix=")) {
          prefix = parts[i].split("=").slice(1).join("=");
        } else if (!parts[i].startsWith("--")) {
          specPath = normalizeSpecPath(parts[i]);
        }
      }

      // Row 0: no args
      if (!specPath) {
        ctx.ui.notify("Usage: /loop-decompose <spec-path> [--out <dir>] [--prefix <slug>]", "warning");
        return;
      }

      // Row 1: spec file not found
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const fullSpecPath = resolve(ctx.cwd, specPath);
      if (!existsSync(fullSpecPath)) {
        ctx.ui.notify(`Spec not found: ${specPath}`, "error");
        return;
      }

      // Derive prefix from spec filename if not given
      if (!prefix) {
        const basename = specPath.split("/").pop()?.replace(/\.md$/, "") ?? "spec";
        prefix = basename.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      }

      // Row 2: build prompt and send
      const prompt = `Read the spec at ${specPath}. Break it into independently-testable units.
Each unit must:
1. Be implementable and testable in a single /loop run
2. Have a clear, self-contained scope (no "and other related things")
3. Reference the parent spec and its position in the sequence
4. Include all required sections: Target, Behavior, Inventory, Test Strategy, Scope lines, Acceptance Criteria, Dependencies, Findings log

Write each unit as ${outDir}/${prefix}-<N>.md.
Write a summary at ${outDir}/${prefix}-index.md with the table above.

Rules:
- Maximum 5 units. If the spec needs more, group related endpoints/features.
- Each unit's "Dependencies" section lists the units it depends on.
- The last unit may be an "integration" unit that tests the whole system.
- Do NOT modify the parent spec.`;

      debug(`Command: /loop-decompose ${specPath} → ${outDir}/${prefix}-*`);
      ctx.ui.notify(`Decomposing ${specPath} into ${outDir}/${prefix}-* ...`, "info");
      ctx.ui.setStatus("loop", `decomposing: ${specPath}`);

      sendPrompt(pi, prompt, state.current, debug);
    },
  };
}
