// --- effect-applicator ---
// Apply retry, advance, done, escalated effects.
// Spec: internal/05-extract-effect-applicator.md — verbatim port of the
// effect family from gate-transition.ts (spec 04). No new error handling.

import type { LoopState, GateResult } from "../../types";
import { getWorkspaceRoot } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import type * as T from "../../transitions";
import * as GP from "../../generic-prompts";
import { RETRY_PROMPTS, ADVANCE_PROMPTS } from "../../constants";
import { formatFailures } from "../../gates";
import { archiveSpecFile } from "../../spec-archive";
import { commitAndMerge, verifyMergeComplete, promptMergeConflict } from "../../git-workflow";
import { sendPrompt } from "../../prompt";
import { getLiveMetrics, finalize, formatReport, accumulatePhaseTransition } from "../../metrics";

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

// Git branch workflow (opt-in via --branch): merge the feature branch back
// into the mainline at the done effect. Returns a Promise that resolves when
// the merge has been attempted:
//   - "merged"   — clean merge; state.branch.merged is set.
//   - "conflict" — the Writer was prompted for the single resolution attempt;
//                  the merge is left in progress (MERGE_HEAD set). The next
//                  settle verifies the outcome (verifyBranchMerge) and
//                  escalates if the attempt failed.
//   - "error"    — the merge could not run; the branch is left in place.
// The done effect always reports loop completion (the merge is a post-step);
// the caller awaits this before sending the completion prompt.
export async function mergeBranchBack(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: (msg: string) => void,
): Promise<"merged" | "conflict" | "error"> {
  const branch = state.current.branch;
  if (!branch || branch.merged) return "merged";

  const outcome = await commitAndMerge(ctx.cwd, branch, state.current.language);
  if (outcome.kind === "merged") {
    branch.merged = true;
    ctx.ui.notify(`Merged '${branch.name}' into '${branch.base}'.`, "info");
    debug(`--branch merge: clean (${branch.name} → ${branch.base})`);
    return "merged";
  }
  if (outcome.kind === "conflict") {
    handleMergeConflict(outcome, branch, state.current, pi, ctx, debug);
    return "conflict";
  }
  debug(`--branch merge: ERROR (${outcome.error})`);
  ctx.ui.notify(
    `Merge back failed: ${outcome.error} — the feature branch is left unmerged. Resolve manually.`,
    "warning",
  );
  return "error";
}

// A merge conflict was detected: notify the user, set the UI status, and give
// the Writer one turn to resolve it. The merge is left in progress (MERGE_HEAD
// set); the next settle verifies the outcome via verifyBranchMerge.
function handleMergeConflict(
  outcome: { files: string[] },
  branch: { name: string; base: string },
  state: LoopState,
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: (msg: string) => void,
): void {
  debug(`--branch merge: CONFLICT (${outcome.files.length} files)`);
  ctx.ui.notify(
    `Merge conflict merging '${branch.name}' into '${branch.base}' — the Writer gets one turn to resolve it.`,
    "warning",
  );
  ctx.ui.setStatus("loop", `merge conflict — Writer resolving (${branch.name})`);
  sendPrompt(pi, promptMergeConflict(outcome.files), state, debug);
}

// Verify the Writer's single conflict-resolution attempt. Called from the
// settle dispatcher when the loop is done but the merge is still in progress.
// Returns true when the merge is complete (state.branch.merged set), false
// when it is still broken (the caller escalates — the single attempt is spent).
export async function verifyBranchMerge(
  state: { current: LoopState },
  ctx: EventCtx,
  debug: (msg: string) => void,
): Promise<boolean> {
  const branch = state.current.branch;
  if (!branch || branch.merged) return true;

  const outcome = await verifyMergeComplete(ctx.cwd);
  if (outcome.kind === "merged") {
    branch.merged = true;
    ctx.ui.notify(`Merge complete: '${branch.name}' is now in '${branch.base}'.`, "info");
    debug(`--branch merge: verified complete (${branch.name} → ${branch.base})`);
    return true;
  }
  const detail = outcome.kind === "conflict"
    ? `${outcome.files.length} conflicted file(s) remain`
    : outcome.error;
  ctx.ui.notify(
    `Merge conflict resolution failed (${detail}). The Writer's single attempt is spent — resolving manually: "git merge --continue" or "git merge --abort" on '${branch.base}'.`,
    "warning",
  );
  ctx.ui.setStatus("loop", `merge conflict — ESCALATED (manual resolution needed)`);
  debug(`--branch merge: ESCALATED (${detail})`);
  return false;
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
  state?: LoopState,
): string {
  const failures = gateResult.failures;
  const summary = formatFailures(failures);
  const count = failures.length;
  const ws = state ? getWorkspaceRoot(state.specPath) : undefined;

  switch (promptType) {
    case RETRY_PROMPTS.TESTER_COMPILE_RETRY:
    case RETRY_PROMPTS.TESTER_DISPUTE_FIX_COMPILE_FAIL:
      return lang.prompts.promptTesterCompileRetry(gateResult.compileError);
    case RETRY_PROMPTS.WRITER_PHASE_B_RETRY:
    case RETRY_PROMPTS.WRITER_DISPUTE_FIX_INCOMPLETE:
      return lang.prompts.promptWriterPhaseBContinue(summary, count, ws);
    case RETRY_PROMPTS.CLEANER_RETRY:
      return lang.prompts.promptCleanerRetry(summary, count, ws);
    default:
      return "Fix the issues and try again.";
  }
}

export function buildAdvancePrompt(
  promptType: string,
  state: LoopState,
  lang: LanguageConfig,
): string {
  const ws = getWorkspaceRoot(state.specPath);
  switch (promptType) {
    case ADVANCE_PROMPTS.WRITER_NEGOTIATE:
      return GP.promptWriterNegotiate(state.specPath, lang.testFilePattern);
    case ADVANCE_PROMPTS.WRITER_PHASE_B:
      return lang.prompts.promptWriterPhaseB(ws);
    case ADVANCE_PROMPTS.CLEANER_PHASE_C:
      return lang.prompts.promptCleanerPhaseC(ws);
    default:
      return promptType;
  }
}
