// State validation — checks invariants on LoopState sub-structures
// internal/done-loop-state-refactor.md — State validation rules

import type { LoopState } from "./state-types";

/**
 * Validates a LoopState against the 5 validation rules:
 *
 *   1. done phase ⇒ round must be 0
 *   2. done phase ⇒ turnsThisPhase must be 0
 *   3. escalated phase ⇒ lastPhase must be B or C
 *   4. non-done phase ⇒ round must be >= 1
 *   5. non-done phase ⇒ turnsThisPhase must be >= 1
 *
 * NOTE: dispute.mode + dispute.count == 0 is NOT flagged as an error.
 * The dispute flow sets mode=true first, then increments count.
 * The invariant is violated transiently between those operations.
 *
 * @param state - The LoopState to validate
 * @returns Array of error strings. Empty array means valid state.
 */
export function validateState(state: LoopState): string[] {
  const errors: string[] = [];

  // Rule 1: done phase ⇒ round must be 0
  if (state.machine.phase === "done" && state.machine.round > 0) {
    errors.push("done phase should have round 0");
  }

  // Rule 2: done phase ⇒ turnsThisPhase must be 0
  if (state.machine.phase === "done" && state.machine.turnsThisPhase > 0) {
    errors.push("done phase should have turnsThisPhase 0");
  }

  // Rule 3: escalated phase ⇒ lastPhase must be B or C
  if (state.machine.phase === "escalated" &&
      (!state.machine.lastPhase || !["B", "C"].includes(state.machine.lastPhase))) {
    errors.push("escalated phase must come from B or C");
  }

  // NOTE: dispute.mode + dispute.count == 0 is NOT flagged as an error.
  // The dispute flow sets mode=true first, then increments count.
  // The invariant is violated transiently between those operations.

  // Rule 4: non-done phase ⇒ round must be >= 1
  if (state.machine.phase !== "done" && state.machine.round < 1) {
    errors.push("non-done phase must have round >= 1");
  }

  // Rule 5: non-done phase ⇒ turnsThisPhase must be >= 1
  if (state.machine.phase !== "done" && state.machine.turnsThisPhase < 1) {
    errors.push("non-done phase must have turnsThisPhase >= 1");
  }

  return errors;
}
