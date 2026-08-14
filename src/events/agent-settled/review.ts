// --- review handler (Phase 0) ---
// Await human approve before advancing.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";

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
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  return { handled: false };
}
