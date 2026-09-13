// --- Phase retry budgets ---
// The per-phase max-round budgets, shared by the transition engine and the
// /loop-status display so the two can never disagree.

import type { LoopState, Phase } from "./types";

export function getPhaseMax(state: LoopState, phase: Phase): number {
  switch (phase) {
    case "review": return state.maxNegotiate; // reuse maxNegotiate for review
    case "A": return state.maxA;
    case "negotiate": return state.maxNegotiate;
    case "B": return state.maxB;
    case "C": return state.maxC;
    default: return 0;
  }
}
