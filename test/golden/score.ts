// --- Score Computation for Loop Golden Tests ---
// Computes composite quality scores from LoopMetrics.

import type { LoopMetrics } from "../../src/metrics";
import type { GateScenario } from "./types";

// --- Types ---

export interface SubScores {
  convergence: number;
  enforcement: number;
  dispute: number;
  coverage: number;
  efficiency: number;
}

export interface ScoreResult {
  score: number;
  subScores: SubScores;
  details: ScoreDetail[];
}

export interface ScoreDetail {
  category: string;
  metric: string;
  value: string;
  note: string;
}

// --- Weights ---

const WEIGHT_CONVERGENCE = 0.40;
const WEIGHT_ENFORCEMENT = 0.20;
const WEIGHT_DISPUTE = 0.15;
const WEIGHT_COVERAGE = 0.15;
const WEIGHT_EFFICIENCY = 0.10;

// --- Phase max defaults (from LoopState limits) ---

const DEFAULT_MAX_A = 3;
const DEFAULT_MAX_NEGOTIATE = 3;
const DEFAULT_MAX_B = 5;
const DEFAULT_MAX_C = 3;

// --- Public API ---

/**
 * Compute the composite quality score for a run.
 * @param metrics - The LoopMetrics from a completed run
 * @param scenario - The scenario that was run (for theoretical minimums)
 * @param coverageThreshold - The coverage threshold used (default 80)
 * @returns ScoreResult with composite score, sub-scores, and details
 */
export function computeScore(
  metrics: LoopMetrics,
  scenario: GateScenario,
  coverageThreshold: number = 80,
): ScoreResult {
  const convergence = computeConvergenceScore(metrics);
  const enforcement = computeEnforcementScore(metrics);
  const dispute = computeDisputeScore(metrics, scenario);
  const coverage = computeCoverageScore(metrics, coverageThreshold);
  const efficiency = computeEfficiencyScore(metrics, scenario);

  const subScores: SubScores = {
    convergence,
    enforcement,
    dispute,
    coverage,
    efficiency,
  };

  const composite = round(
    convergence * WEIGHT_CONVERGENCE +
    enforcement * WEIGHT_ENFORCEMENT +
    dispute * WEIGHT_DISPUTE +
    coverage * WEIGHT_COVERAGE +
    efficiency * WEIGHT_EFFICIENCY,
  );

  const details = buildDetails(metrics, subScores, scenario);

  return { score: composite, subScores, details };
}

// --- Convergence Score (weight: 40%) ---
// Measures how many rounds each phase used relative to its max.
// Fewer rounds = better convergence.

function computeConvergenceScore(metrics: LoopMetrics): number {
  const phaseScores: number[] = [];
  const details: string[] = [];

  // Phase A
  const roundA = metrics.roundsByPhase["A"] || 0;
  if (roundA > 0) {
    const score = clamp(100 * (1 - roundA / DEFAULT_MAX_A), 0, 100);
    phaseScores.push(score);
    details.push(`A: ${roundA}/${DEFAULT_MAX_A} rounds → ${round(score)}`);
  }

  // Negotiate
  const roundNeg = metrics.roundsByPhase["negotiate"] || 0;
  if (roundNeg > 0) {
    const score = clamp(100 * (1 - roundNeg / DEFAULT_MAX_NEGOTIATE), 0, 100);
    phaseScores.push(score);
    details.push(`negotiate: ${roundNeg}/${DEFAULT_MAX_NEGOTIATE} rounds → ${round(score)}`);
  }

  // Phase B
  const roundB = metrics.roundsByPhase["B"] || 0;
  if (roundB > 0) {
    const score = clamp(100 * (1 - roundB / DEFAULT_MAX_B), 0, 100);
    phaseScores.push(score);
    details.push(`B: ${roundB}/${DEFAULT_MAX_B} rounds → ${round(score)}`);
  }

  // Phase C
  const roundC = metrics.roundsByPhase["C"] || 0;
  if (roundC > 0) {
    const score = clamp(100 * (1 - roundC / DEFAULT_MAX_C), 0, 100);
    phaseScores.push(score);
    details.push(`C: ${roundC}/${DEFAULT_MAX_C} rounds → ${round(score)}`);
  }

  if (phaseScores.length === 0) {
    return 100; // No phases run = no penalty
  }

  const average = phaseScores.reduce((a, b) => a + b, 0) / phaseScores.length;
  return round(average);
}

