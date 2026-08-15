// Migration helpers — dual-state consistency during refactor
// internal/done-loop-state-refactor.md — Migration Plan: Phase 1

import type { LoopState as OldLoopState } from "./types";
import type { LoopSubStructures } from "./state-types";

/**
 * Converts flat LoopState fields into sub-structures.
 *
 * Field mapping:
 *   identity: specPath, language, buildTool, coverageThreshold
 *   machine: phase, round, lastPhase, turnsThisPhase, maxA, maxNegotiate,
 *            maxB, maxC, maxTurnsPerPhase, justTransitioned, negotiateReprompted
 *   negotiation: lastProposal
 *   dispute: disputeMode → mode, disputeCount → count, maxDispute → max,
 *            awaitDisputeFix → awaitFix, awaitDisputeReview → awaitReview
 *   gates: lastGateResult → lastResult
 *   phase0: specFindings → findings, awaitingReview
 *
 * NOTE: skipPhase0 is dead code and NOT mapped.
 *
 * @param state - The flat LoopState
 * @returns All 6 sub-structures populated from flat fields
 */
export function toSubStructures(state: OldLoopState): LoopSubStructures {
  return {
    identity: {
      specPath: state.specPath,
      language: state.language,
      buildTool: state.buildTool,
      coverageThreshold: state.coverageThreshold,
    },
    machine: {
      phase: state.phase,
      round: state.round,
      lastPhase: state.lastPhase ?? null,
      turnsThisPhase: state.turnsThisPhase,
      maxA: state.maxA,
      maxNegotiate: state.maxNegotiate,
      maxB: state.maxB,
      maxC: state.maxC,
      maxTurnsPerPhase: state.maxTurnsPerPhase,
      justTransitioned: state.justTransitioned,
      negotiateReprompted: state.negotiateReprompted,
    },
    negotiation: {
      lastProposal: state.lastProposal,
    },
    dispute: {
      mode: state.disputeMode,
      count: state.disputeCount,
      max: state.maxDispute,
      awaitFix: state.awaitDisputeFix,
      awaitReview: state.awaitDisputeReview,
    },
    gates: {
      lastResult: state.lastGateResult,
    },
    phase0: {
      findings: state.specFindings,
      awaitingReview: state.awaitingReview ?? false,
    },
  };
}

/**
 * Writes sub-structures back to flat LoopState fields.
 *
 * This is called immediately after any mutation to sub-structures,
 * keeping flat fields in sync during migration. The flat fields are
 * source of truth — if a module mutates sub-structures, it must call
 * applySubStructures before returning.
 *
 * @param state - The flat LoopState to update (mutated in place)
 * @param ss - The sub-structures to write back
 */
export function applySubStructures(state: OldLoopState, ss: LoopSubStructures): void {
  // Identity
  state.specPath = ss.identity.specPath;
  state.language = ss.identity.language;
  state.buildTool = ss.identity.buildTool;
  state.coverageThreshold = ss.identity.coverageThreshold;

  // Machine
  state.phase = ss.machine.phase;
  state.round = ss.machine.round;
  state.lastPhase = ss.machine.lastPhase as OldLoopState["lastPhase"];
  state.turnsThisPhase = ss.machine.turnsThisPhase;
  state.maxA = ss.machine.maxA;
  state.maxNegotiate = ss.machine.maxNegotiate;
  state.maxB = ss.machine.maxB;
  state.maxC = ss.machine.maxC;
  state.maxTurnsPerPhase = ss.machine.maxTurnsPerPhase;
  state.justTransitioned = ss.machine.justTransitioned;
  state.negotiateReprompted = ss.machine.negotiateReprompted;

  // Negotiation
  state.lastProposal = ss.negotiation.lastProposal;

  // Dispute
  state.disputeMode = ss.dispute.mode;
  state.disputeCount = ss.dispute.count;
  state.maxDispute = ss.dispute.max;
  state.awaitDisputeFix = ss.dispute.awaitFix;
  state.awaitDisputeReview = ss.dispute.awaitReview;

  // Gates
  state.lastGateResult = ss.gates.lastResult;

  // Phase 0
  state.specFindings = ss.phase0.findings;
  state.awaitingReview = ss.phase0.awaitingReview;
}
