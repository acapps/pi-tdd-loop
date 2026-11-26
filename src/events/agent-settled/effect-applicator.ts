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
import { archiveSpecFile } from "../../spec-archive";
import { captureGitBaseline } from "../../scope-check";
import { sendPrompt } from "../../prompt";
import { getLiveMetrics, finalize, formatReport, accumulatePhaseTransition } from "../../metrics";
import { mergeBranchBack, verifyBranchMerge } from "./merge-back";
import { buildRetryPrompt, buildAdvancePrompt } from "./prompts";
import { runConsolidation } from "./consolidate";

// Split (refactor step 4): git merge-back → ./merge-back.ts; prompt builders
// → ./prompts.ts. Re-exported so every importer (incl. tests importing from
// "effect-applicator") keeps resolving.
export { mergeBranchBack, verifyBranchMerge } from "./merge-back";
export { buildRetryPrompt, buildAdvancePrompt } from "./prompts";

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

  debug(`Retry ${effect.phase} round ${effect.round}`);
  ctx.ui.setStatus("loop", effect.status);
  if (effect.notify) {
    ctx.ui.notify(effect.notify, effect.level || "info");
  }
  if (effect.prompt) {
    sendPrompt(pi, buildRetryPrompt(effect.prompt, lang, gateResult, state), state, debug);
  }
  return { applied: true };
}

export function applyAdvanceEffect(input: EffectInput): EffectResult {
  const state = input.state.current;
  const { pi, ctx, lang, debug } = input;
  const effect = input.effect as AdvanceEffect;

  state.turnsThisPhase = 1;
  debug(`Advance → ${effect.phase}`);

  const metrics = getLiveMetrics();
  if (metrics) accumulatePhaseTransition(metrics, effect.phase, state.round);

  ctx.ui.notify(effect.notify, "info");
  ctx.ui.setStatus("loop", effect.status);
  if (effect.phase === "C") {
    archiveSpecBeforePhaseC(state, ctx, debug);
  }
  // Re-capture the scope-check baseline when entering Phase B from Phase A
  // or negotiate: Phase A's test files are now "pre-existing" for Phase B's
  // scope check, not contamination. Without this, Phase A's output is
  // flagged as out-of-scope in Phase B (session 01a1c767: Writer conceded
  // to a scope-check dispute it shouldn't have had to make).
  if (effect.phase === "B" && (state.lastPhase === "A" || state.lastPhase === "negotiate")) {
    const baseline = captureGitBaseline(ctx.cwd);
    if (baseline !== null) {
      state.baselineDirtyFiles = baseline;
      debug(`Scope-check baseline re-captured for Phase B: ${baseline.length} file(s)`);
    }
  }
  if (effect.prompt) {
    deliverAdvancePrompt(pi, state, lang, effect, debug);
  }
  return { applied: true };
}

// Archive the spec file before Phase C starts: the implementation is complete
// and the gate is green, so mark the work done- now. A crash in Phase C (a
// nice-to-have pass, not the delivery point) still leaves the spec archived.
function archiveSpecBeforePhaseC(
  state: LoopState,
  ctx: EventCtx,
  debug: (msg: string) => void,
): void {
  const archived = archiveSpecFile(state.specPath, ctx.cwd);
  if (archived) {
    ctx.ui.notify(`Spec archived: ${archived}`, "info");
    debug(`Spec archived: ${archived}`);
  }
}

// --- Shared advance-prompt delivery (spec internal/bug-advance-effect-dual-path.md) ---
// The single place that delivers an advance effect's prompt. BOTH the
// agent-settled applier (applyAdvanceEffect) and the tool-call applier
// (src/tools/state-io.ts applyTransitionEffect) must call this so "what an
// advance does" (deliver the next phase's prompt) cannot diverge across the
// two entry points again. Prompt delivery ONLY: no state mutation, no direct
// pi.sendUserMessage — sendPrompt is the single delivery point.
export function deliverAdvancePrompt(
  pi: ExtensionAPI,
  state: LoopState,
  lang: LanguageConfig,
  effect: AdvanceEffect,
  debug: (msg: string) => void,
): void {
  if (effect.prompt) {
    sendPrompt(pi, buildAdvancePrompt(effect.prompt, state, lang), state, debug);
  }
}

