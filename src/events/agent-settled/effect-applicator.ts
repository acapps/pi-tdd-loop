// --- effect-applicator ---
// Apply retry, advance, done, escalated effects.

import type { LoopState, GateResult } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";

// --- Types ---

export type TransitionEffectType =
  | { type: "noop" }
  | { type: "retry"; phase: string; round: number; notify?: string; level?: string; status: string; prompt?: string }
  | { type: "advance"; phase: string; notify: string; status: string; prompt?: string }
  | { type: "done"; notify: string; status: string }
  | { type: "escalated"; notify: string; status: string };

export interface EffectInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
  effect: TransitionEffectType;
  gateResult: GateResult;
}

export interface EffectResult {
  applied: boolean;
}

// --- Public API ---

export function applyEffect(input: EffectInput): EffectResult {
  const { state, pi, ctx, lang, debug, effect, gateResult } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  void effect;
  void gateResult;
  return { applied: false };
}

export function applyRetryEffect(input: EffectInput): EffectResult {
  const { state, pi, ctx, lang, debug, effect, gateResult } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  void effect;
  void gateResult;
  return { applied: false };
}

export function applyAdvanceEffect(input: EffectInput): EffectResult {
  const { state, pi, ctx, lang, debug, effect, gateResult } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  void effect;
  void gateResult;
  return { applied: false };
}

export function applyDoneEffect(input: EffectInput): EffectResult {
  const { state, pi, ctx, lang, debug, effect, gateResult } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  void effect;
  void gateResult;
  return { applied: false };
}

export function applyEscalatedEffect(input: EffectInput): EffectResult {
  const { state, pi, ctx, lang, debug, effect, gateResult } = input;
  void state;
  void pi;
  void ctx;
  void lang;
  void debug;
  void effect;
  void gateResult;
  return { applied: false };
}
