// --- Metrics ---
// Scoreboard data types for golden/e2e comparison AND live-loop completion
// reporting. The live loop accumulates metrics via a module-level instance
// (see `liveMetrics` below); the golden and e2e harnesses build their own
// from mock data.

import type { FailingTest, LanguageKey, Phase } from "./types";

// --- Types ---

export interface LoopMetrics {
  specPath: string;
  language: LanguageKey;
  ts: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;

  // Gate metrics
  gateRuns: number;
  compileFails: number;
  testFails: number;
  totalFailures: number;
  finalCoverage: number;

  // Phase metrics
  roundsByPhase: Record<string, number>;
  turnsByPhase: Record<string, number>;
  finalPhase: string;

  // Dispute metrics
  disputesRaised: number;
  disputesConceded: number;
  disputesDefended: number;

  // File metrics
  filesWritten: number;
  filesBlocked: number;

  // Failure details
  failureDetails: FailingTest[];

  // Finalized flag
  finalized: boolean;
}

export interface ScoreboardEntry {
  label: string;
  ts: string;
  filePath: string;
  metrics: LoopMetrics;
}

// --- Accumulators (golden/e2e harness) ---

const ALL_PHASES = ["idle", "A", "negotiate", "B", "C", "done", "escalated"];

function emptyPhaseRecord(): Record<string, number> {
  const record: Record<string, number> = {};
  for (const p of ALL_PHASES) record[p] = 0;
  return record;
}

interface MetricsSeed {
  specPath: string;
  language: LanguageKey;
  phase: Phase | string;
}

export function createMetrics(seed: MetricsSeed): LoopMetrics {
  const now = new Date().toISOString();
  return {
    specPath: seed.specPath,
    language: seed.language,
    ts: now,
    startTime: now,
    gateRuns: 0,
    compileFails: 0,
    testFails: 0,
    totalFailures: 0,
    finalCoverage: 0,
    roundsByPhase: emptyPhaseRecord(),
    turnsByPhase: emptyPhaseRecord(),
    finalPhase: String(seed.phase),
    disputesRaised: 0,
    disputesConceded: 0,
    disputesDefended: 0,
    filesWritten: 0,
    filesBlocked: 0,
    failureDetails: [],
    finalized: false,
  };
}

export interface GateLike {
  compile: boolean;
  allPassed: boolean;
  coverage: number;
  failures: FailingTest[];
}

export function accumulateGate(metrics: LoopMetrics, gate: GateLike): void {
  metrics.gateRuns++;

  if (!gate.compile) metrics.compileFails++;
  if (!gate.allPassed) {
    metrics.testFails++;
    metrics.totalFailures += gate.failures.length;
    metrics.failureDetails.push(...gate.failures);
  }
  if (gate.coverage > metrics.finalCoverage) metrics.finalCoverage = gate.coverage;
}

export function accumulatePhaseTransition(
  metrics: LoopMetrics,
  phase: Phase | string,
  round: number,
): void {
  const key = String(phase);
  if (!metrics.roundsByPhase[key]) metrics.roundsByPhase[key] = 0;
  if (round > metrics.roundsByPhase[key]) metrics.roundsByPhase[key] = round;
  metrics.finalPhase = key;
}

export function accumulateTurn(
  metrics: LoopMetrics,
  phase: Phase | string,
): void {
  const key = String(phase);
  if (!metrics.turnsByPhase[key]) metrics.turnsByPhase[key] = 0;
  metrics.turnsByPhase[key]++;
}

export function accumulateDispute(
  metrics: LoopMetrics,
  action: "raised" | "conceded" | "defended",
): void {
  switch (action) {
    case "raised": metrics.disputesRaised++; break;
    case "conceded": metrics.disputesConceded++; break;
    case "defended": metrics.disputesDefended++; break;
  }
}

export function accumulateToolCall(
  metrics: LoopMetrics,
  blocked: boolean,
): void {
  if (blocked) {
    metrics.filesBlocked++;
  } else {
    metrics.filesWritten++;
  }
}

export function finalize(metrics: LoopMetrics, phase: string): LoopMetrics {
  const endTime = new Date().toISOString();
  const result = { ...metrics, endTime, finalPhase: phase, finalized: true };
  if (metrics.startTime) {
    const start = new Date(metrics.startTime).getTime();
    const end = new Date(endTime).getTime();
    result.durationMs = end - start;
  }
  return result;
}

// --- Live-loop metrics singleton ---

let liveMetrics: LoopMetrics | null = null;

/** Reset the live-loop metrics (called at /loop start). */
export function initLiveMetrics(seed: MetricsSeed): void {
  liveMetrics = createMetrics(seed);
}

/** Get the live-loop metrics (null if the loop hasn't started). */
export function getLiveMetrics(): LoopMetrics | null {
  return liveMetrics;
}

/** Clear the live-loop metrics (called at loop end). */
export function clearLiveMetrics(): void {
  liveMetrics = null;
}

// --- Report formatting ---

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format a LoopMetrics object into a multi-line completion report.
 */
export function formatReport(m: LoopMetrics): string {
  const cleanerFailed = m.finalPhase === "done" && m.failureDetails.length > 0;
  const firstLine = cleanerFailed
    ? `Loop complete (Phase C failed — original code kept) — spec ${m.specPath}`
    : `Loop complete — spec ${m.specPath}`;

  const a = m.roundsByPhase["A"] ?? 0;
  const b = m.roundsByPhase["B"] ?? 0;
  const c = m.roundsByPhase["C"] ?? 0;

  const lines = [
    firstLine,
    `  Phases: A ${a} → B ${b} → C ${c}`,
    `  Gates: ${m.gateRuns} runs, ${m.compileFails} compile fails, ${m.testFails} test fails`,
    `  Coverage: ${m.finalCoverage}%`,
    `  Disputes: ${m.disputesRaised} raised, ${m.disputesConceded} conceded, ${m.disputesDefended} defended`,
    `  Duration: ${formatDuration(m.durationMs)}`,
  ];

  return lines.join("\n");
}
