// --- review handler (Phase 0) ---
// Await human approve before advancing.
// Spec: internal/04-implement-agent-settled-handlers.md.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";

// --- Types ---

export interface ReviewHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig; // dead parameter — preserved for parity with the monolith
  debug: (msg: string) => void;
}

export interface ReviewHandlerOutput {
  handled: boolean;
}

// --- Public API ---

export function handleReviewSettled(
  input: ReviewHandlerInput,
): ReviewHandlerOutput {
  const { state, pi, ctx, debug } = input;
  if (!state.current.awaitingReview) return { handled: false };

  debug("Phase 0 review: agent settled, awaiting human /loop-approve");
  // Don't advance — wait for human to use /loop-approve or negotiate_propose
  ctx.ui.notify("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
  ctx.ui.setStatus("loop", "Phase 0 — review pending");
  pi.appendEntry("loop-state", { ...state.current });
  return { handled: true };
}
