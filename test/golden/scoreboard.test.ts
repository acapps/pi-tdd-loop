// --- Scoreboard Regression Tests ---
// Runs all scenarios, computes scores, and asserts thresholds.

import { describe, it, expect, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  runScenario,
  assertMetrics,
  compareRuns,
  buildScorecard,
  saveScorecard,
  compareAgainstBaseline,
  loadBaseline,
} from "./runner";
import { computeScore, formatScoreReport, compareScores } from "./score";
import { scenarios } from "./scenarios";
import {
  makeMetrics,
  thresholdsHappyPath,
  thresholdsBRetry,
  thresholdsEscalation,
  thresholdsDispute,
} from "./fixtures";
import type { MetricThresholds } from "./types";

const GOLDEN_SPEC_PATH = join(__dirname, "golden-project", "spec.md");
const GOLDEN_CWD = join(__dirname, "golden-project");
const RESULTS_DIR = join(__dirname, "results");
const BASELINE_PATH = join(__dirname, "expected", "metrics-baseline.json");

// Minimum acceptable scores per scenario
const MIN_SCORES: Record<string, number> = {
  "happy-path": 80,
  "b-retry": 60,
  "dispute-conceded": 40,
  "escalation": 0,     // Escalation is expected, score reflects that
  "phase-c-fail": 30,
  "a-retry": 50,
  "a-escalation": 0,
  "c-exhaustion": 20,
  "negotiate-feedback": 60,
};

// =========================================================================
// Scoreboard — Run all scenarios and compute scores
// =========================================================================

describe("scoreboard — scenario scores", () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`scenario "${name}" produces valid metrics and score >= ${MIN_SCORES[name] || 0}`, async () => {
      // Run the scenario
      const metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);

      // Compute score
      const scoreResult = computeScore(metrics, scenario);

      // Log the report
      console.log(formatScoreReport(scoreResult, name));

      // Assert minimum score
      expect(scoreResult.score).toBeGreaterThanOrEqual(MIN_SCORES[name] || 0);

      // Assert metrics structure
      expect(metrics.finalPhase).toBeDefined();
      expect(metrics.gateRuns).toBeGreaterThanOrEqual(0);
      expect(metrics.roundsByPhase).toBeDefined();

      // Assert scenario-specific expectations
      expect(metrics.finalPhase).toBe(scenario.expectedPhase);
    });
  }
});

// =========================================================================
// Scoreboard — Happy Path (detailed)
// =========================================================================

describe("scoreboard — happy path (detailed)", () => {
  let metrics: any;
  let scoreResult: any;

  beforeEach(async () => {
    const scenario = scenarios["happy-path"];
    metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    scoreResult = computeScore(metrics, scenario);
  });

  it("completes all phases", () => {
    expect(metrics.finalPhase).toBe("done");
  });

  it("has 0 compile failures", () => {
    expect(metrics.compileFails).toBe(0);
  });

  it("has 0 test failures", () => {
    expect(metrics.testFails).toBe(0);
  });

  it("has gateRuns >= 3 (A compile + B test + C test)", () => {
    expect(metrics.gateRuns).toBeGreaterThanOrEqual(3);
  });

  it("has 0 disputes", () => {
    expect(metrics.disputesRaised).toBe(0);
  });

  it("has high convergence score", () => {
    expect(scoreResult.subScores.convergence).toBeGreaterThanOrEqual(70);
  });

  it("passes threshold assertions", () => {
    const result = assertMetrics(metrics, thresholdsHappyPath);
    if (!result.passed) {
      console.log("Threshold failures:", JSON.stringify(result.failures, null, 2));
    }
    expect(result.passed).toBe(true);
  });
});

// =========================================================================
// Scoreboard — B Retry
// =========================================================================

describe("scoreboard — B retry", () => {
  let metrics: any;

  beforeEach(async () => {
    const scenario = scenarios["b-retry"];
    metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);
  });

  it("completes with finalPhase 'done'", () => {
    expect(metrics.finalPhase).toBe("done");
  });

  it("has roundsByPhase.B >= 2", () => {
    expect(metrics.roundsByPhase["B"]).toBeGreaterThanOrEqual(2);
  });

  it("has testFails >= 1", () => {
    expect(metrics.testFails).toBeGreaterThanOrEqual(1);
  });

  it("passes threshold assertions", () => {
    const result = assertMetrics(metrics, thresholdsBRetry);
    if (!result.passed) {
      console.log("Threshold failures:", JSON.stringify(result.failures, null, 2));
    }
    expect(result.passed).toBe(true);
  });
});

