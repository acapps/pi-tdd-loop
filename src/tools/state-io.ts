// --- State persistence + transition helpers ---
// Depends on: types.ts (leaf), commit, prompt, effect-applicator, languages, constants.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as T from "../transitions";
import { ADVANCE_PROMPTS } from "../constants";
import { getLanguageConfig } from "../languages";
import { commit } from "../commit";
import { sendPrompt } from "../prompt";
import { buildAdvancePrompt } from "../events/agent-settled/effect-applicator";
import type { StateRef, ToolCtx, Debug } from "./types";

/** Snapshot the current state into the session log (single commit point). */
export function persistState(state: StateRef, pi: ExtensionAPI, debug: Debug): void {
  commit(state.current, pi, debug);
}

/** Shared negotiate → Phase B transition: reset transient flags, then apply the effect. */
export function transitionToPhaseB(state: StateRef, pi: ExtensionAPI, ctx: ToolCtx, debug: Debug): void {
  state.current.phase = "B";
  state.current.lastPhase = "negotiate";
  state.current.round = 1;
  state.current.turnsThisPhase = 1;
  state.current.justTransitioned = true;
  state.current.dispute = { status: "none" };
  state.current.negotiateReprompted = false;
  state.current.negotiateProposed = false;
  state.current.negotiateFeedback = "";
  applyTransitionEffect(state, pi, ctx, debug, {
    type: "advance",
    phase: "B",
    status: "Phase B — round 1",
    notify: "Approved — moving to Phase B.",
    prompt: ADVANCE_PROMPTS.WRITER_PHASE_B,
  });
}

/** Entry logging: the negotiate action entry. */
export function logNegotiateEntry(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  action: string,
  text: string,
): void {
  debug(`negotiate: ${action} — ${text.slice(0, 60)}`);
  pi.appendEntry("loop-negotiate", {
    phase: state.current.phase,
    round: state.current.round,
    action,
    text: text.slice(0, 500),
  });
}

/** Entry logging: dispute escalation (budget exhausted). */
export function logEscalation(state: StateRef, pi: ExtensionAPI, ctx: ToolCtx, debug: Debug): void {
  state.current.phase = "escalated";
  state.current.dispute = { status: "none" };
  persistState(state, pi, debug);
  ctx.ui.notify("Dispute limit reached. Escalating to human.", "warning");
  ctx.ui.setStatus("loop", "escalated (dispute limit)");
}

export function applyTransitionEffect(
  state: StateRef,
  pi: ExtensionAPI,
  ctx: ToolCtx,
  debug: Debug,
  effect: ReturnType<typeof T.computeNegotiateTransition>["effect"],
): void {
  debug(`applying transition: ${effect.type}`);
  persistState(state, pi, debug);
  ctx.ui.setStatus("loop", "status" in effect ? effect.status : "Phase B — round 1");
  // Send the advance prompt (e.g. Phase B writer prompt). Without this the
  // Writer is never told to write the implementation — the followUp is queued
  // during the tool-call turn and the settle is consumed by justTransitioned.
  // (bug-advance-effect-dual-path: the prompt send must stay in sync with the
  // agent-settled applier — buildAdvancePrompt is the single builder.)
  if (effect.type === "advance" && effect.prompt) {
    const lang = getLanguageConfig(state.current.language);
    sendPrompt(pi, buildAdvancePrompt(effect.prompt, state.current, lang), state.current, debug);
  }
}
