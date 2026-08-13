// --- Golden E2E Harness Types ---

import type { Phase } from "../../src/types";
import type { LoopMetrics } from "../../src/metrics";

// --- GateScenario: describes one E2E scenario gate outcomes ---

export interface GateScenario {
  name: string;
  phaseA: ("pass" | "fail")[];
  negotiate: "agree" | "feedback" | "dispute";
  phaseB: ("pass" | "fail" | "dispute")[];
  phaseC: ("pass" | "fail")[];
  expectedPhase: Phase;
  expectedRounds?: Partial<Record<Phase, number>>;
}

// --- MetricThresholds: threshold constraints for assertions ---

export interface MetricThreshold {
  min?: number;
  max?: number;
  exact?: number;
}

export interface RoundsByPhaseThresholds {
  A?: MetricThreshold;
  negotiate?: MetricThreshold;
  B?: MetricThreshold;
  C?: MetricThreshold;
}

export interface MetricThresholds {
  finalPhase?: string;
  gateRuns?: MetricThreshold;
  compileFails?: MetricThreshold;
  testFails?: MetricThreshold;
  totalFailures?: MetricThreshold;
  finalCoverage?: MetricThreshold;
  roundsByPhase?: RoundsByPhaseThresholds;
  disputesRaised?: MetricThreshold;
  disputesConceded?: MetricThreshold;
  disputesDefended?: MetricThreshold;
  filesWritten?: MetricThreshold;
  filesBlocked?: MetricThreshold;
  durationMs?: MetricThreshold;
}

// --- Assertion result types ---

export interface AssertionFailure {
  metric: string;
  actual: string;
  expected: string;
}

export interface AssertionResult {
  passed: boolean;
  failures: AssertionFailure[];
}

// --- Scorecard: persisted E2E run result ---

export interface Scorecard {
  scenario: string;
  timestamp: string;
  extensionVersion: string;
  commit: string;
  metrics: LoopMetrics;
  thresholds: MetricThresholds;
  passed: boolean;
  failures: AssertionFailure[];
}

// --- Run comparison types ---

export interface RunComparisonResult {
  scenarioA: string;
  scenarioB: string;
  diffs: ComparisonDiff[];
}

export interface ComparisonDiff {
  metric: string;
  valueA: string;
  valueB: string;
  changePercent?: number;
  improved?: boolean;
}

// --- Tolerance bands for baseline comparison ---

export interface ToleranceConfig {
  metric: string;
  type: "exact" | "percent";
  value?: number;
}

export const DEFAULT_TOLERANCES: ToleranceConfig[] = [
  { metric: "finalPhase", type: "exact" },
  { metric: "gateRuns", type: "percent", value: 50 },
  { metric: "roundsByPhase.B", type: "percent", value: 100 },
  { metric: "compileFails", type: "exact" },
  { metric: "disputesRaised", type: "exact" },
];

// --- Runner and gate types ---

export interface TestRunner {
  run(specPath: string, scenario: GateScenario): Promise<LoopMetrics>;
  dispose(): void;
}

export type GateOutcome = "pass" | "fail" | "dispute";

export interface GateResultSequence {
  phaseA: GateOutcome[];
  negotiate: "agree" | "feedback" | "dispute";
  phaseB: GateOutcome[];
  phaseC: GateOutcome[];
}
