// State factory — creates initial LoopState with all sub-structures
// internal/done-loop-state-refactor.md — State factory with validation

import type { LanguageKey, BuildTool } from "./types";
import type { LoopState } from "./state-types";

/**
 * Creates a valid initial LoopState with all 6 sub-structures.
 *
 * Default values per spec:
 *   - phase: "A", round: 1, lastPhase: null, turnsThisPhase: 1
 *   - maxA: 3, maxNegotiate: 3, maxB: 5, maxC: 3, maxTurnsPerPhase: 5
 *   - coverageThreshold: 80 (when coverage not provided)
 *   - dispute.max: 3
 *   - All transient/dispute flags: false
 *   - lastProposal: "", gates: {}, phase0.awaitingReview: false
 *
 * @param specPath - Path to the spec file
 * @param language - Language key (go, java, typescript)
 * @param buildTool - Build tool (maven, gradle, go)
 * @param coverage - Optional coverage threshold (defaults to 80)
 */
export function createInitialState(
  specPath: string,
  language: LanguageKey,
  buildTool: BuildTool,
  coverage?: number,
): LoopState {
  return {
    identity: {
      specPath,
      language,
      buildTool,
      coverageThreshold: coverage ?? 80,
    },
    machine: {
      phase: "A",
      round: 1,
      lastPhase: null,
      turnsThisPhase: 1,
      maxA: 3,
      maxNegotiate: 3,
      maxB: 5,
      maxC: 3,
      maxTurnsPerPhase: 5,
      justTransitioned: false,
      negotiateReprompted: false,
    },
    negotiation: {
      lastProposal: "",
    },
    dispute: {
      mode: false,
      count: 0,
      max: 3,
      awaitFix: false,
      awaitReview: false,
    },
    gates: {},
    phase0: {
      awaitingReview: false,
    },
  };
}
