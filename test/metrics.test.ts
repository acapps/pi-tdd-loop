// --- Tests for src/metrics.ts: formatReport, initLiveMetrics, getLiveMetrics ---

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMetrics,
  accumulateGate,
  accumulatePhaseTransition,
  accumulateTurn,
  accumulateDispute,
  finalize,
  formatReport,
  initLiveMetrics,
  getLiveMetrics,
  clearLiveMetrics,
  type LoopMetrics,
} from "../src/metrics";

function makeMetrics(overrides = {}): LoopMetrics {
  return {
    specPath: "internal/test-spec.md",
    language: "go",
    ts: "2026-01-01T00:00:00.000Z",
    startTime: "2026-01-01T00:00:00.000Z",
    gateRuns: 0,
    compileFails: 0,
    testFails: 0,
    totalFailures: 0,
    finalCoverage: 0,
    roundsByPhase: { idle: 0, A: 0, negotiate: 0, B: 0, C: 0, done: 0, escalated: 0 },
    turnsByPhase: { idle: 0, A: 0, negotiate: 0, B: 0, C: 0, done: 0, escalated: 0 },
    finalPhase: "done",
    disputesRaised: 0,
    disputesConceded: 0,
    disputesDefended: 0,
    filesWritten: 0,
    filesBlocked: 0,
    failureDetails: [],
    finalized: false,
    ...overrides,
  };
}

// ================================================================
// formatReport
// ================================================================

describe("formatReport", () => {
  it("formats a complete report with all fields", () => {
    const m = makeMetrics({
      gateRuns: 5,
      compileFails: 1,
      testFails: 2,
      finalCoverage: 85.5,
      roundsByPhase: { idle: 0, A: 2, negotiate: 1, B: 3, C: 1, done: 0, escalated: 0 },
      disputesRaised: 2,
      disputesConceded: 1,
      disputesDefended: 1,
      durationMs: 150000, // 2m 30s
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-01-01T00:02:30.000Z",
    });
    const report = formatReport(m);
    expect(report).toContain("Loop complete — spec internal/test-spec.md");
    expect(report).toContain("Phases: A 2 → B 3 → C 1");
    expect(report).toContain("Gates: 5 runs, 1 compile fails, 2 test fails");
    expect(report).toContain("Coverage: 85.5%");
    expect(report).toContain("Disputes: 2 raised, 1 conceded, 1 defended");
    expect(report).toContain("Duration: 2m 30s");
  });

  it("cleaner-failed variant: first line mentions Phase C", () => {
    const m = makeMetrics({
      finalPhase: "done",
      failureDetails: [{ file: "main_test.go", name: "TestX", output: "fail" }],
    });
    const report = formatReport(m);
    expect(report).toContain("Phase C failed");
    expect(report).toContain("original code kept");
  });

  it("zero coverage shows 0%", () => {
    const m = makeMetrics({ finalCoverage: 0 });
    const report = formatReport(m);
    expect(report).toContain("Coverage: 0%");
  });

  it("zero disputes shows 0 raised, 0 conceded, 0 defended", () => {
    const m = makeMetrics();
    const report = formatReport(m);
    expect(report).toContain("Disputes: 0 raised, 0 conceded, 0 defended");
  });

  it("duration 0s", () => {
    const m = makeMetrics({ durationMs: 0 });
    const report = formatReport(m);
    expect(report).toContain("Duration: 0s");
  });

  it("duration 45s", () => {
    const m = makeMetrics({ durationMs: 45000 });
    const report = formatReport(m);
    expect(report).toContain("Duration: 45s");
  });

  it("duration 2m 30s", () => {
    const m = makeMetrics({ durationMs: 150000 });
    const report = formatReport(m);
    expect(report).toContain("Duration: 2m 30s");
  });

  it("duration 1h 5m", () => {
    const m = makeMetrics({ durationMs: 3900000 }); // 65 minutes
    const report = formatReport(m);
    expect(report).toContain("Duration: 1h 5m");
  });

  it("undefined duration shows 0s", () => {
    const m = makeMetrics({ durationMs: undefined });
    const report = formatReport(m);
    expect(report).toContain("Duration: 0s");
  });

  it("report is multi-line (6 lines)", () => {
    const m = makeMetrics();
    const report = formatReport(m);
    const lines = report.split("\n");
    expect(lines.length).toBe(6);
  });
});