// --- Enforcement Score (weight: 20%) ---
// Measures how well the extension enforced file write rules.
// Based on filesBlocked vs filesWritten ratio.

function computeEnforcementScore(metrics: LoopMetrics): number {
  const total = metrics.filesWritten + metrics.filesBlocked;
  if (total === 0) {
    return 100; // No writes attempted = no enforcement issues
  }

  // filesBlocked represents correct enforcement attempts.
  // We don't have false positive/negative tracking in simulation yet,
  // so we use a heuristic: if filesBlocked > 0 and filesWritten > 0,
  // enforcement is working (some things were allowed, some blocked).
  // Perfect enforcement = appropriate blocks with zero false positives.
  // For simulation, we assume blocks are correct unless proven otherwise.
  const blockRatio = metrics.filesBlocked / total;

  // Penalize if nothing was blocked (enforcement not active)
  // or if everything was blocked (over-enforcement)
  if (metrics.filesBlocked === 0 && metrics.filesWritten > 0) {
    return 80; // No blocks needed or enforcement not triggered
  }
  if (metrics.filesWritten === 0 && metrics.filesBlocked > 0) {
    return 50; // Over-blocking — enforcement too aggressive
  }

  // Balanced: some writes allowed, some blocked = enforcement working
  return 100;
}

// --- Dispute Score (weight: 15%) ---
// Measures dispute handling quality.

function computeDisputeScore(metrics: LoopMetrics, scenario: GateScenario): number {
  const raised = metrics.disputesRaised;
  const conceded = metrics.disputesConceded;
  const defended = metrics.disputesDefended;

  if (raised === 0) {
    return 100; // No disputes = ideal
  }

  // If disputes were raised and all defended (test was correct)
  if (conceded === 0 && defended === raised) {
    return 80; // Disputes happened but tests were correct
  }

  // If disputes were conceded (test was wrong, needed fixing)
  if (conceded > 0 && defended === 0) {
    return 50; // Disputes exposed test quality issues
  }

  // Mixed
  if (conceded > 0 && defended > 0) {
    const defendedRatio = defended / raised;
    return round(50 + defendedRatio * 30); // 50-80 range
  }

  // Escalated disputes
  if (metrics.finalPhase === "escalated" && raised > 0) {
    return 0;
  }

  return 60; // Unknown state
}

// --- Coverage Score (weight: 15%) ---
// Measures final coverage relative to threshold.

function computeCoverageScore(metrics: LoopMetrics, threshold: number): number {
  if (threshold === 0) return 100; // No threshold set
  const ratio = Math.min(metrics.finalCoverage / threshold, 1.0);
  return round(ratio * 100);
}

// --- Efficiency Score (weight: 10%) ---
// Measures gate run efficiency vs theoretical minimum.

function computeEfficiencyScore(metrics: LoopMetrics, scenario: GateScenario): number {
  const theoreticalMin = computeTheoreticalMinGates(scenario);
  const actual = metrics.gateRuns;

  if (theoreticalMin === 0) return 100;
  if (actual <= theoreticalMin) return 100;

  const extra = actual - theoreticalMin;
  const score = clamp(100 * (1 - extra / theoreticalMin), 0, 100);
  return round(score);
}

/**
 * Compute the theoretical minimum number of gate runs for a scenario.
 * Each phase gate that passes counts as 1. Each fail+retry counts as additional.
 */
function computeTheoreticalMinGates(scenario: GateScenario): number {
  let gates = 0;

  // Phase A: compile gates
  gates += scenario.phaseA.length;

  // Phase B: test gates
  gates += scenario.phaseB.length;

  // Phase C: test gates (if not escalated)
  if (scenario.expectedPhase !== "escalated") {
    gates += scenario.phaseC.length;
  }

  return gates;
}

// --- Detail Builder ---

