// --- Golden E2E Scenario Contract Tests ---
// Every business rule, edge case, error path for the golden harness.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
import type {
  GateScenario,
  MetricThresholds,
  AssertionResult,
  MetricThreshold,
} from "./types";
import { scenarios } from "./scenarios";
import {
  makeMetrics,
  makeGatePass,
  makeGateCompileFail,
  makeGateTestFail,
  makeGateSequence,
  checkThreshold,
  makeAssertionResult,
  thresholdsHappyPath,
  thresholdsBRetry,
  thresholdsEscalation,
  thresholdsDispute,
} from "./fixtures";
import type { Phase } from "../../src/types";
import type { LoopMetrics } from "../../src/metrics";

// ================================================================
// Scenario Definitions
// ================================================================

describe("scenario definitions", () => {
  it("exports all defined scenarios", () => {
    expect(scenarios["happy-path"]).toBeDefined();
    expect(scenarios["b-retry"]).toBeDefined();
    expect(scenarios["dispute-conceded"]).toBeDefined();
    expect(scenarios["escalation"]).toBeDefined();
    expect(scenarios["phase-c-fail"]).toBeDefined();
    expect(scenarios["a-retry"]).toBeDefined();
    expect(scenarios["a-escalation"]).toBeDefined();
    expect(scenarios["c-exhaustion"]).toBeDefined();
    expect(scenarios["negotiate-feedback"]).toBeDefined();
  });

  it("happy-path: phaseA has 1 pass", () => {
    const s = scenarios["happy-path"];
    expect(s.phaseA).toEqual(["pass"]);
    expect(s.negotiate).toBe("agree");
    expect(s.phaseB).toEqual(["pass"]);
    expect(s.phaseC).toEqual(["pass"]);
    expect(s.expectedPhase).toBe("done");
  });

  it("b-retry: phaseB has fail then pass", () => {
    const s = scenarios["b-retry"];
    expect(s.phaseB).toEqual(["fail", "pass"]);
    expect(s.expectedPhase).toBe("done");
  });

  it("dispute-conceded: phaseB has dispute then pass", () => {
    const s = scenarios["dispute-conceded"];
    expect(s.phaseB).toEqual(["dispute", "pass"]);
    expect(s.expectedPhase).toBe("done");
  });

  it("escalation: phaseB has 5 fails", () => {
    const s = scenarios["escalation"];
    expect(s.phaseB).toEqual(["fail", "fail", "fail", "fail", "fail"]);
    expect(s.expectedPhase).toBe("escalated");
  });

  it("phase-c-fail: phaseC has fail then pass", () => {
    const s = scenarios["phase-c-fail"];
    expect(s.phaseC).toEqual(["fail", "pass"]);
    expect(s.expectedPhase).toBe("done");
  });

  it("a-retry: phaseA has fail then pass", () => {
    const s = scenarios["a-retry"];
    expect(s.phaseA).toEqual(["fail", "pass"]);
    expect(s.expectedPhase).toBe("done");
  });

  it("a-escalation: phaseA has 3 fails (maxA=3)", () => {
    const s = scenarios["a-escalation"];
    expect(s.phaseA).toEqual(["fail", "fail", "fail"]);
    expect(s.expectedPhase).toBe("escalated");
  });

  it("c-exhaustion: phaseC has 3 fails (maxC=3, marks done)", () => {
    const s = scenarios["c-exhaustion"];
    expect(s.phaseC).toEqual(["fail", "fail", "fail"]);
    expect(s.expectedPhase).toBe("done");
  });

  it("negotiate-feedback: negotiate is 'feedback'", () => {
    const s = scenarios["negotiate-feedback"];
    expect(s.negotiate).toBe("feedback");
    expect(s.expectedPhase).toBe("done");
  });

  it("each scenario has expectedRounds defined for active phases", () => {
    for (const [, s] of Object.entries(scenarios)) {
      if (s.expectedRounds) {
        expect(typeof s.expectedRounds).toBe("object");
      }
    }
  });

  it("each scenario name is unique", () => {
    const names = Object.values(scenarios).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("scenario gate arrays are non-empty for active phases", () => {
    for (const s of Object.values(scenarios)) {
      expect(s.phaseA.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ================================================================
// runScenario — now implemented
// ================================================================

const GOLDEN_SPEC_PATH = join(__dirname, "golden-project", "spec.md");
const GOLDEN_CWD = join(__dirname, "golden-project");

describe("runScenario", () => {
  it("returns metrics for every scenario", async () => {
    for (const s of Object.values(scenarios)) {
      const metrics = await runScenario(s, GOLDEN_SPEC_PATH, GOLDEN_CWD);
      expect(metrics).toBeDefined();
      expect(metrics.finalPhase).toBeDefined();
      expect(metrics.gateRuns).toBeGreaterThanOrEqual(0);
    }
  });
});

// ================================================================
// assertMetrics — now implemented
// ================================================================

describe("assertMetrics", () => {
  it("returns passed when thresholds are met", () => {
    const metrics = makeMetrics();
    const result = assertMetrics(metrics, {});
    expect(result.passed).toBe(true);
  });

  it("returns passed with happy path thresholds", () => {
    const metrics = makeMetrics({ gateRuns: 4, compileFails: 0, testFails: 0 });
    const result = assertMetrics(metrics, thresholdsHappyPath);
    expect(result.passed).toBe(true);
  });
});

// ================================================================
// compareRuns — now implemented
// ================================================================

describe("compareRuns", () => {
  it("produces diffs between two runs", () => {
    const a = makeMetrics({ gateRuns: 4 });
    const b = makeMetrics({ gateRuns: 6 });
    const result = compareRuns(a, b, "run-a", "run-b");
    expect(result.diffs.length).toBeGreaterThan(0);
  });
});

// ================================================================
// createRunner — now implemented
// ================================================================

describe("createRunner", () => {
  it("returns a TestRunner", async () => {
    const runner = await createRunner(GOLDEN_CWD);
    expect(runner.run).toBeDefined();
    runner.dispose();
  });
});

// ================================================================
// run — now implemented
// ================================================================

describe("run", () => {
  it("returns metrics", async () => {
    const metrics = await run(GOLDEN_CWD, GOLDEN_SPEC_PATH, scenarios["happy-path"]);
    expect(metrics).toBeDefined();
  });
});

// ================================================================
// buildScorecard — now implemented
// ================================================================

describe("buildScorecard", () => {
  it("builds a scorecard", () => {
    const metrics = makeMetrics();
    const result: AssertionResult = { passed: true, failures: [] };
    const scorecard = buildScorecard("test", metrics, {}, result);
    expect(scorecard.scenario).toBe("test");
    expect(scorecard.metrics).toBeDefined();
  });
});

// ================================================================
// saveScorecard — now implemented
// ================================================================

describe("saveScorecard", () => {
  it("saves to disk without error", () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const tmpdir = fs.mkdtempSync(`${os.tmpdir()}/loop-test-`);
    try {
      const metrics = makeMetrics();
      const result: AssertionResult = { passed: true, failures: [] };
      const scorecard = buildScorecard("test", metrics, {}, result);
      saveScorecard(tmpdir, scorecard);
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
    expect(loadBaseline("nonexistent.json")).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(loadBaseline("")).toBeNull();
  });
});

// ================================================================
// compareAgainstBaseline — now implemented
// ================================================================

describe("compareAgainstBaseline", () => {
  it("returns assertion result", () => {
    const metrics = makeMetrics();
    const result = compareAgainstBaseline(metrics, metrics);
    expect(result).toBeDefined();
    expect(Array.isArray(result.failures)).toBe(true);
  });
});

// ================================================================
// Fixtures — Gate result builders
// ================================================================

describe("fixtures — makeGatePass", () => {
  it("returns allPassed gate result", () => {
    const gate = makeGatePass();
    expect(gate.compile).toBe(true);
    expect(gate.compileError).toBe("");
    expect(gate.tests).toBe(true);
    expect(gate.allPassed).toBe(true);
    expect(gate.failures.length).toBe(0);
  });

  it("returns specified coverage", () => {
    const gate = makeGatePass(92);
    expect(gate.coverage).toBe(92);
  });

  it("defaults coverage to 85", () => {
    const gate = makeGatePass();
    expect(gate.coverage).toBe(85);
  });
});

describe("fixtures — makeGateCompileFail", () => {
  it("returns compile=false gate result", () => {
    const gate = makeGateCompileFail();
    expect(gate.compile).toBe(false);
    expect(gate.tests).toBe(false);
    expect(gate.allPassed).toBe(false);
    expect(gate.coverage).toBe(0);
  });

  it("returns custom compile error", () => {
    const gate = makeGateCompileFail("undefined: foo");
    expect(gate.compileError).toBe("undefined: foo");
  });

  it("has default compile error message", () => {
    const gate = makeGateCompileFail();
    expect(gate.compileError).toContain("syntax error");
  });

  it("has no failures for compile fail", () => {
    const gate = makeGateCompileFail();
    expect(gate.failures).toEqual([]);
  });
});

describe("fixtures — makeGateTestFail", () => {
  it("returns compile=true, tests=false gate result", () => {
    const gate = makeGateTestFail();
    expect(gate.compile).toBe(true);
    expect(gate.tests).toBe(false);
    expect(gate.allPassed).toBe(false);
  });

  it("includes failure details", () => {
    const gate = makeGateTestFail();
    expect(gate.failures.length).toBeGreaterThan(0);
    expect(gate.failures[0].test).toBeDefined();
    expect(gate.failures[0].output).toBeDefined();
  });

  it("accepts custom failures", () => {
    const failures = [
      { test: "TestA", subtest: "case1", output: "expected 1 got 0" },
      { test: "TestB", subtest: "", output: "panic" },
      { test: "TestC", subtest: "edge", output: "timeout" },
    ];
    const gate = makeGateTestFail(failures);
    expect(gate.failures).toHaveLength(3);
    expect(gate.failures[0].test).toBe("TestA");
    expect(gate.failures[2].subtest).toBe("edge");
  });

  it("accepts custom coverage", () => {
    const gate = makeGateTestFail([], 45);
    expect(gate.coverage).toBe(45);
  });

  it("defaults coverage to 60", () => {
    const gate = makeGateTestFail();
    expect(gate.coverage).toBe(60);
  });
});

describe("fixtures — makeGateSequence", () => {
  it("maps 'pass' to passing gate", () => {
    const seq = makeGateSequence(["pass"]);
    expect(seq[0].allPassed).toBe(true);
  });

  it("maps 'fail' to failing gate", () => {
    const seq = makeGateSequence(["fail"]);
    expect(seq[0].tests).toBe(false);
  });

  it("maps 'dispute' to failing gate with dispute output", () => {
    const seq = makeGateSequence(["dispute"]);
    expect(seq[0].tests).toBe(false);
    expect(seq[0].failures[0].output).toContain("disputes");
  });

  it("produces correct length sequence", () => {
    const seq = makeGateSequence(["pass", "fail", "fail", "pass"]);
    expect(seq).toHaveLength(4);
  });
});

// ================================================================
// Fixtures — checkThreshold
// ================================================================

describe("fixtures — checkThreshold", () => {
  it("passes when no threshold given", () => {
    const result = checkThreshold(42);
    expect(result.pass).toBe(true);
  });

  it("passes when value equals exact", () => {
    const result = checkThreshold(5, { exact: 5 });
    expect(result.pass).toBe(true);
  });

  it("fails when value differs from exact", () => {
    const result = checkThreshold(3, { exact: 5 });
    expect(result.pass).toBe(false);
    expect(result.message).toContain("expected 5, got 3");
  });

  it("passes when value is at max", () => {
    const result = checkThreshold(4, { max: 4 });
    expect(result.pass).toBe(true);
  });

  it("passes when value is below max", () => {
    const result = checkThreshold(2, { max: 4 });
    expect(result.pass).toBe(true);
  });

  it("fails when value exceeds max", () => {
    const result = checkThreshold(6, { max: 4 });
    expect(result.pass).toBe(false);
    expect(result.message).toContain("expected <= 4, got 6");
  });

  it("passes when value is at min", () => {
    const result = checkThreshold(1, { min: 1 });
    expect(result.pass).toBe(true);
  });

  it("passes when value is above min", () => {
    const result = checkThreshold(3, { min: 1 });
    expect(result.pass).toBe(true);
  });

  it("fails when value is below min", () => {
    const result = checkThreshold(0, { min: 1 });
    expect(result.pass).toBe(false);
    expect(result.message).toContain("expected >= 1, got 0");
  });

  it("checks exact before max/min", () => {
    // exact takes precedence
    const result = checkThreshold(6, { exact: 5, max: 10 });
    expect(result.pass).toBe(false);
  });

  it("handles zero value with max 0", () => {
    const result = checkThreshold(0, { max: 0 });
    expect(result.pass).toBe(true);
  });

  it("handles zero value with min 1", () => {
    const result = checkThreshold(0, { min: 1 });
    expect(result.pass).toBe(false);
  });

  it("handles large numbers", () => {
    const result = checkThreshold(100000, { max: 100000 });
    expect(result.pass).toBe(true);
  });

  it("passes with combined min and max in range", () => {
    const result = checkThreshold(5, { min: 1, max: 10 });
    expect(result.pass).toBe(true);
  });

  it("fails with combined min and max out of range (high)", () => {
    const result = checkThreshold(15, { min: 1, max: 10 });
    expect(result.pass).toBe(false);
  });

  it("fails with combined min and max out of range (low)", () => {
    const result = checkThreshold(0, { min: 1, max: 10 });
    expect(result.pass).toBe(false);
  });
});

// ================================================================
// Fixtures — makeMetrics
// ================================================================

describe("fixtures — makeMetrics", () => {
  it("creates metrics with sensible defaults", () => {
    const m = makeMetrics();
    expect(m.finalPhase).toBe("done");
    expect(m.finalCoverage).toBe(85);
    expect(m.gateRuns).toBe(0);
    expect(m.compileFails).toBe(0);
    expect(m.testFails).toBe(0);
    expect(m.totalFailures).toBe(0);
    expect(m.disputesRaised).toBe(0);
    expect(m.disputesConceded).toBe(0);
    expect(m.disputesDefended).toBe(0);
  });

  it("initializes roundsByPhase for all phases", () => {
    const m = makeMetrics();
    const phases: Phase[] = ["idle", "A", "negotiate", "B", "C", "done", "escalated"];
    for (const phase of phases) {
      expect(m.roundsByPhase[phase]).toBeDefined();
      expect(m.roundsByPhase[phase]).toBe(0);
    }
  });

  it("initializes turnsByPhase for all phases", () => {
    const m = makeMetrics();
    const phases: Phase[] = ["idle", "A", "negotiate", "B", "C", "done", "escalated"];
    for (const phase of phases) {
      expect(m.turnsByPhase[phase]).toBeDefined();
      expect(m.turnsByPhase[phase]).toBe(0);
    }
  });

  it("accepts overrides", () => {
    const m = makeMetrics({
      finalPhase: "escalated",
      gateRuns: 10,
      compileFails: 3,
      finalCoverage: 45,
    });
    expect(m.finalPhase).toBe("escalated");
    expect(m.gateRuns).toBe(10);
    expect(m.compileFails).toBe(3);
    expect(m.finalCoverage).toBe(45);
  });

  it("sets language to 'go' by default", () => {
    const m = makeMetrics();
    expect(m.language).toBe("go");
  });

  it("sets specPath to golden project path", () => {
    const m = makeMetrics();
    expect(m.specPath).toContain("golden-project");
    expect(m.specPath).toContain("spec.md");
  });

  it("ts and startTime are ISO strings", () => {
    const m = makeMetrics();
    expect(() => new Date(m.ts)).not.toThrow();
    expect(() => new Date(m.startTime)).not.toThrow();
  });
});

// ================================================================
// Fixtures — Threshold presets
// ================================================================

describe("fixtures — threshold presets", () => {
  it("thresholdsHappyPath: finalPhase is 'done'", () => {
    expect(thresholdsHappyPath.finalPhase).toBe("done");
  });

  it("thresholdsHappyPath: gateRuns max is 4", () => {
    expect(thresholdsHappyPath.gateRuns).toEqual({ max: 4 });
  });

  it("thresholdsHappyPath: compileFails max is 0", () => {
    expect(thresholdsHappyPath.compileFails).toEqual({ max: 0 });
  });

  it("thresholdsHappyPath: testFails max is 0", () => {
    expect(thresholdsHappyPath.testFails).toEqual({ max: 0 });
  });

  it("thresholdsHappyPath: disputesRaised max is 0", () => {
    expect(thresholdsHappyPath.disputesRaised).toEqual({ max: 0 });
  });

  it("thresholdsBRetry: finalPhase is 'done'", () => {
    expect(thresholdsBRetry.finalPhase).toBe("done");
  });

  it("thresholdsBRetry: gateRuns max is 6", () => {
    expect(thresholdsBRetry.gateRuns).toEqual({ max: 6 });
  });

  it("thresholdsBRetry: testFails max is 2", () => {
    expect(thresholdsBRetry.testFails).toEqual({ max: 2 });
  });

  it("thresholdsEscalation: finalPhase is 'escalated'", () => {
    expect(thresholdsEscalation.finalPhase).toBe("escalated");
  });

  it("thresholdsEscalation: testFails max is 5", () => {
    expect(thresholdsEscalation.testFails).toEqual({ max: 5 });
  });

  it("thresholdsDispute: disputesRaised min is 1", () => {
    expect(thresholdsDispute.disputesRaised).toEqual({ min: 1 });
  });

  it("thresholdsDispute: finalPhase is 'done'", () => {
    expect(thresholdsDispute.finalPhase).toBe("done");
  });
});

// ================================================================
// Fixtures — makeAssertionResult
// ================================================================

describe("fixtures — makeAssertionResult", () => {
  it("creates passing result", () => {
    const result = makeAssertionResult(true);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("creates failing result with failures", () => {
    const result = makeAssertionResult(false, [
      { metric: "gateRuns", actual: "10", expected: "<= 4" },
      { metric: "compileFails", actual: "2", expected: "<= 0" },
    ]);
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].metric).toBe("gateRuns");
    expect(result.failures[1].actual).toBe("2");
  });
});

// ================================================================
// Golden Project Spec
// ================================================================

describe("golden project spec", () => {
  it("spec.md exists", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    expect(fs.existsSync(specPath)).toBe(true);
  });

  it("spec.md defines Reverse function", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    expect(content).toContain("Reverse(s string)");
  });

  it("spec.md defines Capitalize function", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    expect(content).toContain("Capitalize(s string)");
  });

  it("spec.md defines TrimSpace function", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    expect(content).toContain("TrimSpace(s string)");
  });

  it("spec.md defines IsPalindrome function", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    expect(content).toContain("IsPalindrome(s string)");
  });

  it("spec.md has 4 functions (3-5 constraint)", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    const funcHeaders = content.match(/## `\w+\(s string\)/g);
    expect(funcHeaders!.length).toBeGreaterThanOrEqual(3);
    expect(funcHeaders!.length).toBeLessThanOrEqual(5);
  });

  it("spec.md has no external dependencies", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    // Should not reference go get, require, import third-party
    expect(content).not.toMatch(/go get\s+\S+/);
    expect(content).not.toMatch(/require\s*\(/);
  });

  it("spec.md has clear edge cases", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    // Empty string edge case
    expect(content).toContain('"" returns ""');
    // Single character edge case
    expect(content).toContain("Single character");
  });

  it("spec.md mentions UTF-8 safety for Reverse", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    expect(content).toContain("UTF-8");
  });

  it("spec.md specifies case-insensitive for IsPalindrome", () => {
    const specPath = join(__dirname, "golden-project", "spec.md");
    const content = fs.readFileSync(specPath, "utf-8");
    expect(content).toContain("case-insensitive");
  });
});

// ================================================================
// Baseline file
// ================================================================

describe("baseline file", () => {
  it("metrics-baseline.json exists", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    expect(fs.existsSync(baselinePath)).toBe(true);
  });

  it("metrics-baseline.json is valid JSON", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    const content = fs.readFileSync(baselinePath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("metrics-baseline.json has required top-level fields", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    const data = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    expect(data.scenario).toBeDefined();
    expect(data.timestamp).toBeDefined();
    expect(data.metrics).toBeDefined();
    expect(data.thresholds).toBeDefined();
    expect(data.passed).toBeDefined();
    expect(data.failures).toBeDefined();
  });

  it("baseline scenario is 'happy-path'", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    const data = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    expect(data.scenario).toBe("happy-path");
  });

  it("baseline passed is true", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    const data = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    expect(data.passed).toBe(true);
  });

  it("baseline failures is empty array", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    const data = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    expect(data.failures).toEqual([]);
  });

  it("baseline metrics has gateRuns field", () => {
    const baselinePath = join(__dirname, "expected", "metrics-baseline.json");
    const data = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    expect(data.metrics.gateRuns).toBeDefined();
  });
});

