// Transient flag clearing on session restore
// internal/done-loop-state-refactor.md — Transient flag clearing on session restore

import type { LoopState } from "./state-types";

/**
 * Clears all transient (ephemeral session) flags on a LoopState.
 *
 * Transient flags represent the *current* interaction flow, NOT persistent
 * user preferences. They are cleared on session restore so that a restored
 * session starts with a clean interaction state.
 *
 * Clears:
 *   - machine.justTransitioned
 *   - machine.negotiateReprompted
 *   - dispute.mode
 *   - dispute.awaitFix
 *   - dispute.awaitReview
 *
 * dispute.mode is cleared because it reflects the active dispute state
 * (awaiting a human response). Evidence: tools.ts:304 sets mode=true on
 * dispute invocation, transitions.ts:243 clears it on phase advance,
 * commands.ts:73 and commands.ts:333 clear it on reset/cancel.
 *
 * @param state - The LoopState to clear (mutated in place)
 */
export function clearTransientFlags(state: LoopState): void {
  state.machine.justTransitioned = false;
  state.machine.negotiateReprompted = false;
  state.dispute.mode = false;
  state.dispute.awaitFix = false;
  state.dispute.awaitReview = false;
}
