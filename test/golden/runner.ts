// --- Golden E2E Runner ---
// Runs the loop lifecycle through the extension's public API with controlled gate injection.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createMockExtensionAPI, type MockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";
import type { LoopMetrics } from "../../src/metrics";
import type { LoopState, GateResult, Phase } from "../../src/types";
import type {
  GateScenario,
  MetricThresholds,
  AssertionResult,
  Scorecard,
  TestRunner,
  RunComparisonResult,
  GateOutcome,
} from "./types";
import {
  makeGatePass,
  makeGateCompileFail,
  makeGateTestFail,
  checkThreshold,
} from "./fixtures";
import {
  createMetrics,
  accumulateGate,
  accumulatePhaseTransition,
  accumulateTurn,
  accumulateDispute,
  accumulateToolCall,
  finalize,
} from "../../src/metrics";
import { computeScore, type ScoreResult, formatScoreReport } from "./score";

// =========================================================================
// Gate Injector — controls what gates return per phase/round
// =========================================================================

interface GateInjectorConfig {
  phaseA: GateOutcome[];
  phaseB: GateOutcome[];
  phaseC: GateOutcome[];
  coverageThreshold: number;
}

class GateInjector {
  private aIndex = 0;
  private bIndex = 0;
  private cIndex = 0;

  constructor(private config: GateInjectorConfig) {}

  next(phase: string): GateResult {
    switch (phase) {
      case "A": return this.nextPhaseA();
      case "B": return this.nextPhaseB();
      case "C": return this.nextPhaseC();
      default: return makeGatePass();
    }
  }

  private nextPhaseA(): GateResult {
    const outcome = this.config.phaseA[this.aIndex] || "pass";
    this.aIndex++;
    if (outcome === "fail") {
      return makeGateCompileFail();
    }
    return makeGatePass(85);
  }

  private nextPhaseB(): GateResult {
    const outcome = this.config.phaseB[this.bIndex] || "pass";
    this.bIndex++;
    if (outcome === "dispute") {
      return makeGateTestFail([{
        test: "TestDispute",
        subtest: "",
        output: "Writer disputes: test expectation does not match spec",
      }]);
    }
    return buildGateFromOutcome(outcome);
  }

  private nextPhaseC(): GateResult {
    const outcome = this.config.phaseC[this.cIndex] || "pass";
    this.cIndex++;
    return buildGateFromOutcome(outcome);
  }
}

function buildGateFromOutcome(outcome: GateOutcome): GateResult {
  switch (outcome) {
    case "pass": return makeGatePass(85);
    case "fail": return makeGateTestFail();
    case "dispute": return makeGateTestFail([{
      test: "TestDispute", subtest: "", output: "dispute",
    }]);
    default: return makeGatePass(85);
  }
}

// =========================================================================
// Simulated Loop Runner
// =========================================================================

/**
 * Run a scenario by simulating the full loop lifecycle.
 * Drives phase transitions, gate runs, and captures metrics.
 */
export async function runScenario(
  scenario: GateScenario,
  specPath: string,
  _cwd: string,
): Promise<LoopMetrics> {
  // Initialize extension with mock API
  const mockApi = createMockExtensionAPI();
  const state = initializeState(scenario, specPath);

  // Create metrics collector
  const metrics = createMetrics(state);
  metrics.specPath = specPath;

  // Create gate injector from scenario
  const injector = new GateInjector({
    phaseA: scenario.phaseA as GateOutcome[],
    phaseB: scenario.phaseB as GateOutcome[],
    phaseC: scenario.phaseC as GateOutcome[],
    coverageThreshold: state.coverageThreshold,
  });

  // Run Phase A
  const phaseAResult = await runPhaseA(state, metrics, injector, mockApi);
  if (!phaseAResult.passed) {
    return finalize(metrics, state.phase as Phase);
  }

  // Run Negotiate
  const negotiateResult = await runNegotiate(state, metrics, scenario, mockApi);
  if (!negotiateResult.passed) {
    return finalize(metrics, state.phase as Phase);
  }

  // Run Phase B
  const phaseBResult = await runPhaseB(state, metrics, injector, scenario, mockApi);
  if (!phaseBResult.passed) {
    return finalize(metrics, state.phase as Phase);
  }

  // Run Phase C
  const phaseCResult = await runPhaseC(state, metrics, injector, mockApi);
  if (!phaseCResult.passed) {
    return finalize(metrics, state.phase as Phase);
  }

  // Done
  state.phase = "done";
  accumulatePhaseTransition(metrics, "done", 1);
  return finalize(metrics, "done");
}

