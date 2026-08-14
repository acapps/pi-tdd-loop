// --- Metrics ---
// Collects metrics during a loop run for scoring and comparison.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LoopState, GateResult, FailingTest, Phase, LanguageKey } from "./types";

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

// --- Errors ---

export const ErrNoMetrics = "No metrics collected";
export const ErrNoRuns = "No runs found";
export const ErrInvalidLabel = "Label must be non-empty";
export const ErrInvalidDirectory = "Directory does not exist or is not accessible";

// --- Public API ---

const ALL_PHASES = ["idle", "A", "negotiate", "B", "C", "done", "escalated"];

function emptyPhaseRecord(): Record<string, number> {
  const record: Record<string, number> = {};
  for (const p of ALL_PHASES) record[p] = 0;
  return record;
}

export function createMetrics(state: LoopState): LoopMetrics {
  const now = new Date().toISOString();
  return {
    specPath: state.specPath,
    language: state.language,
    ts: now,
    startTime: now,
    gateRuns: 0,
    compileFails: 0,
    testFails: 0,
    totalFailures: 0,
    finalCoverage: 0,
    roundsByPhase: emptyPhaseRecord(),
    turnsByPhase: emptyPhaseRecord(),
    finalPhase: state.phase,
    disputesRaised: 0,
    disputesConceded: 0,
    disputesDefended: 0,
    filesWritten: 0,
    filesBlocked: 0,
    failureDetails: [],
    finalized: false,
  };
}

export function accumulateGate(metrics: LoopMetrics, gate: GateResult): void {
  metrics.gateRuns++;

  if (!gate.compile) metrics.compileFails++;
  if (!gate.tests) {
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

// --- Format Metrics ---

export function formatMetrics(metrics: LoopMetrics): string {
  const lines = [
    "═══ Loop Metrics ═══",
    `Spec: ${metrics.specPath}`,
    `Language: ${metrics.language}`,
    `Duration: ${metrics.durationMs ? `${metrics.durationMs}ms` : 'N/A'}`,
    "",
    `gate runs: ${metrics.gateRuns}`,
    `  compile fails: ${metrics.compileFails}`,
    `  test fails: ${metrics.testFails}`,
    `  total failures: ${metrics.totalFailures}`,
    `  coverage: ${metrics.finalCoverage}%`,
    "",
    `Phases:`,
  ];

  for (const [phase, rounds] of Object.entries(metrics.roundsByPhase)) {
    lines.push(`  ${phase}: ${rounds} round(s), ${metrics.turnsByPhase[phase] || 0} turn(s)`);
  }

  lines.push("");
  lines.push(`Final phase: ${metrics.finalPhase}`);
  lines.push(`Disputes: ${metrics.disputesRaised} raised, ${metrics.disputesConceded} conceded, ${metrics.disputesDefended} defended`);
  lines.push(`Files: ${metrics.filesWritten} written, ${metrics.filesBlocked} blocked`);

  return lines.join("\n");
}

// --- Scoreboard ---

const DEFAULT_SCOREBOARD_DIR = "scoreboard";

// Label validation: only alphanumeric, hyphens, underscores, dots
const VALID_LABEL_RE = /^[a-zA-Z0-9._-]+$/;

export function saveMetrics(
  dir: string,
  metrics: LoopMetrics,
  label: string,
): void {
  if (!label || !VALID_LABEL_RE.test(label)) throw new Error(ErrInvalidLabel);

  const entry = {
    label,
    ts: metrics.endTime || metrics.ts,
    filePath: join(dir, `${label}.json`),
    metrics,
  };

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const file = join(dir, `${label}.json`);
  writeFileSync(file, JSON.stringify(entry, null, 2), "utf-8");
}

export function loadScoreboard(dir: string = DEFAULT_SCOREBOARD_DIR): ScoreboardEntry[] {
  if (!existsSync(dir)) throw new Error(ErrNoRuns);
  const entries: ScoreboardEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".json")) {
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        entries.push(JSON.parse(content));
      } catch { /* skip invalid files */ }
    }
  }
  
  return entries;
}

export function listRuns(dir: string = DEFAULT_SCOREBOARD_DIR, limit?: number): string[] {
  try {
    const entries = loadScoreboard(dir);
    const labels = entries.map(e => e.label);
    return limit ? labels.slice(0, limit) : labels;
  } catch (err: any) {
    // If directory doesn't exist or has no runs, return empty array
    if (err.message === ErrNoRuns) return [];
    throw err;
  }
}

// --- Comparison ---

interface MetricDiff {
  metric: string;
  a: number;
  b: number;
  diff: number;
  improved: boolean;
  changePercent: number;
}

export interface ComparisonResult {
  diffs: MetricDiff[];
}

export function compareRuns(
  a: ScoreboardEntry,
  b: ScoreboardEntry,
): ComparisonResult {
  const ma = a.metrics;
  const mb = b.metrics;

  const fields: { key: keyof LoopMetrics; label: string; lowerIsBetter: boolean }[] = [
    { key: "gateRuns", label: "Gate runs", lowerIsBetter: true },
    { key: "compileFails", label: "Compile fails", lowerIsBetter: true },
    { key: "testFails", label: "Test fails", lowerIsBetter: true },
    { key: "totalFailures", label: "Total failures", lowerIsBetter: true },
    { key: "finalCoverage", label: "Coverage", lowerIsBetter: false },
    { key: "disputesRaised", label: "Disputes", lowerIsBetter: true },
    { key: "filesWritten", label: "Files written", lowerIsBetter: false },
  ];

  const diffs: MetricDiff[] = [];
  for (const { key, label, lowerIsBetter } of fields) {
    const valA = ma[key] as number;
    const valB = mb[key] as number;
    const diff = valB - valA;
    const improved = lowerIsBetter ? diff < 0 : diff > 0;
    const changePercent = valA !== 0 ? (diff / valA) * 100 : (diff !== 0 ? 100 : 0);
    if (diff !== 0) {
      diffs.push({ metric: label, a: valA, b: valB, diff, improved, changePercent });
    }
  }
  return { diffs };
}

export function formatComparison(a: ScoreboardEntry, b: ScoreboardEntry): string {
  const comp = compareRuns(a, b);
  const lines = [
    "═══ Run Comparison ═══",
    `${a.label} vs ${b.label}`,
    "",
  ];

  for (const d of comp.diffs) {
    const arrow = d.improved ? "✓" : "✗";
    lines.push(`  ${d.metric.padEnd(16)} ${d.a.toString().padStart(4)} → ${d.b.toString().padStart(4)} (${d.diff > 0 ? "+" : ""}${d.diff}) ${arrow}`);
  }

  return lines.join("\n");
}