// ================================================================
// Type contract tests
// ================================================================

describe("type contracts", () => {
  it("GateScenario name is string", () => {
    const s: GateScenario = {
      name: "test",
      phaseA: ["pass"],
      negotiate: "agree",
      phaseB: ["pass"],
      phaseC: ["pass"],
      expectedPhase: "done",
    };
    expect(typeof s.name).toBe("string");
  });

  it("GateScenario phaseA is array of pass/fail", () => {
    const s: GateScenario = {
      name: "test",
      phaseA: ["pass", "fail"],
      negotiate: "agree",
      phaseB: ["pass"],
      phaseC: ["pass"],
      expectedPhase: "done",
    };
    expect(Array.isArray(s.phaseA)).toBe(true);
  });

  it("GateScenario negotiate is agree/feedback/dispute", () => {
    const s1: GateScenario = {
      name: "test",
      phaseA: ["pass"],
      negotiate: "agree",
      phaseB: ["pass"],
      phaseC: ["pass"],
      expectedPhase: "done",
    };
    const s2: GateScenario = {
      name: "test",
      phaseA: ["pass"],
      negotiate: "feedback",
      phaseB: ["pass"],
      phaseC: ["pass"],
      expectedPhase: "done",
    };
    const s3: GateScenario = {
      name: "test",
      phaseA: ["pass"],
      negotiate: "dispute",
      phaseB: ["pass"],
      phaseC: ["pass"],
      expectedPhase: "done",
    };
    expect(s1.negotiate).toBe("agree");
    expect(s2.negotiate).toBe("feedback");
    expect(s3.negotiate).toBe("dispute");
  });

  it("MetricThreshold supports min/max/exact", () => {
    const t1: MetricThreshold = { min: 1 };
    const t2: MetricThreshold = { max: 10 };
    const t3: MetricThreshold = { exact: 5 };
    expect(t1.min).toBe(1);
    expect(t2.max).toBe(10);
    expect(t3.exact).toBe(5);
  });

  it("MetricThresholds supports finalPhase string", () => {
    const thresholds: MetricThresholds = { finalPhase: "done" };
    expect(thresholds.finalPhase).toBe("done");
  });

  it("AssertionResult has passed and failures", () => {
    const result: AssertionResult = { passed: true, failures: [] };
    expect(result.passed).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });

  it("AssertionFailure has metric, actual, expected", () => {
    const failure = {
      metric: "gateRuns",
      actual: "10",
      expected: "<= 4",
    };
    expect(failure.metric).toBe("gateRuns");
    expect(failure.actual).toBe("10");
    expect(failure.expected).toBe("<= 4");
  });
});