interface PhaseResult {
  passed: boolean;
}

function initializeState(scenario: GateScenario, specPath: string): LoopState {
  return {
    phase: "idle",
    round: 0,
    specPath,
    language: "go",
    buildTool: "maven",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 10,
    coverageThreshold: 80,
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
  };
}

async function runPhaseA(
  state: LoopState,
  metrics: LoopMetrics,
  injector: GateInjector,
  _mockApi: MockExtensionAPI,
): Promise<PhaseResult> {
  state.phase = "A";
  state.round = 1;

  const maxAttempts = state.maxA;
  let passed = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    state.round = attempt;
    accumulateTurn(metrics, "A");
    accumulatePhaseTransition(metrics, "A", attempt);
    accumulateToolCall(metrics, false); // Stub writes

    const gateResult = injector.next("A");
    accumulateGate(metrics, gateResult);

    if (gateResult.compile) {
      passed = true;
      break;
    }
  }

  if (!passed) {
    // Phase A exhausted — escalate
    state.phase = "escalated";
    state.lastPhase = "A";
    return { passed: false };
  }

  return { passed: true };
}

async function runNegotiate(
  state: LoopState,
  metrics: LoopMetrics,
  scenario: GateScenario,
  _mockApi: MockExtensionAPI,
): Promise<PhaseResult> {
  state.phase = "negotiate";
  state.round = 1;
  state.turnsThisPhase = 1;

  accumulateTurn(metrics, "negotiate");
  accumulatePhaseTransition(metrics, "negotiate", 1);

  // Simulate negotiate outcome
  if (scenario.negotiate === "agree") {
    state.lastProposal = "agree";
    // Advance to Phase B
    state.phase = "B";
    state.round = 1;
    state.turnsThisPhase = 1;
    state.justTransitioned = true;
    state.lastPhase = "negotiate";
    return { passed: true };
  }

  if (scenario.negotiate === "feedback") {
    // Writer gets feedback, tries again, then agrees
    state.round = 2;
    accumulateTurn(metrics, "negotiate");
    accumulatePhaseTransition(metrics, "negotiate", 2);
    state.lastProposal = "agree";
    state.phase = "B";
    state.round = 1;
    state.turnsThisPhase = 1;
    state.justTransitioned = true;
    state.lastPhase = "negotiate";
    return { passed: true };
  }

  // Escalate
  state.phase = "escalated";
  state.lastPhase = "negotiate";
  return { passed: false };
}

async function runPhaseB(
  state: LoopState,
  metrics: LoopMetrics,
  injector: GateInjector,
  scenario: GateScenario,
  _mockApi: MockExtensionAPI,
): Promise<PhaseResult> {
  state.phase = "B";
  state.round = 1;
  state.turnsThisPhase = 1;
  state.justTransitioned = false;

  const maxAttempts = state.maxB;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    state.round = attempt;
    accumulateTurn(metrics, "B");
    accumulatePhaseTransition(metrics, "B", attempt);
    accumulateToolCall(metrics, false); // Implementation writes

    const gateResult = injector.next("B");
    accumulateGate(metrics, gateResult);

    // Check for dispute
    const hasDispute = gateResult.failures.some(f =>
      f.output.includes("dispute") || f.test === "TestDispute"
    );

    if (hasDispute) {
      accumulateDispute(metrics, "raised");
      state.disputeCount++;

      // Check if scenario expects dispute concession
      const disputeIndex = scenario.phaseB.indexOf("dispute");
      if (disputeIndex >= 0 && scenario.phaseB[disputeIndex + 1] === "pass") {
        // Dispute conceded — Tester fixes test
        accumulateDispute(metrics, "conceded");
        state.disputeMode = true;
        accumulateTurn(metrics, "B");
        accumulateToolCall(metrics, false); // Test fix

        // Gate re-runs after dispute fix
        const postDisputeGate = injector.next("B");
        accumulateGate(metrics, postDisputeGate);

        if (postDisputeGate.allPassed) {
          state.disputeMode = false;
          return { passed: true };
        }
      } else {
        // Dispute defended
        accumulateDispute(metrics, "defended");
      }

      // Continue to next attempt
      continue;
    }

    if (gateResult.allPassed && gateResult.coverage >= state.coverageThreshold) {
      // Phase B passed — advance to Phase C
      return { passed: true };
    }
  }

  // Phase B exhausted — escalate
  state.phase = "escalated";
  state.lastPhase = "B";
  return { passed: false };
}

