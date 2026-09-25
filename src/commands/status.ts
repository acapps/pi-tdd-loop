// /loop-status, /loop-continue, /loop-restart — internal/refactor-commands-split.md
//
// cmdStatus, cmdContinue, cmdRestart + helpers: formatStatusLines,
// buildContinuePrompt, buildRestartPrompt, handlePhaseRestart.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState, BuildTool, Phase } from "../types";
import type { DebugFn } from "../events";
import { getWorkspaceRoot } from "../types";
import { commit } from "../commit";
import { sendPrompt } from "../prompt";
import { getLanguageConfig, detectProject } from "../languages";
import * as GP from "../generic-prompts";
import { formatFailures } from "../gates";
import { getPhaseMax } from "../phase-max";
import { resetPhaseState, isIdleOrDone, resolvePhaseArg } from "../state-helpers";

export function buildContinuePrompt(state: LoopState): string {
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
    default: return "Continue.";
  }
}

export function buildRestartPrompt(state: LoopState, specPath: string): string {
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

export function formatStatusLines(state: LoopState): string {
  const phaseMax = getPhaseMax(state, state.phase);
  return [
    `Phase: ${state.phase} (round ${state.round}/${phaseMax})`,
    `Turns this phase: ${state.turnsThisPhase}/${state.maxTurnsPerPhase}`,
    `Disputes: ${state.disputeCount}/${state.maxDispute}`,
    `Spec: ${state.specPath}`,
    `Language: ${state.language} / ${state.buildTool}`,
  ].join("\n");
}

export function cmdStatus(state: { current: LoopState }) {
  return {
    description: "Show current loop state",
    handler: async (_args: string, ctx: CommandContext) => {
      const s = state.current;
      if (s.phase === "idle") {
        ctx.ui.notify("Loop is not running.", "info");
        return;
      }
      if (s.phase === "done") {
        ctx.ui.notify(`Loop complete. (Phase ${s.lastPhase}, round ${s.round})`, "info");
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
  state: { current: LoopState }, pi: ExtensionAPI, debug: DebugFn,
) {
  return {
    description: "Continue the loop from the current phase",
    handler: async (args: string, ctx: CommandContext) => {
      const s = state.current;
      if (isIdleOrDone(s.phase)) {
        ctx.ui.notify("Nothing to continue. Run /loop <spec-path> to start.", "warning");
        return;
      }
      if (s.phase === "escalated") {
        // If the user specified a phase argument, use it; otherwise fall back to lastPhase.
        if (args.trim()) {
          try {
            s.phase = resolvePhaseArg(args);
          } catch {
            ctx.ui.notify(`Invalid phase: ${args.trim()}. Use A, negotiate, B, or C.`, "warning");
            return;
          }
        } else {
          s.phase = s.lastPhase;
        }
        resetPhaseState(s);
        ctx.ui.notify(`Continued from Phase ${s.phase}, round 1.`, "info");
        commit(s, pi, debug);
        sendPrompt(pi, buildContinuePrompt(s), s, debug);
        return;
      }
      resetPhaseState(s);
      ctx.ui.notify(`Continued from Phase ${s.phase}, round 1.`, "info");
      ctx.ui.setStatus("loop", `Phase ${s.phase} — round 1`);
      commit(s, pi, debug);
      sendPrompt(pi, buildContinuePrompt(s), s, debug);
    },
  };
}

export function cmdRestart(
  state: { current: LoopState }, pi: ExtensionAPI, debug: DebugFn,
) {
  return {
    description: "Restart the loop from a specific phase: A|negotiate|B|C",
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

export function handlePhaseRestart(
  state: { current: LoopState }, pi: ExtensionAPI,
  debug: DebugFn, ctx: CommandContext, phase: Phase,
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
