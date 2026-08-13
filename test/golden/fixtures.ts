// --- Golden E2E Fixtures ---
// Mock data and helpers for golden tests.

import type { GateResult, FailingTest } from "../../src/types";
import type { LoopMetrics } from "../../src/metrics";
import type { MetricThresholds, AssertionResult, GateOutcome } from "./types";

// --- Constants ---

const ALL_PHASES = [
  "idle", "A", "negotiate", "B", "C", "done", "escalated",
] as const;

// --- Gate result fixtures ---

export function makeGatePass(coverage: number = 85): GateResult {
  return {
    compile: true, compileError: "", tests: true,
    coverage, failures: [], allPassed: true,
  };
}

export function makeGateCompileFail(
  error: string = "syntax error: expected '}', found 'EOF'",
): GateResult {
  return {
    compile: false, compileError: error, tests: false,
    coverage: 0, failures: [], allPassed: false,
  };
}

export function makeGateTestFail(
  failures: FailingTest[] = [
    { test: "TestReverse", subtest: "", output: 'Expected "olleh", got "hello"' },
  ],
  coverage: number = 60,
): GateResult {
  return {
    compile: true, compileError: "", tests: false,
    coverage, failures, allPassed: false,
  };
}

export function makeGateCoverageFail(
  coverage: number = 45,
  threshold: number = 80,
): GateResult {
  return {
    compile: true, compileError: "", tests: true,
    coverage, failures: [], allPassed: coverage >= threshold,
  };
}

// --- Phase record builder ---

function emptyPhaseRecord(): Record<string, number> {
  const record: Record<string, number> = {};
  for (const p of ALL_PHASES) record[p] = 0;
  return record;
}

// --- Default metrics ---

function defaultMetrics(): Omit<LoopMetrics, "roundsByPhase" | "turnsByPhase"> {
  const now = new Date().toISOString();
  return {
    ts: now,
    specPath: "test/golden/golden-project/spec.md",
    language: "go",
    startTime: now,
    finalPhase: "done",
    finalCoverage: 85,
    gateRuns: 0,
    compileFails: 0,
    testFails: 0,
    totalFailures: 0,
    disputesRaised: 0,
    disputesConceded: 0,
    disputesDefended: 0,
    filesWritten: 0,
    filesBlocked: 0,
    failureDetails: [],
    finalized: false,
  };
}

// --- Metrics fixture ---

export function makeMetrics(overrides: Partial<LoopMetrics> = {}): LoopMetrics {
  return {
    ...defaultMetrics(),
    roundsByPhase: emptyPhaseRecord(),
    turnsByPhase: emptyPhaseRecord(),
    ...overrides,
  };
}

// --- Threshold fixtures ---

export const thresholdsHappyPath: MetricThresholds = {
  finalPhase: "done",
  gateRuns: { max: 4 },
  compileFails: { max: 0 },
  testFails: { max: 0 },
  disputesRaised: { max: 0 },
  roundsByPhase: { A: { max: 2 }, B: { max: 3 }, C: { max: 2 } },
};

export const thresholdsBRetry: MetricThresholds = {
  finalPhase: "done",
  gateRuns: { max: 6 },
  compileFails: { max: 0 },
  testFails: { max: 2 },
  roundsByPhase: { B: { max: 4 } },
};

export const thresholdsEscalation: MetricThresholds = {
  finalPhase: "escalated",
  gateRuns: { max: 6 },
  compileFails: { max: 0 },
  testFails: { max: 5 },
};

export const thresholdsDispute: MetricThresholds = {
  finalPhase: "done",
  gateRuns: { max: 6 },
  disputesRaised: { min: 1 },
};

// --- Gate sequence helper ---

const DISPUTE_FAILURE: FailingTest = {
  test: "TestPalindrom", subtest: "", output: "Writer disputes: spec is wrong",
};

export function makeGateSequence(outcomes: GateOutcome[]): GateResult[] {
  return outcomes.map(buildGateFromOutcome);
}

function buildGateFromOutcome(outcome: GateOutcome): GateResult {
  switch (outcome) {
    case "pass": return makeGatePass();
    case "fail": return makeGateTestFail();
    case "dispute": return makeGateTestFail([DISPUTE_FAILURE]);
    default: return makeGatePass();
  }
}

// --- Assertion helpers ---

export function checkThreshold(
  actual: number,
  threshold?: { min?: number; max?: number; exact?: number },
): { pass: boolean; message: string } {
  if (!threshold) return { pass: true, message: "no threshold" };
  const exactResult = checkExact(actual, threshold.exact);
  if (exactResult) return exactResult;
  const maxResult = checkMax(actual, threshold.max);
  if (maxResult && !maxResult.pass) return maxResult;
  const minResult = checkMin(actual, threshold.min);
  if (minResult && !minResult.pass) return minResult;
  return { pass: true, message: "ok" };
}

function checkExact(
  actual: number, expected: number | undefined,
): { pass: boolean; message: string } | undefined {
  if (expected === undefined) return undefined;
  if (actual === expected) return { pass: true, message: "ok" };
  return { pass: false, message: `expected ${expected}, got ${actual}` };
}

function checkMax(
  actual: number, max: number | undefined,
): { pass: boolean; message: string } | undefined {
  if (max === undefined) return undefined;
  if (actual <= max) return { pass: true, message: "ok" };
  return { pass: false, message: `expected <= ${max}, got ${actual}` };
}

function checkMin(
  actual: number, min: number | undefined,
): { pass: boolean; message: string } | undefined {
  if (min === undefined) return undefined;
  if (actual >= min) return { pass: true, message: "ok" };
  return { pass: false, message: `expected >= ${min}, got ${actual}` };
}

export function makeAssertionResult(
  passed: boolean,
  failures: { metric: string; actual: string; expected: string }[] = [],
): AssertionResult {
  return { passed, failures };
}
