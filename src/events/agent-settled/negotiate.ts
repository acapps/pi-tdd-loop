// --- negotiate handler ---
// Reprompt writer/tester or auto-advance to Phase B.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";

// --- Types ---

export interface NegotiateHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
}

export interface NegotiateHandlerOutput {
  handled: boolean;
  newState: LoopState;
}

// --- Public API ---

export function handleNegotiateSettled(
  input: NegotiateHandlerInput,
): NegotiateHandlerOutput {
  const { state, pi, ctx, lang, debug } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  return { handled: false, newState: state.current };
}
