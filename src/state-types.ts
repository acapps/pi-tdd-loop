// State type definitions for the LoopState refactoring
// internal/done-loop-state-refactor.md — Target Architecture

import type { Phase } from "./types";
import type { LanguageKey } from "./types";
import type { BuildTool } from "./types";
import type { GateResult } from "./types";
import type { Finding } from "./types";

// --- Sub-structure interfaces ---

/** Identity — set during initialization, may be updated on continue */
export interface LoopIdentity {
  specPath: string;
  language: LanguageKey;
  buildTool: BuildTool;
  coverageThreshold: number;
}

/** Phase machine — transitions writes, events reads */
export interface PhaseMachine {
  phase: Phase;
  round: number;
  lastPhase: Phase | null;
  turnsThisPhase: number;
  maxA: number;
  maxNegotiate: number;
  maxB: number;
  maxC: number;
  maxTurnsPerPhase: number;
  // Transient — cleared on session restore
  justTransitioned: boolean;
  negotiateReprompted: boolean;
}

/** Negotiation — tools writes, events reads */
export interface NegotiationState {
  lastProposal: string;
}

/** Dispute — tools writes, events reads/writes */
export interface DisputeState {
  mode: boolean;
  count: number;
  max: number;
  awaitFix: boolean;
  awaitReview: boolean;
}

/** Gate results — events writes, selectors reads */
export interface GateState {
  lastResult?: GateResult;
}

/** Phase 0 — commands writes, events reads */
export interface PhaseZeroState {
  findings?: Finding[];
  awaitingReview: boolean;
}

// --- Refactored LoopState ---

export interface LoopState {
  identity: LoopIdentity;
  machine: PhaseMachine;
  negotiation: NegotiationState;
  dispute: DisputeState;
  gates: GateState;
  phase0: PhaseZeroState;
}

// --- Migration helper type ---

/** Container for all 6 sub-structures, used by toSubStructures/applySubStructures */
export interface LoopSubStructures {
  identity: LoopIdentity;
  machine: PhaseMachine;
  negotiation: NegotiationState;
  dispute: DisputeState;
  gates: GateState;
  phase0: PhaseZeroState;
}