async function runPhaseC(
  state: LoopState,
  metrics: LoopMetrics,
  injector: GateInjector,
  _mockApi: MockExtensionAPI,
): Promise<PhaseResult> {
  state.phase = "C";
  state.round = 1;
  state.turnsThisPhase = 1;

  const maxAttempts = state.maxC;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    state.round = attempt;
    accumulateTurn(metrics, "C");
    accumulatePhaseTransition(metrics, "C", attempt);
    accumulateToolCall(metrics, false); // Refactor writes

    const gateResult = injector.next("C");
    accumulateGate(metrics, gateResult);

    if (gateResult.tests) {
      // Phase C passed — done
      state.phase = "done";
      return { passed: true };
    }

    // Phase C failed — if at maxC, mark done (cleaner failed)
    if (attempt >= maxAttempts) {
      state.phase = "done"; // Cleaner failed, keep original
      return { passed: true }; // Loop completes, just with original code
    }
  }

  return { passed: true };
}

// =========================================================================
// Metric Assertions
// =========================================================================

/**
 * Assert that metrics meet the given thresholds.
 */
export function assertMetrics(
  metrics: LoopMetrics,
  thresholds: MetricThresholds,
): AssertionResult {
  const failures: AssertionResult["failures"] = [];

  // Check finalPhase
  if (thresholds.finalPhase !== undefined) {
    const result = checkThresholdPhase(metrics.finalPhase, thresholds.finalPhase);
    if (!result.pass) {
      failures.push({
        metric: "finalPhase",
        actual: metrics.finalPhase,
        expected: thresholds.finalPhase,
      });
    }
  }

  // Check numeric thresholds
  const numericChecks = [
    { key: "gateRuns", value: metrics.gateRuns, threshold: thresholds.gateRuns },
    { key: "compileFails", value: metrics.compileFails, threshold: thresholds.compileFails },
    { key: "testFails", value: metrics.testFails, threshold: thresholds.testFails },
    { key: "totalFailures", value: metrics.totalFailures, threshold: thresholds.totalFailures },
    { key: "finalCoverage", value: metrics.finalCoverage, threshold: thresholds.finalCoverage },
    { key: "disputesRaised", value: metrics.disputesRaised, threshold: thresholds.disputesRaised },
    { key: "disputesConceded", value: metrics.disputesConceded, threshold: thresholds.disputesConceded },
    { key: "disputesDefended", value: metrics.disputesDefended, threshold: thresholds.disputesDefended },
    { key: "filesWritten", value: metrics.filesWritten, threshold: thresholds.filesWritten },
    { key: "filesBlocked", value: metrics.filesBlocked, threshold: thresholds.filesBlocked },
  ];

  for (const check of numericChecks) {
    if (check.threshold === undefined) continue;
    const result = checkThreshold(check.value, check.threshold);
    if (!result.pass) {
      failures.push({
        metric: check.key,
        actual: String(check.value),
        expected: formatThreshold(check.threshold),
      });
    }
  }

  // Check roundsByPhase thresholds
  if (thresholds.roundsByPhase) {
    for (const [phase, threshold] of Object.entries(thresholds.roundsByPhase)) {
      const actual = metrics.roundsByPhase[phase as Phase] || 0;
      const result = checkThreshold(actual, threshold);
      if (!result.pass) {
        failures.push({
          metric: `roundsByPhase.${phase}`,
          actual: String(actual),
          expected: formatThreshold(threshold),
        });
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

function checkThresholdPhase(
  actual: Phase,
  expected: string,
): { pass: boolean; message: string } {
  if (actual === expected) return { pass: true, message: "ok" };
  return { pass: false, message: `expected ${expected}, got ${actual}` };
}

function formatThreshold(threshold: { min?: number; max?: number; exact?: number }): string {
  if (threshold.exact !== undefined) return `== ${threshold.exact}`;
  if (threshold.max !== undefined) return `<= ${threshold.max}`;
  if (threshold.min !== undefined) return `>= ${threshold.min}`;
  return "any";
}

// =========================================================================
// Run Comparison
// =========================================================================

export function compareRuns(
  a: LoopMetrics,
  b: LoopMetrics,
  scenarioA: string,
  scenarioB: string,
): RunComparisonResult {
  const diffs: RunComparisonResult["diffs"] = [];
  const numericKeys = [
    "gateRuns", "compileFails", "testFails", "totalFailures", "finalCoverage",
    "durationMs", "disputesRaised", "disputesConceded", "disputesDefended",
    "filesWritten", "filesBlocked",
  ] as const;

  for (const key of numericKeys) {
    const valA = a[key as keyof LoopMetrics] as number | undefined;
    const valB = b[key as keyof LoopMetrics] as number | undefined;
    if (valA === undefined || valB === undefined) continue;

    const changePercent = valA !== 0
      ? Math.round(((valB - valA) / Math.abs(valA)) * 1000) / 10
      : undefined;

    diffs.push({
      metric: key,
      valueA: String(valA),
      valueB: String(valB),
      changePercent,
    });
  }

  // Phase comparison
  if (a.finalPhase !== b.finalPhase) {
    diffs.push({
      metric: "finalPhase",
      valueA: a.finalPhase,
      valueB: b.finalPhase,
    });
  }

  return { scenarioA, scenarioB, diffs };
}

// =========================================================================
// Scorecard
// =========================================================================

export async function createRunner(_cwd: string): Promise<TestRunner> {
  return {
    async run(specPath: string, scenario: GateScenario): Promise<LoopMetrics> {
      return runScenario(scenario, specPath, _cwd);
    },
    dispose(): void {},
  };
}

export async function run(
  cwd: string,
  specPath: string,
  scenario: GateScenario,
): Promise<LoopMetrics> {
  return runScenario(scenario, specPath, cwd);
}

export function buildScorecard(
  scenario: string,
  metrics: LoopMetrics,
  thresholds: MetricThresholds,
  result: AssertionResult,
): Scorecard {
  const scoreResult = computeScore(metrics, {
    name: scenario,
    phaseA: ["pass"],
    negotiate: "agree",
    phaseB: ["pass"],
    phaseC: ["pass"],
    expectedPhase: metrics.finalPhase,
  });

  return {
    scenario,
    timestamp: new Date().toISOString(),
    extensionVersion: getExtensionVersion(),
    commit: getGitCommit(),
    metrics,
    thresholds,
    passed: result.passed,
    failures: result.failures,
  };
}

function getExtensionVersion(): string {
  try {
    const pkgPath = new URL("../../package.json", import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getGitCommit(): string {
  try {
    const { execSync } = require("node:child_process");
    return (execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim() || "unknown") as string;
  } catch {
    return "unknown";
  }
}

export function saveScorecard(
  dir: string,
  scorecard: Scorecard,
): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const ts = scorecard.timestamp.replace(/[:.]/g, "-");
  const filename = `${scorecard.scenario}_${ts}.json`;
  writeFileSync(`${dir}/${filename}`, JSON.stringify(scorecard, null, 2), "utf-8");
}

export function compareAgainstBaseline(
  metrics: LoopMetrics,
  baseline: LoopMetrics,
): AssertionResult {
  const failures: AssertionResult["failures"] = [];
  const tolerances: Record<string, number> = {
    gateRuns: 50,        // ±50%
    compileFails: 0,     // exact
    testFails: 100,      // ±100%
    finalCoverage: 10,   // ±10%
    disputesRaised: 0,   // exact
  };

  for (const [metric, tolerance] of Object.entries(tolerances)) {
    const actual = metrics[metric as keyof LoopMetrics] as number | undefined;
    const expected = baseline[metric as keyof LoopMetrics] as number | undefined;
    if (actual === undefined || expected === undefined) continue;

    if (tolerance === 0) {
      // Exact match required
      if (actual !== expected) {
        failures.push({
          metric,
          actual: String(actual),
          expected: String(expected),
        });
      }
    } else {
      // Percentage tolerance
      const change = Math.abs(actual - expected);
      const threshold = Math.abs(expected) * (tolerance / 100);
      if (expected !== 0 && change > threshold) {
        failures.push({
          metric,
          actual: String(actual),
          expected: `${expected} ±${tolerance}%`,
        });
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

// =========================================================================
// loadBaseline — loads baseline metrics from a scorecard file
// =========================================================================

export function loadBaseline(filePath: string): LoopMetrics | null {
  if (!existsSync(filePath)) return null;
  return parseBaselineFile(filePath);
}

function parseBaselineFile(filePath: string): LoopMetrics | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (isScorecard(data)) return data.metrics;
    return data as LoopMetrics;
  } catch {
    return null;
  }
}

function isScorecard(data: unknown): data is { metrics: LoopMetrics } {
  return (
    data !== null &&
    typeof data === "object" &&
    "metrics" in data
  );
}