// =========================================================================
// Scoreboard — Escalation
// =========================================================================

describe("scoreboard — escalation", () => {
  let metrics: any;

  beforeEach(async () => {
    const scenario = scenarios["escalation"];
    metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);
  });

  it("escalates after maxB failures", () => {
    expect(metrics.finalPhase).toBe("escalated");
  });

  it("has 5 test failures in Phase B", () => {
    expect(metrics.testFails).toBeGreaterThanOrEqual(5);
  });

  it("has roundsByPhase.B = 5", () => {
    expect(metrics.roundsByPhase["B"]).toBe(5);
  });

  it("passes threshold assertions", () => {
    const result = assertMetrics(metrics, thresholdsEscalation);
    if (!result.passed) {
      console.log("Threshold failures:", JSON.stringify(result.failures, null, 2));
    }
    expect(result.passed).toBe(true);
  });
});

// =========================================================================
// Scoreboard — Dispute Conceded
// =========================================================================

describe("scoreboard — dispute conceded", () => {
  let metrics: any;

  beforeEach(async () => {
    const scenario = scenarios["dispute-conceded"];
    metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);
  });

  it("completes with finalPhase 'done'", () => {
    expect(metrics.finalPhase).toBe("done");
  });

  it("has at least 1 dispute raised", () => {
    expect(metrics.disputesRaised).toBeGreaterThanOrEqual(1);
  });

  it("has at least 1 dispute conceded", () => {
    expect(metrics.disputesConceded).toBeGreaterThanOrEqual(1);
  });

  it("passes threshold assertions", () => {
    const result = assertMetrics(metrics, thresholdsDispute);
    if (!result.passed) {
      console.log("Threshold failures:", JSON.stringify(result.failures, null, 2));
    }
    expect(result.passed).toBe(true);
  });
});

// =========================================================================
// Score Comparison — Prompt A vs Prompt B simulation
// =========================================================================

