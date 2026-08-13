// --- Process Score Computation ---
// Scores the loop's efficiency (rounds, disputes, completion).
// Separate from code quality score.

import type { LoopMetrics } from "../../src/metrics";
import type { GateScenario } from "../golden/types";

// --- Types ---

export interface ProcessSubScores {
  completion: number;    // 0-40
  rounds: number;        // 0-30
  disputes: number;      // 0-15
  efficiency: number;    // 0-15
}

export interface ProcessScoreResult {
  score: number;         // 0-100
  subScores: ProcessSubScores;
  details: string[];
}

// --- Weights ---

const W_COMPLETION = 40;
const W_ROUNDS = 30;
const W_DISPUTES = 15;
const W_EFFICIENCY = 15;

// --- Phase max defaults ---

const MAX_A = 3;
const MAX_B = 5;
const MAX_C = 3;
const MAX_NEGOTIATE = 3;

// --- Public API ---

/**
 * Compute process score from LoopMetrics.
 * Measures how efficiently the loop completed (or failed).
 * @param metrics - LoopMetrics from a completed run
 * @param scenario - The scenario (for theoretical minimum gate runs)
 * @returns ProcessScoreResult with 0-100 score and sub-scores
 */
export function computeProcessScore(
  metrics: LoopMetrics,
  scenario: GateScenario,
): ProcessScoreResult {
  const completion = computeCompletionScore(metrics);
  const rounds = computeRoundsScore(metrics);
  const disputes = computeDisputesScore(metrics);
  const efficiency = computeEfficiencyScore(metrics, scenario);

  const subScores: ProcessSubScores = {
    completion,
    rounds,
    disputes,
    efficiency,
  };

  const score = Math.round(completion + rounds + disputes + efficiency);

  const details = buildDetails(metrics, subScores);

  return { score, subScores, details };
}

// --- Completion (0-40) ---
// 40 = completed (done), 0 = escalated

function computeCompletionScore(metrics: LoopMetrics): number {
  if (metrics.finalPhase === "done") return 40;
  return 0;
}

// --- Rounds (0-30) ---
// Fewer rounds = better. Score = 30 × (1 - roundsUsed/maxRounds) averaged across phases.

function computeRoundsScore(metrics: LoopMetrics): number {
  const phaseScores: number[] = [];

  const roundA = metrics.roundsByPhase["A"] || 0;
  if (roundA > 0) {
    phaseScores.push(Math.max(0, 30 * (1 - roundA / MAX_A)));
  }

  const roundNeg = metrics.roundsByPhase["negotiate"] || 0;
  if (roundNeg > 0) {
    phaseScores.push(Math.max(0, 30 * (1 - roundNeg / MAX_NEGOTIATE)));
  }

  const roundB = metrics.roundsByPhase["B"] || 0;
  if (roundB > 0) {
    phaseScores.push(Math.max(0, 30 * (1 - roundB / MAX_B)));
  }

  const roundC = metrics.roundsByPhase["C"] || 0;
  if (roundC > 0) {
    phaseScores.push(Math.max(0, 30 * (1 - roundC / MAX_C)));
  }

  if (phaseScores.length === 0) return 30; // No phases = no penalty
  return Math.round(phaseScores.reduce((a, b) => a + b, 0) / phaseScores.length);
}

// --- Disputes (0-15) ---
// 0 disputes = 15 points. Each dispute costs 5 points.

function computeDisputesScore(metrics: LoopMetrics): number {
  const raised = metrics.disputesRaised;
  if (raised === 0) return 15;
  return Math.max(0, 15 - raised * 5);
}

// --- Efficiency (0-15) ---
// Fewer gate runs vs theoretical minimum = better.

function computeEfficiencyScore(metrics: LoopMetrics, scenario: GateScenario): number {
  const theoreticalMin = computeTheoreticalMinGates(scenario);
  const actual = metrics.gateRuns;

  if (theoreticalMin === 0) return 15;
  if (actual <= theoreticalMin) return 15;

  const extra = actual - theoreticalMin;
  const ratio = extra / theoreticalMin;
  return Math.max(0, Math.round(15 * (1 - ratio)));
}

function computeTheoreticalMinGates(scenario: GateScenario): number {
  let gates = 0;
  gates += scenario.phaseA.length;
  gates += scenario.phaseB.length;
  if (scenario.expectedPhase !== "escalated") {
    gates += scenario.phaseC.length;
  }
  return gates;
}

// --- Details ---

function buildDetails(metrics: LoopMetrics, subScores: ProcessSubScores): string[] {
  return [
    `Completion: ${subScores.completion}/40 — ${metrics.finalPhase === "done" ? "completed" : "escalated"}`,
    `Rounds: ${subScores.rounds}/30 — A=${metrics.roundsByPhase["A"]}, B=${metrics.roundsByPhase["B"]}, C=${metrics.roundsByPhase["C"]}`,
    `Disputes: ${subScores.disputes}/15 — ${metrics.disputesRaised} raised`,
    `Efficiency: ${subScores.efficiency}/15 — ${metrics.gateRuns} gate runs`,
  ];
}

// --- Formatting ---

export function formatProcessReport(result: ProcessScoreResult): string {
  return [
    "═══ Process Score ═══",
    `Score: ${result.score}/100`,
    "",
    ...result.details,
  ].join("\n");
}



/**
 * Compute combined score from process and quality scores.
 * Default weights: process 40%, quality 60%.
 */
export function computeCombinedScore(
  processScore: number,
  qualityScore: number,
  processWeight: number = 0.4,
  qualityWeight: number = 0.6,
): number {
  return Math.round(processScore * processWeight + qualityScore * qualityWeight);
}
