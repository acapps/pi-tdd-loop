// --- gate-transition handler (Phases A/B/C) ---
// Run gates, compute transition, apply effect.

import type { LoopState, GateResult } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";

// --- Types ---

export interface GateHandlerInput {
  state: LoopState;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
}

export interface GateHandlerOutput {
  state: LoopState;
  effect: TransitionEffect;
  prompt?: string;
  gateResult: GateResult;
}

export type TransitionEffect =
  | { type: "noop" }
  | { type: "retry"; phase: string; round: number; notify?: string; level?: string; status: string; prompt?: string }
  | { type: "advance"; phase: string; notify: string; status: string; prompt?: string }
  | { type: "done"; notify: string; status: string }
  | { type: "escalated"; notify: string; status: string };

// --- Public API ---

export function handleGateTransition(
  input: GateHandlerInput,
): GateHandlerOutput {
  const { state, ctx, lang, debug } = input;
  void ctx;
  void lang;
  void debug;

  return {
    state,
    effect: { type: "noop" },
    gateResult: {
      compile: false,
      compileError: "",
      tests: false,
      allPassed: false,
      coverage: 0,
      failures: [],
    },
  };
}
