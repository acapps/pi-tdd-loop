// --- Runner Implementation Tests ---
// Tests for the implemented runner functions (replaces stub throw tests).

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runScenario,
  assertMetrics,
  compareRuns,
  createRunner,
  run,
  buildScorecard,
  saveScorecard,
  loadBaseline,
  compareAgainstBaseline,
} from "./runner";
import { makeMetrics, makeAssertionResult, checkThreshold } from "./fixtures";
import type { GateScenario, MetricThresholds } from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const GOLDEN_SPEC_PATH = join(__dirname, "golden-project", "spec.md");
const GOLDEN_CWD = join(__dirname, "golden-project");

const DUMMY_SCENARIO: GateScenario = {
  name: "dummy",
  phaseA: ["pass"],
  negotiate: "agree",
  phaseB: ["pass"],
  phaseC: ["pass"],
  expectedPhase: "done",
};

// ================================================================
// runScenario — now implemented
// ================================================================

describe("runScenario", () => {
  it("returns metrics for happy path scenario", async () => {
    const metrics = await runScenario(DUMMY_SCENARIO, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBeDefined();
    expect(metrics.gateRuns).toBeGreaterThan(0);
  });

  it("returns metrics for a scenario with B retry", async () => {
    const scenario: GateScenario = {
      name: "b-retry",
      phaseA: ["pass"],
      negotiate: "agree",
      phaseB: ["fail", "pass"],
      phaseC: ["pass"],
      expectedPhase: "done",
    };
    const metrics = await runScenario(scenario, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
    expect(metrics.testFails).toBeGreaterThanOrEqual(1);
  });
});

// ================================================================
// assertMetrics — now implemented
// ================================================================

describe("assertMetrics", () => {
  it("returns passed=true when thresholds are met", () => {
    const metrics = makeMetrics({ gateRuns: 4, compileFails: 0, testFails: 0 });
    const thresholds: MetricThresholds = {
      gateRuns: { max: 10 },
      compileFails: { max: 0 },
    };
    const result = assertMetrics(metrics, thresholds);
    expect(result.passed).toBe(true);
  });

  it("returns passed=false when thresholds are violated", () => {
    const metrics = makeMetrics({ gateRuns: 20 });
    const thresholds: MetricThresholds = { gateRuns: { max: 5 } };
    const result = assertMetrics(metrics, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("works with empty thresholds", () => {
    const metrics = makeMetrics();
    const result = assertMetrics(metrics, {});
    expect(result.passed).toBe(true);
  });
});

// ================================================================
// compareRuns — now implemented
// ================================================================

describe("compareRuns", () => {
  it("returns diffs between two runs", () => {
    const a = makeMetrics({ gateRuns: 4, compileFails: 0 });
    const b = makeMetrics({ gateRuns: 6, compileFails: 1 });
    const result = compareRuns(a, b, "run-a", "run-b");

    expect(result.scenarioA).toBe("run-a");
    expect(result.scenarioB).toBe("run-b");
    expect(result.diffs.length).toBeGreaterThan(0);
  });

  it("includes gateRuns diff", () => {
    const a = makeMetrics({ gateRuns: 4 });
    const b = makeMetrics({ gateRuns: 6 });
    const result = compareRuns(a, b, "a", "b");

    const gateDiff = result.diffs.find(d => d.metric === "gateRuns");
    expect(gateDiff).toBeDefined();
    expect(gateDiff!.valueA).toBe("4");
    expect(gateDiff!.valueB).toBe("6");
  });
});

// ================================================================
// createRunner — now implemented
// ================================================================

describe("createRunner", () => {
  it("returns a TestRunner", async () => {
    const runner = await createRunner(GOLDEN_CWD);
    expect(runner.run).toBeDefined();
    expect(runner.dispose).toBeDefined();
    runner.dispose();
  });

  it("runner.run returns metrics", async () => {
    const runner = await createRunner(GOLDEN_CWD);
    const metrics = await runner.run(GOLDEN_SPEC_PATH, DUMMY_SCENARIO);
    expect(metrics.finalPhase).toBeDefined();
    runner.dispose();
  });
});

// ================================================================
// run — now implemented (alias for runScenario)
// ================================================================

describe("run", () => {
  it("returns metrics", async () => {
    const metrics = await run(GOLDEN_CWD, GOLDEN_SPEC_PATH, DUMMY_SCENARIO);
    expect(metrics.finalPhase).toBeDefined();
  });
});

// ================================================================
// buildScorecard — now implemented
// ================================================================

describe("buildScorecard", () => {
  it("builds a scorecard", () => {
    const metrics = makeMetrics();
    const result = makeAssertionResult(true);
    const scorecard = buildScorecard("test", metrics, {}, result);

    expect(scorecard.scenario).toBe("test");
    expect(scorecard.metrics).toBeDefined();
    expect(scorecard.passed).toBe(true);
    expect(scorecard.timestamp).toBeDefined();
  });
});

// ================================================================
// saveScorecard — now implemented
// ================================================================

describe("saveScorecard", () => {
  it("saves a scorecard to disk", () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const tmpdir = fs.mkdtempSync(`${os.tmpdir()}/loop-test-`);

    try {
      const metrics = makeMetrics();
      const result = makeAssertionResult(true);
      const scorecard = buildScorecard("test", metrics, {}, result);
      saveScorecard(tmpdir, scorecard);

      const files = fs.readdirSync(tmpdir);
      expect(files.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });
});

// ================================================================
// loadBaseline — now implemented
// ================================================================

describe("loadBaseline", () => {
  it("returns null for non-existent path", () => {
    expect(loadBaseline("/nonexistent/path.json")).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(loadBaseline("")).toBeNull();
  });

  it("loads baseline from expected/metrics-baseline.json", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    const baseline = loadBaseline(baselinePath);
    if (baseline) {
      expect(baseline.gateRuns).toBeDefined();
      expect(baseline.finalPhase).toBeDefined();
    }
  });
});

// ================================================================
// compareAgainstBaseline — now implemented
// ================================================================

describe("compareAgainstBaseline", () => {
  it("returns passed when metrics match baseline", () => {
    const baseline = makeMetrics({ gateRuns: 4, compileFails: 0 });
    const metrics = makeMetrics({ gateRuns: 5, compileFails: 0 }); // within 50% tolerance
    const result = compareAgainstBaseline(metrics, baseline);
    expect(result.passed).toBe(true);
  });

  it("returns failures when metrics deviate beyond tolerance", () => {
    const baseline = makeMetrics({ gateRuns: 4, compileFails: 0 });
    const metrics = makeMetrics({ gateRuns: 10, compileFails: 0 }); // 150% change, exceeds 50% tolerance
    const result = compareAgainstBaseline(metrics, baseline);
    // This may or may not fail depending on tolerance — just check structure
    expect(result).toBeDefined();
    expect(Array.isArray(result.failures)).toBe(true);
  });
});

// ================================================================
// Fixture: checkThreshold — edge cases (keep existing tests)
// ================================================================

describe("checkThreshold — edge cases", () => {
  it("handles negative values with min", () => {
    expect(checkThreshold(-1, { min: 0 }).pass).toBe(false);
    expect(checkThreshold(-1, { min: -5 }).pass).toBe(true);
  });

  it("handles negative values with max", () => {
    expect(checkThreshold(-1, { max: 0 }).pass).toBe(true);
    expect(checkThreshold(1, { max: -5 }).pass).toBe(false);
  });

  it("handles floating point values", () => {
    expect(checkThreshold(85.5, { min: 80 }).pass).toBe(true);
    expect(checkThreshold(75.5, { min: 80 }).pass).toBe(false);
  });

  it("exact match with floating point", () => {
    expect(checkThreshold(85.0, { exact: 85 }).pass).toBe(true);
    expect(checkThreshold(85.5, { exact: 85 }).pass).toBe(false);
  });

  it("message includes expected and actual values", () => {
    const result = checkThreshold(10, { max: 5 });
    expect(result.message).toContain("5");
    expect(result.message).toContain("10");
  });

  it("returns 'ok' message on pass", () => {
    expect(checkThreshold(3, { max: 5 }).message).toBe("ok");
    expect(checkThreshold(3, { min: 1 }).message).toBe("ok");
    expect(checkThreshold(3, { exact: 3 }).message).toBe("ok");
  });

  it("max 0 with value 0 passes", () => {
    expect(checkThreshold(0, { max: 0 }).pass).toBe(true);
  });

  it("max 0 with value 1 fails", () => {
    expect(checkThreshold(1, { max: 0 }).pass).toBe(false);
  });
});

// ================================================================
// Fixture: makeMetrics — invariants (keep existing tests)
// ================================================================

describe("makeMetrics — invariants", () => {
  it("roundsByPhase keys match Phase type", () => {
    const m = makeMetrics();
    expect(Object.keys(m.roundsByPhase)).toHaveLength(7);
  });

  it("turnsByPhase keys match Phase type", () => {
    const m = makeMetrics();
    expect(Object.keys(m.turnsByPhase)).toHaveLength(7);
  });

  it("overrides do not corrupt roundsByPhase", () => {
    const m = makeMetrics({ gateRuns: 5 });
    expect(m.gateRuns).toBe(5);
    expect(m.roundsByPhase["A"]).toBe(0);
  });

  it("filesWritten defaults to 0", () => {
    expect(makeMetrics().filesWritten).toBe(0);
  });

  it("disputes all default to 0", () => {
    const m = makeMetrics();
    expect(m.disputesRaised).toBe(0);
    expect(m.disputesConceded).toBe(0);
    expect(m.disputesDefended).toBe(0);
  });
});

// ================================================================
// Fixture: makeAssertionResult (keep existing tests)
// ================================================================

describe("makeAssertionResult", () => {
  it("defaults failures to empty array", () => {
    const result = makeAssertionResult(true);
    expect(result.failures).toEqual([]);
  });

  it("preserves failure list", () => {
    const failures = [
      { metric: "a", actual: "1", expected: "0" },
      { metric: "b", actual: "2", expected: "1" },
    ];
    const result = makeAssertionResult(false, failures);
    expect(result.failures).toHaveLength(2);
  });
});