// ================================================================
// Live metrics singleton
// ================================================================

describe("live metrics singleton", () => {
  afterEach(() => {
    clearLiveMetrics();
  });

  it("getLiveMetrics returns null before init", () => {
    clearLiveMetrics();
    expect(getLiveMetrics()).toBeNull();
  });

  it("initLiveMetrics sets the singleton", () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "review" });
    const m = getLiveMetrics();
    expect(m).not.toBeNull();
    expect(m!.specPath).toBe("spec.md");
    expect(m!.language).toBe("go");
    expect(m!.finalized).toBe(false);
  });

  it("clearLiveMetrics resets to null", () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "review" });
    clearLiveMetrics();
    expect(getLiveMetrics()).toBeNull();
  });

  it("accumulateGate works on the live metrics", () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "A" });
    const m = getLiveMetrics()!;
    accumulateGate(m, { compile: true, allPassed: true, coverage: 80, failures: [] });
    expect(m.gateRuns).toBe(1);
    expect(m.finalCoverage).toBe(80);
  });

  it("accumulateTurn works on the live metrics", () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "A" });
    const m = getLiveMetrics()!;
    accumulateTurn(m, "A");
    accumulateTurn(m, "A");
    expect(m.turnsByPhase["A"]).toBe(2);
  });

  it("accumulateDispute works on the live metrics", () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "B" });
    const m = getLiveMetrics()!;
    accumulateDispute(m, "raised");
    accumulateDispute(m, "conceded");
    expect(m.disputesRaised).toBe(1);
    expect(m.disputesConceded).toBe(1);
  });

  it("accumulatePhaseTransition works on the live metrics", () => {
    initLiveMetrics({ specPath: "spec.md", language: "go", phase: "A" });
    const m = getLiveMetrics()!;
    accumulatePhaseTransition(m, "B", 3);
    expect(m.roundsByPhase["B"]).toBe(3);
    expect(m.finalPhase).toBe("B");
  });
});

// ================================================================
// Existing accumulator functions (regression)
// ================================================================

describe("accumulators (regression)", () => {
  it("createMetrics returns zeroed metrics", () => {
    const m = createMetrics({ specPath: "s.md", language: "java", phase: "idle" });
    expect(m.gateRuns).toBe(0);
    expect(m.compileFails).toBe(0);
    expect(m.testFails).toBe(0);
    expect(m.finalCoverage).toBe(0);
    expect(m.disputesRaised).toBe(0);
    expect(m.finalized).toBe(false);
  });

  it("accumulateGate increments compileFails on compile failure", () => {
    const m = createMetrics({ specPath: "s.md", language: "go", phase: "A" });
    accumulateGate(m, { compile: false, allPassed: false, coverage: 0, failures: [] });
    expect(m.compileFails).toBe(1);
    expect(m.testFails).toBe(1);
  });

  it("accumulateGate tracks max coverage", () => {
    const m = createMetrics({ specPath: "s.md", language: "go", phase: "A" });
    accumulateGate(m, { compile: true, allPassed: true, coverage: 70, failures: [] });
    accumulateGate(m, { compile: true, allPassed: true, coverage: 85, failures: [] });
    accumulateGate(m, { compile: true, allPassed: true, coverage: 60, failures: [] });
    expect(m.finalCoverage).toBe(85);
  });

  it("finalize sets endTime, finalPhase, finalized, durationMs", () => {
    const m = createMetrics({ specPath: "s.md", language: "go", phase: "C" });
    const result = finalize(m, "done");
    expect(result.finalized).toBe(true);
    expect(result.finalPhase).toBe("done");
    expect(result.endTime).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