function buildDetails(
  metrics: LoopMetrics,
  subScores: SubScores,
  scenario: GateScenario,
): ScoreDetail[] {
  const details: ScoreDetail[] = [];

  // Convergence details
  for (const phase of ["A", "negotiate", "B", "C"]) {
    const rounds = metrics.roundsByPhase[phase as keyof typeof metrics.roundsByPhase] || 0;
    if (rounds > 0) {
      const max = getPhaseMax(phase);
      details.push({
        category: "convergence",
        metric: `rounds_${phase}`,
        value: `${rounds}/${max}`,
        note: `Phase ${phase} used ${rounds} of ${max} max rounds`,
      });
    }
  }

  // Dispute details
  details.push({
    category: "dispute",
    metric: "disputes_raised",
    value: String(metrics.disputesRaised),
    note: `${metrics.disputesRaised} raised, ${metrics.disputesConceded} conceded, ${metrics.disputesDefended} defended`,
  });

  // Coverage details
  details.push({
    category: "coverage",
    metric: "final_coverage",
    value: `${metrics.finalCoverage.toFixed(1)}%`,
    note: `Final coverage: ${metrics.finalCoverage}%`,
  });

  // Efficiency details
  const theoretical = computeTheoreticalMinGates(scenario);
  details.push({
    category: "efficiency",
    metric: "gate_runs",
    value: `${metrics.gateRuns}/${theoretical}`,
    note: `${metrics.gateRuns} actual vs ${theoretical} theoretical min gate runs`,
  });

  // Enforcement details
  details.push({
    category: "enforcement",
    metric: "files_blocked",
    value: `${metrics.filesBlocked}/${metrics.filesWritten + metrics.filesBlocked}`,
    note: `${metrics.filesBlocked} blocked, ${metrics.filesWritten} written`,
  });

  return details;
}

function getPhaseMax(phase: string): number {
  switch (phase) {
    case "A": return DEFAULT_MAX_A;
    case "negotiate": return DEFAULT_MAX_NEGOTIATE;
    case "B": return DEFAULT_MAX_B;
    case "C": return DEFAULT_MAX_C;
    default: return 1;
  }
}

// --- Formatting ---

/**
 * Format a ScoreResult as a readable report.
 */
export function formatScoreReport(result: ScoreResult, scenario: string): string {
  const lines = [
    `═══ Scorecard: ${scenario} ═══`,
    `Overall Score: ${result.score}/100`,
    "",
    `Sub-scores:`,
    `  Convergence: ${result.subScores.convergence}/100 (weight 40%)`,
    `  Enforcement: ${result.subScores.enforcement}/100 (weight 20%)`,
    `  Dispute:     ${result.subScores.dispute}/100 (weight 15%)`,
    `  Coverage:    ${result.subScores.coverage}/100 (weight 15%)`,
    `  Efficiency:  ${result.subScores.efficiency}/100 (weight 10%)`,
    "",
    `Details:`,
    ...result.details.map((d) => `  [${d.category}] ${d.metric}: ${d.value} — ${d.note}`),
  ];
  return lines.join("\n");
}

/**
 * Compare two ScoreResults and highlight differences.
 */
export function compareScores(
  a: ScoreResult,
  b: ScoreResult,
  labelA: string,
  labelB: string,
): string {
  const diff = b.score - a.score;
  const lines = [
    `═══ Score Comparison: ${labelA} vs ${labelB} ═══`,
    `${labelA}: ${a.score}/100`,
    `${labelB}: ${b.score}/100`,
    `Change: ${diff > 0 ? "+" : ""}${diff}`,
    "",
    `Sub-score changes:`,
  ];

  const categories = ["convergence", "enforcement", "dispute", "coverage", "efficiency"];
  for (const cat of categories) {
    const key = cat as keyof SubScores;
    const valA = a.subScores[key];
    const valB = b.subScores[key];
    const change = valB - valA;
    const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";
    lines.push(`  ${cat.padEnd(14)} ${valA} → ${valB} (${change > 0 ? "+" : ""}${change}) ${arrow}`);
  }

  return lines.join("\n");
}

// --- Helpers ---

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