describe("score comparison", () => {
  it("can compare two runs and produce diffs", async () => {
    const scenario1 = scenarios["happy-path"];
    const scenario2 = scenarios["b-retry"];

    const metrics1 = await runScenario(scenario1, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    const metrics2 = await runScenario(scenario2, GOLDEN_SPEC_PATH, GOLDEN_CWD);

    const comparison = compareRuns(metrics1, metrics2, "happy-path", "b-retry");

    expect(comparison.diffs.length).toBeGreaterThan(0);
    expect(comparison.scenarioA).toBe("happy-path");
    expect(comparison.scenarioB).toBe("b-retry");
  });

  it("score comparison shows happy-path better than b-retry", async () => {
    const scenario1 = scenarios["happy-path"];
    const scenario2 = scenarios["b-retry"];

    const metrics1 = await runScenario(scenario1, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    const metrics2 = await runScenario(scenario2, GOLDEN_SPEC_PATH, GOLDEN_CWD);

    const score1 = computeScore(metrics1, scenario1);
    const score2 = computeScore(metrics2, scenario2);

    expect(score1.score).toBeGreaterThan(score2.score);

    const report = compareScores(score1, score2, "happy-path", "b-retry");
    console.log(report);
  });
});

// =========================================================================
// Scorecard save/load
// =========================================================================

describe("scorecard persistence", () => {
  const tmpDir = join(RESULTS_DIR, "test-" + Date.now());

  it("builds and saves a scorecard", async () => {
    const scenario = scenarios["happy-path"];
    const metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    const result = assertMetrics(metrics, thresholdsHappyPath);
    const scorecard = buildScorecard("happy-path", metrics, thresholdsHappyPath, result);

    saveScorecard(tmpDir, scorecard);

    // Verify file exists
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/happy-path_/);
    expect(files[0]).toMatch(/\.json$/);

    // Verify content
    const content = JSON.parse(fs.readFileSync(join(tmpDir, files[0]), "utf-8"));
    expect(content.scenario).toBe("happy-path");
    expect(content.metrics).toBeDefined();
    expect(content.thresholds).toBeDefined();
    expect(content.passed).toBeDefined();
  });

  it("loads baseline", () => {
    const baseline = loadBaseline(BASELINE_PATH);
    if (baseline) {
      expect(baseline.gateRuns).toBeDefined();
      expect(baseline.finalPhase).toBeDefined();
    }
  });

  it("compareAgainstBaseline works", async () => {
    const scenario = scenarios["happy-path"];
    const metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    const baseline = loadBaseline(BASELINE_PATH);

    if (baseline) {
      const result = compareAgainstBaseline(metrics, baseline);
      expect(result).toBeDefined();
      expect(Array.isArray(result.failures)).toBe(true);
    }
  });
});

// =========================================================================
// Score Computation — Edge Cases
// =========================================================================

describe("score computation — edge cases", () => {
  it("handles all-zero metrics", () => {
    const metrics = makeMetrics({
      gateRuns: 0,
      compileFails: 0,
      testFails: 0,
      totalFailures: 0,
      finalCoverage: 0,
      disputesRaised: 0,
      disputesConceded: 0,
      disputesDefended: 0,
      filesWritten: 0,
      filesBlocked: 0,
    });

    const scenario = scenarios["happy-path"];
    const scoreResult = computeScore(metrics, scenario);

    expect(scoreResult.score).toBeGreaterThanOrEqual(0);
    expect(scoreResult.score).toBeLessThanOrEqual(100);
  });

  it("handles high failure metrics", () => {
    const metrics = makeMetrics({
      gateRuns: 20,
      compileFails: 5,
      testFails: 10,
      totalFailures: 15,
      finalCoverage: 30,
      disputesRaised: 3,
      disputesConceded: 1,
      disputesDefended: 2,
      filesWritten: 5,
      filesBlocked: 10,
      roundsByPhase: { ...makeMetrics().roundsByPhase, B: 5, A: 3 },
    });

    const scenario = scenarios["escalation"];
    const scoreResult = computeScore(metrics, scenario);

    expect(scoreResult.score).toBeLessThan(50); // High failures = low score
  });

  it("handles perfect metrics", () => {
    const metrics = makeMetrics({
      gateRuns: 3,
      compileFails: 0,
      testFails: 0,
      totalFailures: 0,
      finalCoverage: 95,
      disputesRaised: 0,
      disputesConceded: 0,
      disputesDefended: 0,
      filesWritten: 10,
      filesBlocked: 0,
      roundsByPhase: { ...makeMetrics().roundsByPhase, A: 1, B: 1, C: 1 },
    });

    const scenario = scenarios["happy-path"];
    const scoreResult = computeScore(metrics, scenario);

    expect(scoreResult.score).toBeGreaterThan(80); // Near perfect
  });
});

// =========================================================================
// Score Report Formatting
// =========================================================================

describe("score report formatting", () => {
  it("formatScoreReport produces readable output", () => {
    const metrics = makeMetrics({
      gateRuns: 4,
      compileFails: 0,
      testFails: 1,
      finalCoverage: 85,
      disputesRaised: 0,
      roundsByPhase: { ...makeMetrics().roundsByPhase, A: 1, B: 2, C: 1 },
    });

    const scenario = scenarios["b-retry"];
    const scoreResult = computeScore(metrics, scenario);
    const report = formatScoreReport(scoreResult, "b-retry");

    expect(report).toContain("Scorecard: b-retry");
    expect(report).toContain("Overall Score");
    expect(report).toContain("Convergence");
    expect(report).toContain("Dispute");
  });

  it("compareScores produces comparison output", () => {
    const metricsA = makeMetrics({ gateRuns: 3, compileFails: 0, testFails: 0, finalCoverage: 90 });
    const metricsB = makeMetrics({ gateRuns: 5, compileFails: 1, testFails: 2, finalCoverage: 75 });

    const scenario = scenarios["happy-path"];
    const scoreA = computeScore(metricsA, scenario);
    const scoreB = computeScore(metricsB, scenario);

    const report = compareScores(scoreA, scoreB, "baseline", "after-change");

    expect(report).toContain("Score Comparison");
    expect(report).toContain("baseline");
    expect(report).toContain("after-change");
  });
});
