// --- effect-applicator ---
// Apply retry, advance, done, escalated effects.
// Spec: internal/05-extract-effect-applicator.md — verbatim port of the
// effect family from gate-transition.ts (spec 04). No new error handling.

import type { LoopState, GateResult } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import type * as T from "../../transitions";
import * as GP from "../../generic-prompts";
import { RETRY_PROMPTS, ADVANCE_PROMPTS } from "../../constants";
import { formatFailures } from "../../gates";

// --- Types ---

// B3: the typed 6-variant effect union produced by T.computeTransition.
// "reprompt" is unreachable via the gate path — the dispatcher's default
// branch is the type-level guard. T.TransitionEffect is not exported from
// transitions.ts, hence the same ReturnType alias pattern
// gate-transition.ts used. Type-only import — no runtime dependency.
type Effect = ReturnType<typeof T.computeTransition>["effect"];

// Named members of the union, for the private handler narrowing: the module
// handlers receive the full union via EffectInput, the dispatcher routes.
type RetryEffect = Extract<Effect, { type: "retry" }>;
type AdvanceEffect = Extract<Effect, { type: "advance" }>;
type DoneEffect = Extract<Effect, { type: "done" }>;
type EscalatedEffect = Extract<Effect, { type: "escalated" }>;

export interface EffectInput {
  // Wrapper shape: the call site wraps the NEW state object
  // ({ current: newState }). The ported code mutates this object.
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
  effect: Effect;
  gateResult: GateResult;
}

export interface EffectResult {
  // B2: return type is EffectResult — NOT bare boolean.
  applied: boolean;
}

// --- Private helpers ---

// Every effect prompt triggers the agent's turn (pi convention for
// messages that must start a new turn).
const sendPrompt = (pi: ExtensionAPI, prompt: string): void => {
  pi.sendUserMessage(prompt, { triggerTurn: true });
};

// --- Public API ---

export function applyEffect(input: EffectInput): EffectResult {
  switch (input.effect.type) {
    case "noop":
      return { applied: false };
    case "retry":
      return applyRetryEffect(input);
    case "advance":
      return applyAdvanceEffect(input);
    case "done":
      return applyDoneEffect(input);
    case "escalated":
      return applyEscalatedEffect(input);
    default:
      // Type-level guard: "reprompt" is produced only by the negotiate branch
      // (computeNegotiateTransition) and is unreachable via the gate path.
      // Mirrors the original inline dispatcher line-for-line.
      return { applied: false };
  }
}

export function applyRetryEffect(input: EffectInput): EffectResult {
  const state = input.state.current;
  const { pi, ctx, lang, debug, gateResult } = input;
  const effect = input.effect as RetryEffect;

  state.turnsThisPhase = 1;

    // Spec 09: the retired dispute branch is deleted — the settle step (Table 1)
  // clears awaitDisputeReview before the gate ever runs, so it cannot be set here.
  debug(`Retry ${effect.phase} round ${effect.round}`);
  ctx.ui.setStatus("loop", effect.status);
  if (effect.notify) {
    ctx.ui.notify(effect.notify, effect.level || "info");
  }
  if (effect.prompt) {
    sendPrompt(pi, buildRetryPrompt(effect.prompt, lang, gateResult));
  }
  return { applied: true };
}

export function applyAdvanceEffect(input: EffectInput): EffectResult {
  const state = input.state.current;
  const { pi, ctx, lang, debug } = input;
  const effect = input.effect as AdvanceEffect;

  state.turnsThisPhase = 1;
  debug(`Advance → ${effect.phase}`);

  ctx.ui.notify(effect.notify, "info");
  ctx.ui.setStatus("loop", effect.status);
  if (effect.prompt) {
    sendPrompt(pi, buildAdvancePrompt(effect.prompt, state, lang));
  }
  return { applied: true };
}

export function applyDoneEffect(input: EffectInput): EffectResult {
  const state = input.state.current;
  const { pi, ctx, debug } = input;
  const effect = input.effect as DoneEffect;

  state.turnsThisPhase = 1;
  debug("Done");
  ctx.ui.notify(effect.notify, "info");
  ctx.ui.setStatus("loop", effect.status);
  sendPrompt(
    pi,
    GP.promptLoopComplete(state.specPath, state.disputeCount, effect.status === "done (cleaner failed)"),
  );
  return { applied: true };
}

export function applyEscalatedEffect(input: EffectInput): EffectResult {
  const { ctx, debug } = input;
  const effect = input.effect as EscalatedEffect;

  debug(`Escalated (${effect.status})`);
  ctx.ui.notify(effect.notify, "warning");
  ctx.ui.setStatus("loop", effect.status);
  return { applied: true };
}

// --- Prompt builders ---
// Exported (G5): the fallback defaults are only directly testable
// through an export.

export function buildRetryPrompt(
  promptType: string,
  lang: LanguageConfig,
  gateResult: GateResult,
): string {
  const failures = gateResult.failures;
  const summary = formatFailures(failures);
  const count = failures.length;

  switch (promptType) {
    case RETRY_PROMPTS.TESTER_COMPILE_RETRY:
    case RETRY_PROMPTS.TESTER_DISPUTE_FIX_COMPILE_FAIL:
      return lang.prompts.promptTesterCompileRetry(gateResult.compileError);
    case RETRY_PROMPTS.WRITER_PHASE_B_RETRY:
    case RETRY_PROMPTS.WRITER_DISPUTE_FIX_INCOMPLETE:
      return lang.prompts.promptWriterPhaseBContinue(summary, count);
    case RETRY_PROMPTS.CLEANER_RETRY:
      return lang.prompts.promptCleanerRetry(summary, count);
    default:
      return "Fix the issues and try again.";
  }
}

export function buildAdvancePrompt(
  promptType: string,
  state: LoopState,
  lang: LanguageConfig,
): string {
  switch (promptType) {
    case ADVANCE_PROMPTS.WRITER_NEGOTIATE:
      return GP.promptWriterNegotiate(state.specPath, lang.testFilePattern);
    case ADVANCE_PROMPTS.CLEANER_PHASE_C:
      return lang.prompts.promptCleanerPhaseC();
    default:
      return promptType;
  }
}