// ================================================================
// E2E scenario assertions — now implemented via scoreboard.test.ts
// These are the actual E2E tests that run scenarios and assert results
// ================================================================

describe("E2E — happy path assertions", () => {
  it("should complete all phases without escalation", async () => {
    const metrics = await runScenario(scenarios["happy-path"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    const result = assertMetrics(metrics, thresholdsHappyPath);
    expect(result.passed).toBe(true);
  });

  it("should have 0 compile failures", async () => {
    const metrics = await runScenario(scenarios["happy-path"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.compileFails).toBe(0);
  });

  it("should have 0 test failures", async () => {
    const metrics = await runScenario(scenarios["happy-path"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.testFails).toBe(0);
  });

  it("should have gateRuns <= 4", async () => {
    const metrics = await runScenario(scenarios["happy-path"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.gateRuns).toBeLessThanOrEqual(4);
  });

  it("should have 0 disputes", async () => {
    const metrics = await runScenario(scenarios["happy-path"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.disputesRaised).toBe(0);
  });
});

describe("E2E — B retry assertions", () => {
  it("should recover from Phase B failure", async () => {
    const metrics = await runScenario(scenarios["b-retry"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should complete with finalPhase 'done'", async () => {
    const metrics = await runScenario(scenarios["b-retry"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should have roundsByPhase.B >= 2", async () => {
    const metrics = await runScenario(scenarios["b-retry"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.roundsByPhase["B"]).toBeGreaterThanOrEqual(2);
  });

  it("should have testFails <= 2", async () => {
    const metrics = await runScenario(scenarios["b-retry"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.testFails).toBeLessThanOrEqual(2);
  });
});

describe("E2E — dispute conceded assertions", () => {
  it("should record at least 1 dispute raised", async () => {
    const metrics = await runScenario(scenarios["dispute-conceded"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.disputesRaised).toBeGreaterThanOrEqual(1);
  });

  it("should complete with finalPhase 'done'", async () => {
    const metrics = await runScenario(scenarios["dispute-conceded"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should have disputesRaised >= 1", async () => {
    const metrics = await runScenario(scenarios["dispute-conceded"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.disputesRaised).toBeGreaterThanOrEqual(1);
  });
});

describe("E2E — escalation assertions", () => {
  it("should escalate after maxB failures", async () => {
    const metrics = await runScenario(scenarios["escalation"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("escalated");
  });

  it("should have finalPhase 'escalated'", async () => {
    const metrics = await runScenario(scenarios["escalation"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("escalated");
  });

  it("should have 5 test failures in Phase B", async () => {
    const metrics = await runScenario(scenarios["escalation"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.testFails).toBeGreaterThanOrEqual(5);
  });
});

describe("E2E — Phase C refactor fail assertions", () => {
  it("should handle Phase C failure and retry", async () => {
    const metrics = await runScenario(scenarios["phase-c-fail"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should complete with finalPhase 'done'", async () => {
    const metrics = await runScenario(scenarios["phase-c-fail"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should have roundsByPhase.C >= 2", async () => {
    const metrics = await runScenario(scenarios["phase-c-fail"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.roundsByPhase["C"]).toBeGreaterThanOrEqual(2);
  });
});

describe("E2E — A retry assertions", () => {
  it("should handle Phase A compile failure and retry", async () => {
    const metrics = await runScenario(scenarios["a-retry"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should complete with finalPhase 'done'", async () => {
    const metrics = await runScenario(scenarios["a-retry"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });
});

describe("E2E — A escalation assertions", () => {
  it("should escalate after maxA compile failures", async () => {
    const metrics = await runScenario(scenarios["a-escalation"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("escalated");
  });

  it("should have finalPhase 'escalated'", async () => {
    const metrics = await runScenario(scenarios["a-escalation"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("escalated");
  });
});

describe("E2E — C exhaustion assertions", () => {
  it("should mark done after maxC failures", async () => {
    const metrics = await runScenario(scenarios["c-exhaustion"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should have finalPhase 'done' (not escalated)", async () => {
    const metrics = await runScenario(scenarios["c-exhaustion"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });
});

describe("E2E — negotiate feedback assertions", () => {
  it("should handle negotiate feedback and still proceed", async () => {
    const metrics = await runScenario(scenarios["negotiate-feedback"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.finalPhase).toBe("done");
  });

  it("should have roundsByPhase.negotiate >= 2", async () => {
    const metrics = await runScenario(scenarios["negotiate-feedback"], GOLDEN_SPEC_PATH, GOLDEN_CWD);
    expect(metrics.roundsByPhase["negotiate"]).toBeGreaterThanOrEqual(2);
  });
});
