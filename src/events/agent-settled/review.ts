// --- review handler (Phase 0) ---
// Await human approve before advancing, OR auto-advance when the review
// is clean (no feedback, no dispute) and autoApprove is on (default).
// Spec: internal/04-implement-agent-settled-handlers.md.
// Auto-approve: internal/phase0-auto-approve.md.

import type { LoopState } from "../../types";
import { getWorkspaceRoot } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import { commit } from "../../commit";
import { sendPrompt } from "../../prompt";
import { applyPhaseAFields } from "../../phase-a";

// --- Types ---

export interface ReviewHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
}

export interface ReviewHandlerOutput {
  handled: boolean;
}

// --- Public API ---

export function handleReviewSettled(
  input: ReviewHandlerInput,
): ReviewHandlerOutput {
  const { state, pi, ctx, lang, debug } = input;
  if (!state.current.awaitingReview) return { handled: false };

  // Row 2: --no-auto-approve → always wait for human.
  if (state.current.autoApprove === false) {
    return awaitHuman(input, "auto-approve disabled", "Phase 0: Review findings. Use /loop-approve to proceed.", "Phase 0 — review pending");
  }

  // Row 3: feedback was recorded → wait for human.
  if (state.current.lastProposal) {
    return awaitHuman(input, "feedback recorded", "Phase 0: Feedback recorded. Use /loop-approve to proceed.", "Phase 0 — review pending");
  }

  // Row 4: dispute is pending → wait for human.
  const disputeStatus = state.current.dispute?.status;
  if (disputeStatus === "filed" || disputeStatus === "in-review") {
    return awaitHuman(input, "dispute pending", "Phase 0: Dispute pending. Use /loop-approve to proceed.", "Phase 0 — review pending");
  }

  // Row 4b: blocker findings present → wait for human.
  const blockers = (state.current.specFindings ?? []).filter(f => f.severity === "blocker");
  if (blockers.length > 0) {
    return awaitHuman(
      input,
      `${blockers.length} blocker finding(s)`,
      `Phase 0: ${blockers.length} blocker finding(s). Use /loop-approve to proceed or fix the spec.`,
      "Phase 0 — review pending (blockers)",
    );
  }

  // Row 5: clean review, auto-approve on → advance to Phase A.
  autoApproveToPhaseA(input, lang);
  return { handled: true };
}

/**
 * The "wait for human /loop-approve" outcome: notify + status + persist.
 * One shared shape for every pending row (2, 3, 4, 4b).
 */
function awaitHuman(
  input: ReviewHandlerInput,
  reason: string,
  notifyMessage: string,
  statusText: string,
): ReviewHandlerOutput {
  const { state, pi, ctx, debug } = input;
  debug(`Phase 0 review: ${reason}, awaiting human /loop-approve`);
  ctx.ui.notify(notifyMessage, "info");
  ctx.ui.setStatus("loop", statusText);
  commit(state.current, pi, debug);
  return { handled: true };
}

/** Row 5: clean review with auto-approve → Phase A, round 1. */
function autoApproveToPhaseA(input: ReviewHandlerInput, lang: LanguageConfig): void {
  const { state, pi, ctx, debug } = input;
  debug("Phase 0 auto-approve → Phase A, round 1");
  applyPhaseAFields(state.current);

  ctx.ui.notify("Phase 0: Clean review — auto-advancing to Phase A.", "info");
  ctx.ui.setStatus("loop", "Phase A — round 1");
  commit(state.current, pi, debug);

  const workspaceRoot = getWorkspaceRoot(state.current.specPath);
  sendPrompt(
    pi,
    lang.prompts.promptTesterPhaseA(state.current.specPath, state.current.buildTool, workspaceRoot),
    state.current,
    debug,
  );
}
