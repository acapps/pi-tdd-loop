// Shared state helpers — internal/refactor-commands-split.md
//
// Leaf module: imports ONLY from src/types.ts. Used by the phase-a,
// phase-b, phase-c, negotiate, lifecycle, patch, and commands/* modules.

import type { LoopState, Phase } from "./types";

/**
 * Reset per-phase counters so the next phase starts fresh.
 */
export function resetPhaseState(state: LoopState): void {
  state.round = 1;
  state.disputeCount = 0;
  state.dispute = { status: "none" };
  state.negotiateReprompted = false;
  state.negotiateProposed = false;
  state.negotiateFeedback = "";
  state.justTransitioned = false;
  state.justTransitionedBySettle = false; // fix-just-transitioned-settle-drop S4: human restarts clear the pair
  state.turnsThisPhase = 1;
}

/**
 * True when the loop is not in flight (nothing to continue/stop/patch).
 */
export function isIdleOrDone(phase: Phase): boolean {
  return phase === "idle" || phase === "done";
}

/**
 * Parse a /loop-restart phase argument.
 * Throws on invalid values; the caller catches and shows usage.
 */
export function resolvePhaseArg(raw: string): Phase {
  const t = raw.trim().toLowerCase();
  if (!["review", "a", "negotiate", "b", "c", "done", "escalated", "idle"].includes(t)) {
    throw new Error(`Invalid phase: ${raw}. Use A, negotiate, B, or C.`);
  }
  return t === "negotiate" ? "negotiate" : (t.toUpperCase() as Phase);
}
