// Stub — the Writer replaces this with the real state persistence +
// transition helpers (internal/refactor-tools-split.md): persistState,
// logNegotiateEntry, logEscalation, applyTransitionEffect,
// transitionToPhaseB.

import type { StateRef, ToolCtx, Debug } from "./types";

export function persistState(state: StateRef, pi: unknown, debug: Debug): void {
  void state;
  void pi;
  void debug;
  throw new Error("not implemented");
}

export function transitionToPhaseB(
  state: StateRef,
  pi: unknown,
  ctx: ToolCtx,
  debug: Debug,
): void {
  void state;
  void pi;
  void ctx;
  void debug;
  throw new Error("not implemented");
}

export function logNegotiateEntry(
  state: StateRef,
  pi: unknown,
  debug: Debug,
  action: string,
  text: string,
): void {
  void state;
  void pi;
  void debug;
  void action;
  void text;
  throw new Error("not implemented");
}

export function logEscalation(
  state: StateRef,
  pi: unknown,
  ctx: ToolCtx,
  debug: Debug,
): void {
  void state;
  void pi;
  void ctx;
  void debug;
  throw new Error("not implemented");
}
