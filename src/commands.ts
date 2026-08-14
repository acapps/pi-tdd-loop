// --- Command handlers ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Phase, LoopState, LanguageKey, BuildTool, SpecAnalysis } from "./types";
import { formatStatus, parseLoopArgs } from "./selectors";
import { formatFailures } from "./gates";
import * as GP from "./generic-prompts";
import * as R from "./reviewer";
import { getLanguageConfig, detectProject, DetectedProject } from "./languages";

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

type DebugFn = (msg: string) => void;

// --- Helpers ---

function buildContinuePrompt(state: LoopState): string {
  const lang = getLanguageConfig(state.language);
  const gate = state.lastGateResult;

  switch (state.phase) {
    case "A": return lang.prompts.promptTesterPhaseA(state.specPath, state.buildTool);
    case "negotiate":
      return state.round % 2 === 1
        ? GP.promptWriterNegotiate(state.specPath, lang.testFilePattern)
        : GP.promptNegotiateRepromptTester();
    case "B":
      if (gate && !gate.allPassed) {
        return lang.prompts.promptWriterPhaseBContinue(
          formatFailures(gate.failures),
          gate.failures.length,
        );
      }
      return lang.prompts.promptWriterPhaseB();
    case "C":
      if (gate && !gate.tests) {
        return lang.prompts.promptCleanerRetry(
          formatFailures(gate.failures),
          gate.failures.length,
        );
      }
      return lang.prompts.promptCleanerPhaseC();
    default:
      return "Continue.";
  }
}

function buildRestartPrompt(state: LoopState, specPath: string): string {
  const lang = getLanguageConfig(state.language);
  switch (state.phase) {
    case "A": return lang.prompts.promptTesterPhaseARestart(specPath, state.buildTool);
    case "negotiate": return GP.promptWriterNegotiate(specPath, lang.testFilePattern);
    case "B": return lang.prompts.promptWriterPhaseB();
    case "C": return lang.prompts.promptCleanerRestart();
    default: return "";
  }
}

function resetPhaseState(state: LoopState): void {
  state.round = 1;
  state.disputeCount = 0;
  state.disputeMode = false;
  state.negotiateReprompted = false;
  state.justTransitioned = false;
  state.awaitDisputeFix = false;
  state.turnsThisPhase = 1;
}

function resolvePhaseArg(raw: string): Phase {
  const target = raw.trim().toLowerCase();
  if (!["a", "negotiate", "b", "c"].includes(target)) {
    throw new Error("Invalid phase");
  }
  return target === "negotiate" ? "negotiate" : (target.toUpperCase() as Phase);
}

function createInitialState(
  specPath: string,
  language: LanguageKey,
  buildTool: string,
  coverage: number | undefined,
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
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
    skipPhase0: false,
  };
}

// --- Commands ---

export function cmdLoop(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Start adversarial loop: [--language go|java|typescript] [--coverage N] [--skip-review] <spec-path>",
    handler: async (args: string, ctx: CommandContext) => {
      const { specPath, coverage, language: argLanguage } = parseLoopArgs(args);
      if (!specPath) {
        ctx.ui.notify(
          "Usage: /loop [--language go|java|typescript] [--coverage N] [--skip-review] <spec-path>",
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

      const detected = detectProject(ctx.cwd);
      const language = (argLanguage || detected?.language || "go") as LanguageKey;
      const buildTool = (detected?.buildTool || "maven") as BuildTool;

      // Validate test runner is available
      const runnerCheck = R.validateTestRunner(ctx.cwd, language);
      if (!runnerCheck.ok) {
        ctx.ui.notify(
          `Test runner not available: ${runnerCheck.error}. Setup project first.`,
          "warning",
        );
      }

      state.current = createInitialState(specPath, language, buildTool, coverage);
      const lang = getLanguageConfig(language);

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
      pi.appendEntry("loop-state", { ...state.current });
      pi.sendUserMessage(reviewPrompt, { triggerTurn: true });
      return;
    },
  };
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
      ctx.ui.notify(formatStatus(state.current), "info");
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
      pi.appendEntry("loop-state", { ...state.current });
      pi.sendUserMessage(buildContinuePrompt(state.current), { triggerTurn: true });
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
  pi.appendEntry("loop-state", { ...state.current });
  pi.sendUserMessage(buildRestartPrompt(state.current, state.current.specPath), { triggerTurn: true });
}

export function cmdDebug() {
  return {
    description: "Show loop debug log",
    handler: async (_args: string, ctx: CommandContext) => {
      const entries = ctx.sessionManager.getEntries();
      const logs = extractDebugLogs(entries);
      ctx.ui.notify(
        `Loop debug (${logs.length} entries):\n${logs.slice(-20).join("\n")}`,
        "info",
      );
    },
  };
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
      const ts = entry.ts ? new Date(entry.ts as string).toLocaleTimeString() : "?";
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
      state.current.round = 0;
      state.current.disputeMode = false;
      debug("Command: /loop-cancel → idle");
      ctx.ui.notify("Loop cancelled.", "info");
      ctx.ui.setStatus("loop", "idle");
      pi.appendEntry("loop-state", { ...state.current });
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
      pi.appendEntry("loop-state", { ...state.current });

      pi.sendUserMessage(
        lang.prompts.promptTesterPhaseA(state.current.specPath, state.current.buildTool),
        { triggerTurn: true },
      );
    },
  };
}
