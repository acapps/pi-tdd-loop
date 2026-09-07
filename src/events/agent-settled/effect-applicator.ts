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
import { archiveSpecFile } from "../../spec-archive";
import { commitAndMerge, verifyMergeComplete, promptMergeConflict } from "../../git-workflow";

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
  if (effect.phase === "C") {
    // The implementation is complete and the gate is green: archive the spec
    // now, before Phase C, so a crash in Phase C still leaves the work marked
    // done- (Phase C is a nice-to-have pass, not the delivery point).
    const archived = archiveSpecFile(state.specPath, ctx.cwd);
    if (archived) {
      ctx.ui.notify(`Spec archived: ${archived}`, "info");
      debug(`Spec archived: ${archived}`);
    }
  }
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
  sendPrompt(
    pi,
    GP.promptLoopComplete(state.specPath, state.disputeCount, effect.status === "done (cleaner failed)"),
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
    debug(`--branch merge: CONFLICT (${outcome.files.length} files)`);
    ctx.ui.notify(
      `Merge conflict merging '${branch.name}' into '${branch.base}' — the Writer gets one turn to resolve it.`,
      "warning",
    );
    ctx.ui.setStatus("loop", `merge conflict — Writer resolving (${branch.name})`);
    pi.sendUserMessage(promptMergeConflict(outcome.files), { triggerTurn: true });
    return "conflict";
  }
  debug(`--branch merge: ERROR (${outcome.error})`);
  ctx.ui.notify(
    `Merge back failed: ${outcome.error} — the feature branch is left unmerged. Resolve manually.`,
    "warning",
  );
  return "error";
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
