// --- agent_settled dispatcher ---
// Routes to phase-specific handler based on current state.
// Spec: internal/04-implement-agent-settled-handlers.md (G2, G3, G5).

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import { getLanguageConfig, type LanguageConfig } from "../../languages";
import { handleDisputeFix, handleDisputeReview, handleDisputeDefend, handleWriterConcedeFix } from "./dispute";
import { handleReviewSettled } from "./review";
import { handleNegotiateSettled } from "./negotiate";
import { handleGateTransition } from "./gate-transition";

// --- Types ---

export interface AgentSettledDispatcherInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  ctx: EventCtx;
}

export interface AgentSettledDispatcher {
  (input: AgentSettledDispatcherInput): boolean | undefined;
}

// --- Local helpers ---
// stateSummary is a local copy, NOT a shared export: index.ts imports the
// sub-modules, so sub-modules importing from index.ts would create the
// circular dependency the refactor exists to remove (session-start.ts precedent).

function stateSummary(s: LoopState): string {
  return `Phase ${s.phase} round ${s.round}`;
}

function isTerminalPhase(phase: string): boolean {
  return phase === "idle" || phase === "done" || phase === "escalated";
}

function checkLoopEscalation(
  state: { current: LoopState },
  ctx: EventCtx,
  debug: (msg: string) => void,
): boolean {
  state.current.turnsThisPhase = (state.current.turnsThisPhase || 0) + 1;
  const maxTurns = state.current.maxTurnsPerPhase || 5;
  if (state.current.turnsThisPhase <= maxTurns) return false;

  debug(`Loop detected (${state.current.turnsThisPhase} turns in phase ${state.current.phase}), escalating`);
  state.current.lastPhase = state.current.phase;
  state.current.phase = "escalated";
  state.current.awaitDisputeFix = false;
  state.current.awaitDisputeReview = false;
  ctx.ui.notify(`Loop detected in Phase ${state.current.lastPhase}. Escalating to human.`, "warning");
  ctx.ui.setStatus("loop", "escalated (loop detected)");
  return true;
}

function handleJustTransitioned(
  state: { current: LoopState },
  pi: ExtensionAPI,
  lang: LanguageConfig,
  debug: (msg: string) => void,
): boolean {
  if (!state.current.justTransitioned) return false;
  debug(`agent_settled: justTransitioned → clearing & triggering turn (${stateSummary(state.current)})`);
  state.current.justTransitioned = false;

  if (state.current.phase === "B" && state.current.round === 1) {
    debug("agent_settled: triggering Phase B Writer turn");
    pi.sendUserMessage(lang.prompts.promptNegotiateApproved(), { triggerTurn: true });
  }
  return true;
}

// --- Public API ---

export async function handleAgentSettled(
  input: AgentSettledDispatcherInput,
): Promise<boolean | undefined> {
  const { state, pi, debug, ctx } = input;

  // Step 1: terminal short-circuit — BEFORE any lang resolution
  if (isTerminalPhase(state.current.phase)) return undefined;

  // Step 2: lang resolution — may throw on corrupted state
  const lang = getLanguageConfig(state.current.language);

  // Steps 3–6: guards — each returns undefined from the dispatcher when handled
  if (checkLoopEscalation(state, ctx, debug)) return undefined;
  if (handleJustTransitioned(state, pi, lang, debug)) return undefined;
  if (handleDisputeHandlers(state, pi, lang, debug, ctx)) return undefined;

  // Steps 7–9: phase handlers — dispatcher returns their result
  return await handlePhaseSettled(state, pi, lang, debug, ctx);
}

// Spec 09: the dispute chain, in order, first match wins; the gate is skipped
// for the settle that delivered a prompt.
function handleDisputeHandlers(
  state: { current: LoopState },
  pi: ExtensionAPI,
  lang: LanguageConfig,
  debug: (msg: string) => void,
  ctx: EventCtx,
): boolean {
  const input = { state, pi, lang, debug, ctx };
  // Dispute fix turn (spec 04).
  if (handleDisputeFix(input).handled) return true;
  // Table 1: the review turn is scheduled from the settle handler; the gate
  // resumes on the next settle.
  if (handleDisputeReview(input).handled) return true;
  // Table 3: follow-up delivery (defend decision / writer concede fix).
  if (handleDisputeDefend(input).handled) return true;
  if (handleWriterConcedeFix(input).handled) return true;
  return false;
}

// Steps 7–9: the phase-specific settle handlers.
async function handlePhaseSettled(
  state: { current: LoopState },
  pi: ExtensionAPI,
  lang: LanguageConfig,
  debug: (msg: string) => void,
  ctx: EventCtx,
): Promise<boolean> {
  if (state.current.phase === "review") {
    return handleReviewSettled({ state, pi, ctx, lang, debug }).handled;
  }
  if (state.current.phase === "negotiate") {
    const result = handleNegotiateSettled({ state: state.current, pi, ctx, lang, debug });
    state.current = result.newState; // G2: explicit reassignment
    return result.handled;
  }
  // A / B / C
  const gate = await handleGateTransition({ state: state.current, pi, ctx, lang, debug });
  state.current = gate.state; // G2: explicit reassignment
  if (gate.gateResult) state.current.lastGateResult = gate.gateResult; // G3: only real results
  return gate.applied;
}
