// --- dispute handler ---
// Dispute fix and dispute review handling.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";

// --- Types ---

export interface DisputeHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
}

export interface DisputeHandlerOutput {
  handled: boolean;
  type?: "fix" | "review";
}

// --- Public API ---

export function handleDisputeFix(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, ctx, lang, debug } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  return { handled: false, type: "fix" };
}

export function handleDisputeReview(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, ctx, lang, debug } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  return { handled: false, type: "review" };
}