export function applyDoneEffect(input: EffectInput): EffectResult {
  const state = input.state.current;
  const { pi, ctx, debug } = input;
  const effect = input.effect as DoneEffect;

  state.turnsThisPhase = 1;
  debug("Done");

  // Git branch workflow (opt-in via --branch): when the loop ran on a feature
  // branch, merge it back into the mainline before reporting completion.
  // Returns a Promise; the caller (handleGateTransition) awaits it. When no
  // branch is set (the common case) it resolves immediately as a no-op.
  if (state.branch && !state.branch.merged) {
    void mergeBranchBack({ current: state }, pi, ctx, debug);
  }

  // U2 (wire-holdback-test-contract): fold the Tester's two-tier contract before
  // the loop reports done — promote non-conceded holdback tests, drop conceded
  // ones. The spec's guarantee is absolute: the loop cannot report green with an
  // un-promoted holdback tier. A fold failure must therefore NOT report green —
  // that would be a false success (an un-folded holdback tier reported as done).
  // Escalate to the human (SPEC Invariant 5) instead: stop in the terminal
  // "escalated" phase, notify, and send one prompt. reportDone is deliberately
  // skipped so no completion prompt is ever sent on a fold failure.
  try {
    runConsolidation({ state, ctx, pi, debug });
  } catch (e) {
    debug(`Fold failed — escalating: ${e}`);
    // markDone (handlePhaseCTransition) already set lastPhase = "C" before this
    // done effect ran. Escalate from Phase C — a valid escalation origin
    // (ORIGIN_GATED_ORIGINS = A/negotiate/B/C). Do NOT overwrite lastPhase with
    // state.phase ("done"): escalation from "done" is rejected by the
    // state-machine invariant, which is exactly what stalled the loop. The fold
    // runs AFTER markDone, so the pre-fold origin ("C") is still carried here.
    state.phase = "escalated";
    state.turnsThisPhase = 1;
    state.dispute = { status: "none" };
    ctx.ui.notify(`Consolidation (fold) failed: ${e}. Escalating to human.`, "warning");
    ctx.ui.setStatus("loop", "escalated (fold/consolidation failed)");
    sendPrompt(pi, GP.promptConsolidationFailed(String(e)), state, debug);
    return { applied: true };
  }

  reportDone(state, effect, pi, ctx);
  return { applied: true };
}

function reportDone(state: LoopState, effect: DoneEffect, pi: ExtensionAPI, ctx: EventCtx): void {
  ctx.ui.notify(effect.notify, "info");
  ctx.ui.setStatus("loop", effect.status);

  // Build the completion report from live metrics
  const metrics = getLiveMetrics();
  let report: string;
  if (metrics) {
    const finalized = finalize(metrics, state.phase);
    report = formatReport(finalized);
  } else {
    // Fallback: no metrics (shouldn't happen in production, but safe for tests)
    const cleanerFailed = effect.status === "done (cleaner failed)";
    report = cleanerFailed
      ? `Loop complete — spec ${state.specPath}. Phase C failed; the original code is kept.`
      : `Loop complete — spec ${state.specPath}. All phases passed the gate.`;
  }

  sendPrompt(
    pi,
    GP.promptLoopReport(report),
    state,
    () => {},
  );
}

export function applyEscalatedEffect(input: EffectInput): EffectResult {
  const { ctx, debug } = input;
  const effect = input.effect as EscalatedEffect;

  debug(`Escalated (${effect.status})`);
  ctx.ui.notify(effect.notify, "warning");
  ctx.ui.setStatus("loop", effect.status);
  return { applied: true };
}
