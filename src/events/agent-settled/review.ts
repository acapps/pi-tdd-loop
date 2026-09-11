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
    debug("Phase 0 review: auto-approve disabled, awaiting human /loop-approve");
    ctx.ui.notify("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
    ctx.ui.setStatus("loop", "Phase 0 — review pending");
    commit(state.current, pi, debug);
    return { handled: true };
  }

  // Row 3: feedback was recorded → wait for human.
  if (state.current.lastProposal) {
    debug("Phase 0 review: feedback recorded, awaiting human /loop-approve");
    ctx.ui.notify("Phase 0: Feedback recorded. Use /loop-approve to proceed.", "info");
    ctx.ui.setStatus("loop", "Phase 0 — review pending");
    commit(state.current, pi, debug);
    return { handled: true };
  }

  // Row 4: dispute is pending → wait for human.
  const disputeStatus = state.current.dispute?.status;
  if (disputeStatus === "filed" || disputeStatus === "in-review") {
    debug("Phase 0 review: dispute pending, awaiting human /loop-approve");
    ctx.ui.notify("Phase 0: Dispute pending. Use /loop-approve to proceed.", "info");
    ctx.ui.setStatus("loop", "Phase 0 — review pending");
    commit(state.current, pi, debug);
    return { handled: true };
  }

  // Row 5: clean review, auto-approve on → advance to Phase A.
  debug("Phase 0 auto-approve → Phase A, round 1");
  state.current.phase = "A";
  state.current.round = 1;
  state.current.awaitingReview = false;
  state.current.turnsThisPhase = 1;

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
  return { handled: true };
}
