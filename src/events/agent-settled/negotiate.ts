// --- negotiate handler ---
// Delivers the negotiate round from settle context: proposal → Tester review,
// feedback → Writer revision, reprompt, auto-advance, or escalate.
// Spec: internal/04-implement-agent-settled-handlers.md (R1, G2); round wiring: internal/07-wire-negotiate-review.md.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import * as T from "../../transitions";
import * as GP from "../../generic-prompts";
import { REPROMPT_KEYS } from "../../constants";

// --- Types ---

export interface NegotiateHandlerInput {
  // Bare state (R1): pure-state handler — the dispatcher reassigns state.current
  // with the returned newState (G2); this handler never mutates the input.
  state: LoopState;
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
}

export interface NegotiateHandlerOutput {
  handled: boolean;
  newState: LoopState;
}

// --- Effect variants ---
// TransitionEffect is private to transitions.ts; its negotiate members are
// named here via Extract (effect-applicator.ts precedent).
type NegotiateEffect = ReturnType<typeof T.computeNegotiateTransition>["effect"];
type ReviewRequestEffect = Extract<NegotiateEffect, { type: "review-request" }>;
type FeedbackEffect = Extract<NegotiateEffect, { type: "feedback" }>;
type EscalatedEffect = Extract<NegotiateEffect, { type: "escalated" }>;
type RepromptEffect = Extract<NegotiateEffect, { type: "reprompt" }>;
type AdvanceEffect = Extract<NegotiateEffect, { type: "advance" }>;

// --- Public API ---

export function handleNegotiateSettled(
  input: NegotiateHandlerInput,
): NegotiateHandlerOutput {
  const { state, pi, ctx, lang, debug } = input;
  const proposed = state.negotiateProposed === true;
  const feedbackPending = (state.negotiateFeedback ?? "") !== "";
  debug(`Negotiate: settle (round ${state.round}, proposed=${proposed}, feedback=${feedbackPending}, reprompted=${state.negotiateReprompted})`);
  const { state: newState, effect } = T.computeNegotiateTransition(state);

  if (effect.type === "review-request") {
    deliverReviewRequest(state, effect, pi, ctx, debug);
  } else if (effect.type === "feedback") {
    deliverFeedback(state, effect, pi, ctx, debug);
  } else if (effect.type === "escalated") {
    deliverEscalated(effect, ctx, debug);
  } else if (effect.type === "reprompt") {
    deliverReprompt(effect, pi, ctx);
  } else if (effect.type === "advance") {
    deliverAdvance(effect, pi, ctx, lang, debug);
  }
  return { handled: true, newState };
}

// --- Effect delivery (one helper per variant; strings are spec-pinned verbatim) ---

function deliverReviewRequest(
  state: LoopState,
  effect: ReviewRequestEffect,
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: (msg: string) => void,
): void {
  debug(`Negotiate: proposal → Tester review (round ${state.round + 1})`);
  ctx.ui.notify(effect.notify, "info");
  pi.sendUserMessage(GP.promptNegotiateProposalForReview(state.lastProposal), { triggerTurn: true });
}

function deliverFeedback(
  state: LoopState,
  effect: FeedbackEffect,
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: (msg: string) => void,
): void {
  debug(`Negotiate: feedback → Writer revision (round ${state.round + 1})`);
  ctx.ui.notify(effect.notify, "info");
  pi.sendUserMessage(GP.promptNegotiateFeedback(state.negotiateFeedback ?? ""), { triggerTurn: true });
}

function deliverEscalated(
  effect: EscalatedEffect,
  ctx: EventCtx,
  debug: (msg: string) => void,
): void {
  debug("Negotiate: limit reached → escalating");
  ctx.ui.notify(effect.notify, "warning");
  ctx.ui.setStatus("loop", effect.status);
}

function deliverReprompt(
  effect: RepromptEffect,
  pi: ExtensionAPI,
  ctx: EventCtx,
): void {
  ctx.ui.notify(effect.notify, effect.level);
  const prompt = effect.prompt === REPROMPT_KEYS.WRITER
    ? GP.promptNegotiateRepromptWriter()
    : GP.promptNegotiateRepromptTester();
  pi.sendUserMessage(prompt, { triggerTurn: true });
}

function deliverAdvance(
  effect: AdvanceEffect,
  pi: ExtensionAPI,
  ctx: EventCtx,
  lang: LanguageConfig,
  debug: (msg: string) => void,
): void {
  debug("Negotiate: auto-advancing to Phase B");
  ctx.ui.notify(effect.notify, "info");
  ctx.ui.setStatus("loop", effect.status);
  pi.sendUserMessage(lang.prompts.promptNegotiateAutoAdvance(), { triggerTurn: true });
}
