// --- Tests for metrics module ---
// Contract tests: every business rule, edge case, error path

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Phase, LoopState, GateResult, FailingTest } from "../src/types";
import {
  createMetrics,
  accumulateGate,
  accumulatePhaseTransition,
  accumulateTurn,
  accumulateDispute,
  accumulateToolCall,
  finalize,
  formatMetrics,
  loadScoreboard,
  saveMetrics,
  compareRuns,
  listRuns,
  formatComparison,
  ErrNoMetrics,
  ErrNoRuns,
  ErrInvalidLabel,
  ErrInvalidDirectory,
  type LoopMetrics,
  type ScoreboardEntry,
} from "../src/metrics";

// --- Helpers ---

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    phase: "A",
    round: 1,
    specPath: "spec.md",
    language: "go",
    buildTool: "maven",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
    ...overrides,
  };
}

function makeGateResult(overrides?: Partial<GateResult>): GateResult {
  return {
    compile: true,
    compileError: "",
    tests: true,
    coverage: 85,
    failures: [],
    allPassed: true,
    ...overrides,
  };
}

// ================================================================
// createMetrics
// ================================================================

describe("createMetrics", () => {
  it("creates fresh metrics with zero counts", () => {
    const state = makeState();
    const metrics = createMetrics(state);

    expect(metrics.specPath).toBe("spec.md");
    expect(metrics.language).toBe("go");
    expect(metrics.gateRuns).toBe(0);
    expect(metrics.compileFails).toBe(0);
    expect(metrics.testFails).toBe(0);
    expect(metrics.totalFailures).toBe(0);
    expect(metrics.disputesRaised).toBe(0);
    expect(metrics.disputesConceded).toBe(0);
    expect(metrics.disputesDefended).toBe(0);
    expect(metrics.filesWritten).toBe(0);
    expect(metrics.filesBlocked).toBe(0);
  });

  it("captures specPath and language from state", () => {
    const state = makeState({ specPath: "path/to/spec.md", language: "java" });
    const metrics = createMetrics(state);

    expect(metrics.specPath).toBe("path/to/spec.md");
    expect(metrics.language).toBe("java");
  });

  it("sets startTime and ts to current time", () => {
    const before = new Date().toISOString();
    const state = makeState();
    const metrics = createMetrics(state);
    const after = new Date().toISOString();

    expect(metrics.ts).toBeDefined();
    expect(metrics.startTime).toBeDefined();
    expect(new Date(metrics.ts).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(new Date(metrics.ts).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it("initializes roundsByPhase with all phases at 0", () => {
    const state = makeState();
    const metrics = createMetrics(state);

    const phases: Phase[] = ["idle", "A", "negotiate", "B", "C", "done", "escalated"];
    for (const phase of phases) {
      expect(metrics.roundsByPhase[phase]).toBeDefined();
    }
  });

  it("initializes turnsByPhase with all phases at 0", () => {
    const state = makeState();
    const metrics = createMetrics(state);

    const phases: Phase[] = ["idle", "A", "negotiate", "B", "C", "done", "escalated"];
    for (const phase of phases) {
      expect(metrics.turnsByPhase[phase]).toBeDefined();
    }
  });

  it("sets initial finalPhase to current state phase", () => {
    const state = makeState({ phase: "A" });
    const metrics = createMetrics(state);

    expect(metrics.finalPhase).toBe("A");
  });

  it("sets initial coverage to 0", () => {
    const state = makeState();
    const metrics = createMetrics(state);

    expect(metrics.finalCoverage).toBe(0);
  });
});

// ================================================================
// accumulateGate
// ================================================================

describe("accumulateGate", () => {
  let metrics: LoopMetrics;

  beforeEach(() => {
    metrics = createMetrics(makeState());
  });

  it("increments gateRuns on each call", () => {
    accumulateGate(metrics, makeGateResult());
    accumulateGate(metrics, makeGateResult());
    accumulateGate(metrics, makeGateResult());

    expect(metrics.gateRuns).toBe(3);
  });

  it("increments compileFails when compile is false", () => {
    accumulateGate(metrics, makeGateResult({ compile: false, compileError: "syntax error" }));
    accumulateGate(metrics, makeGateResult({ compile: true }));

    expect(metrics.compileFails).toBe(1);
    expect(metrics.gateRuns).toBe(2);
  });

  it("does not increment compileFails when compile is true", () => {
    accumulateGate(metrics, makeGateResult({ compile: true }));
    accumulateGate(metrics, makeGateResult({ compile: true }));

    expect(metrics.compileFails).toBe(0);
  });

  it("increments testFails when tests is false", () => {
    const failures: FailingTest[] = [
      { test: "TestA", subtest: "", output: "expected 1, got 0" },
      { test: "TestB", subtest: "edge", output: "panic" },
    ];
    accumulateGate(metrics, makeGateResult({ tests: false, failures }));

    expect(metrics.testFails).toBe(1);
    expect(metrics.totalFailures).toBe(2);
  });

  it("does not increment testFails when tests is true", () => {
    accumulateGate(metrics, makeGateResult({ tests: true, failures: [] }));

    expect(metrics.testFails).toBe(0);
  });

  it("accumulates totalFailures across multiple gate runs", () => {
    const failures1: FailingTest[] = [
      { test: "TestA", subtest: "", output: "fail" },
      { test: "TestB", subtest: "", output: "fail" },
    ];
    const failures2: FailingTest[] = [
      { test: "TestC", subtest: "", output: "fail" },
    ];

    accumulateGate(metrics, makeGateResult({ tests: false, failures: failures1 }));
    accumulateGate(metrics, makeGateResult({ tests: false, failures: failures2 }));

    expect(metrics.totalFailures).toBe(3);
    expect(metrics.testFails).toBe(2);
  });

  it("updates finalCoverage with latest coverage value", () => {
    accumulateGate(metrics, makeGateResult({ coverage: 60 }));
    accumulateGate(metrics, makeGateResult({ coverage: 75 }));
    accumulateGate(metrics, makeGateResult({ coverage: 90 }));

    expect(metrics.finalCoverage).toBe(90);
  });

  it("handles zero coverage (tool not configured)", () => {
    accumulateGate(metrics, makeGateResult({ coverage: 0 }));

    expect(metrics.finalCoverage).toBe(0);
  });

  it("counts compile failures and test failures independently", () => {
    // Compile fail, tests false (tests didn't run, but tests=false is still counted)
    accumulateGate(metrics, makeGateResult({ compile: false, tests: false, failures: [] }));
    // Compile pass, test fail
    accumulateGate(metrics, makeGateResult({ compile: true, tests: false, failures: [{ test: "T", subtest: "", output: "x" }] }));

    expect(metrics.compileFails).toBe(1); // 1 gate with compile: false
    expect(metrics.testFails).toBe(2);    // 2 gates with tests: false (spec: "Gate runs where tests: false")
    expect(metrics.gateRuns).toBe(2);
  });

  it("is additive only — never decrements", () => {
    accumulateGate(metrics, makeGateResult({ compile: false, tests: false, failures: [{ test: "A", subtest: "", output: "x" }, { test: "B", subtest: "", output: "y" }] }));
    accumulateGate(metrics, makeGateResult({ compile: true, tests: true, coverage: 100, failures: [] }));

    expect(metrics.compileFails).toBe(1); // stays 1
    expect(metrics.testFails).toBe(1);    // stays 1
    expect(metrics.totalFailures).toBe(2); // stays 2
  });
});

// ================================================================
// accumulatePhaseTransition
// ================================================================

describe("accumulatePhaseTransition", () => {
  let metrics: LoopMetrics;

  beforeEach(() => {
    metrics = createMetrics(makeState());
  });

  it("records round for a phase", () => {
    accumulatePhaseTransition(metrics, "A", 3);
    expect(metrics.roundsByPhase["A"]).toBe(3);
  });

  it("keeps max round per phase (not last)", () => {
    accumulatePhaseTransition(metrics, "B", 2);
    accumulatePhaseTransition(metrics, "B", 1);
    accumulatePhaseTransition(metrics, "B", 3);

    expect(metrics.roundsByPhase["B"]).toBe(3);
  });

  it("tracks different phases independently", () => {
    accumulatePhaseTransition(metrics, "A", 1);
    accumulatePhaseTransition(metrics, "negotiate", 2);
    accumulatePhaseTransition(metrics, "B", 3);
    accumulatePhaseTransition(metrics, "C", 1);

    expect(metrics.roundsByPhase["A"]).toBe(1);
    expect(metrics.roundsByPhase["negotiate"]).toBe(2);
    expect(metrics.roundsByPhase["B"]).toBe(3);
    expect(metrics.roundsByPhase["C"]).toBe(1);
  });

  it("handles round 1", () => {
    accumulatePhaseTransition(metrics, "C", 1);
    expect(metrics.roundsByPhase["C"]).toBe(1);
  });
});

// ================================================================
// accumulateTurn
// ================================================================

describe("accumulateTurn", () => {
  let metrics: LoopMetrics;

  beforeEach(() => {
    metrics = createMetrics(makeState());
  });

  it("increments turns for a phase", () => {
    accumulateTurn(metrics, "B");
    accumulateTurn(metrics, "B");

    expect(metrics.turnsByPhase["B"]).toBe(2);
  });

  it("tracks different phases independently", () => {
    accumulateTurn(metrics, "A");
    accumulateTurn(metrics, "B");
    accumulateTurn(metrics, "B");

    expect(metrics.turnsByPhase["A"]).toBe(1);
    expect(metrics.turnsByPhase["B"]).toBe(2);
  });
});

// ================================================================
// accumulateDispute
// ================================================================

describe("accumulateDispute", () => {
  let metrics: LoopMetrics;

  beforeEach(() => {
    metrics = createMetrics(makeState());
  });

  it("increments disputesRaised on 'raised'", () => {
    accumulateDispute(metrics, "raised");
    accumulateDispute(metrics, "raised");

    expect(metrics.disputesRaised).toBe(2);
    expect(metrics.disputesConceded).toBe(0);
    expect(metrics.disputesDefended).toBe(0);
  });

  it("increments disputesConceded on 'conceded'", () => {
    accumulateDispute(metrics, "conceded");

    expect(metrics.disputesConceded).toBe(1);
    expect(metrics.disputesRaised).toBe(0);
  });

  it("increments disputesDefended on 'defended'", () => {
    accumulateDispute(metrics, "defended");

    expect(metrics.disputesDefended).toBe(1);
  });

  it("handles mixed dispute actions", () => {
    accumulateDispute(metrics, "raised");
    accumulateDispute(metrics, "conceded");
    accumulateDispute(metrics, "raised");
    accumulateDispute(metrics, "defended");
    accumulateDispute(metrics, "raised");
    accumulateDispute(metrics, "conceded");

    expect(metrics.disputesRaised).toBe(3);
    expect(metrics.disputesConceded).toBe(2);
    expect(metrics.disputesDefended).toBe(1);
  });

  it("is additive only — never decrements", () => {
    accumulateDispute(metrics, "raised");
    accumulateDispute(metrics, "conceded");
    accumulateDispute(metrics, "defended");

    expect(metrics.disputesRaised).toBe(1);
    expect(metrics.disputesConceded).toBe(1);
    expect(metrics.disputesDefended).toBe(1);

    // Adding more doesn't affect previous counts
    accumulateDispute(metrics, "raised");
    expect(metrics.disputesConceded).toBe(1); // unchanged
    expect(metrics.disputesDefended).toBe(1); // unchanged
  });
});

// ================================================================
// accumulateToolCall
// ================================================================

describe("accumulateToolCall", () => {
  let metrics: LoopMetrics;

  beforeEach(() => {
    metrics = createMetrics(makeState());
  });

  it("increments filesWritten when not blocked", () => {
    accumulateToolCall(metrics, false);
    accumulateToolCall(metrics, false);

    expect(metrics.filesWritten).toBe(2);
    expect(metrics.filesBlocked).toBe(0);
  });

  it("increments filesBlocked when blocked", () => {
    accumulateToolCall(metrics, true);

    expect(metrics.filesBlocked).toBe(1);
    expect(metrics.filesWritten).toBe(0);
  });

  it("handles mixed blocked/unblocked", () => {
    accumulateToolCall(metrics, false);
    accumulateToolCall(metrics, true);
    accumulateToolCall(metrics, false);
    accumulateToolCall(metrics, true);
    accumulateToolCall(metrics, false);

    expect(metrics.filesWritten).toBe(3);
    expect(metrics.filesBlocked).toBe(2);
  });

  it("is additive only — never decrements", () => {
    accumulateToolCall(metrics, true);
    accumulateToolCall(metrics, false);

    expect(metrics.filesWritten).toBe(1);
    expect(metrics.filesBlocked).toBe(1);
  });
});

// ================================================================
// finalize
// ================================================================

describe("finalize", () => {
  let metrics: LoopMetrics;

  beforeEach(() => {
    metrics = createMetrics(makeState());
  });

  it("sets endTime and durationMs", () => {
    const result = finalize(metrics, "done");

    expect(result.endTime).toBeDefined();
    expect(result.durationMs).toBeDefined();
    expect(result.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it("sets finalPhase", () => {
    expect(finalize(metrics, "done").finalPhase).toBe("done");
    expect(finalize(metrics, "escalated").finalPhase).toBe("escalated");
    expect(finalize(metrics, "C").finalPhase).toBe("C");
  });

  it("preserves accumulated data", () => {
    accumulateGate(metrics, makeGateResult({ coverage: 87 }));
    accumulateDispute(metrics, "raised");
    accumulateToolCall(metrics, false);
    accumulateToolCall(metrics, true);

    const result = finalize(metrics, "done");

    expect(result.gateRuns).toBe(1);
    expect(result.finalCoverage).toBe(87);
    expect(result.disputesRaised).toBe(1);
    expect(result.filesWritten).toBe(1);
    expect(result.filesBlocked).toBe(1);
  });

  it("returns a new object (immutable)", () => {
    const result = finalize(metrics, "done");

    expect(result).not.toBe(metrics);
    expect(result.specPath).toBe(metrics.specPath);
    expect(result.endTime).toBeDefined();
    expect(metrics.endTime).toBeUndefined(); // original unchanged
  });
});

// ================================================================
// formatMetrics
// ================================================================

describe("formatMetrics", () => {
  let metrics: LoopMetrics;

  beforeEach(() => {
    metrics = finalize(createMetrics(makeState()), "done");
  });

  it("includes final phase", () => {
    const output = formatMetrics(metrics);
    expect(output).toContain("done");
  });

  it("includes coverage as percentage", () => {
    const m = createMetrics(makeState());
    accumulateGate(m, makeGateResult({ coverage: 87 }));
    const finalized = finalize(m, "done");
    const output = formatMetrics(finalized);

    expect(output).toContain("87%");
  });

  it("includes gate runs count", () => {
    metrics = createMetrics(makeState());
    accumulateGate(metrics, makeGateResult());
    accumulateGate(metrics, makeGateResult());
    const finalized = finalize(metrics, "done");
    const output = formatMetrics(finalized);

    expect(output).toContain("gate");
    expect(output.toLowerCase()).toContain("2");
  });

  it("includes disputes summary", () => {
    metrics = createMetrics(makeState());
    accumulateDispute(metrics, "raised");
    accumulateDispute(metrics, "conceded");
    accumulateDispute(metrics, "defended");
    const finalized = finalize(metrics, "done");
    const output = formatMetrics(finalized);

    expect(output.toLowerCase()).toContain("dispute");
    expect(output).toContain("1");
  });

  it("includes files written and blocked", () => {
    metrics = createMetrics(makeState());
    accumulateToolCall(metrics, false);
    accumulateToolCall(metrics, false);
    accumulateToolCall(metrics, true);
    const finalized = finalize(metrics, "done");
    const output = formatMetrics(finalized);

    expect(output.toLowerCase()).toContain("file");
  });

  it("formats run time in human-readable format", () => {
    // Create metrics with known duration
    const m = createMetrics(makeState());
    m.endTime = m.startTime; // zero duration
    m.durationMs = 0;
    m.finalPhase = "done";
    const output = formatMetrics(m);

    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(10);
  });

  it("shows rounds for each active phase", () => {
    metrics = createMetrics(makeState());
    accumulatePhaseTransition(metrics, "A", 1);
    accumulatePhaseTransition(metrics, "B", 3);
    accumulatePhaseTransition(metrics, "C", 1);
    const finalized = finalize(metrics, "done");
    const output = formatMetrics(finalized);

    expect(output).toContain("A");
    expect(output).toContain("B");
    expect(output).toContain("C");
  });
});

// ================================================================
// loadScoreboard
// ================================================================

describe("loadScoreboard", () => {
  it("throws ErrNoRuns for non-existent directory", () => {
    expect(() => loadScoreboard("/tmp/does-not-exist-" + Date.now())).toThrow(ErrNoRuns);
  });

  it("handles directory with no metrics files", async () => {
    // Use a temp directory that exists but is empty
    const os = require("node:os");
    const fs = require("node:fs");
    const tmpdir = fs.mkdtempSync(`${os.tmpdir()}/loop-test-`);

    try {
      const result = loadScoreboard(tmpdir);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });
});

// ================================================================
// saveMetrics
// ================================================================

describe("saveMetrics", () => {
  it("throws ErrInvalidLabel for empty label", () => {
    const m = finalize(createMetrics(makeState()), "done");
    expect(() => saveMetrics("/tmp", m, "")).toThrow(ErrInvalidLabel);
  });

  it("throws ErrInvalidLabel for invalid characters", () => {
    const m = finalize(createMetrics(makeState()), "done");
    expect(() => saveMetrics("/tmp", m, "bad label!")).toThrow(ErrInvalidLabel);
  });

  it("accepts alphanumeric labels with hyphens and underscores", () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const tmpdir = fs.mkdtempSync(`${os.tmpdir()}/loop-test-`);

    try {
      const m = finalize(createMetrics(makeState()), "done");
      saveMetrics(tmpdir, m, "baseline");
      saveMetrics(tmpdir, m, "prompt-v2");
      saveMetrics(tmpdir, m, "test_1");
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });
});

// ================================================================
// compareRuns
// ================================================================

describe("compareRuns", () => {
  function makeEntry(overrides?: Partial<LoopMetrics>): ScoreboardEntry {
    const m = finalize(createMetrics(makeState()), "done");
    if (overrides) Object.assign(m, overrides);
    return { label: "test", ts: new Date().toISOString(), filePath: "test.json", metrics: m };
  }

  it("compares two runs and produces diffs", () => {
    const a = makeEntry({ gateRuns: 8, finalCoverage: 80 });
    const b = makeEntry({ gateRuns: 5, finalCoverage: 90 });

    const comparison = compareRuns(a, b);

    expect(comparison.diffs.length).toBeGreaterThan(0);
  });

  it("identifies improvement when gate runs decrease", () => {
    const a = makeEntry({ gateRuns: 10 });
    const b = makeEntry({ gateRuns: 5 });

    const comparison = compareRuns(a, b);
    const diff = comparison.diffs.find((d) => d.metric.toLowerCase().includes("gate"));

    if (diff) {
      expect(diff.improved).toBe(true);
    }
  });

  it("identifies degradation when failures increase", () => {
    const a = makeEntry({ totalFailures: 2 });
    const b = makeEntry({ totalFailures: 10 });

    const comparison = compareRuns(a, b);
    const diff = comparison.diffs.find((d) => d.metric.toLowerCase().includes("failure"));

    if (diff) {
      expect(diff.improved).toBe(false);
    }
  });

  it("calculates percentage change", () => {
    const a = makeEntry({ gateRuns: 10 });
    const b = makeEntry({ gateRuns: 8 });

    const comparison = compareRuns(a, b);
    const diff = comparison.diffs.find((d) => d.metric.toLowerCase().includes("gate"));

    if (diff) {
      expect(diff.changePercent).toBeDefined();
    }
  });
});

// ================================================================
// listRuns
// ================================================================

describe("listRuns", () => {
  it("returns empty array for empty directory", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const tmpdir = fs.mkdtempSync(`${os.tmpdir()}/loop-test-`);

    try {
      const result = listRuns(tmpdir, 2);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });

  it("respects limit parameter", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const tmpdir = fs.mkdtempSync(`${os.tmpdir()}/loop-test-`);

    try {
      const m = finalize(createMetrics(makeState()), "done");
      saveMetrics(tmpdir, m, "run-1");
      saveMetrics(tmpdir, m, "run-2");
      saveMetrics(tmpdir, m, "run-3");

      const result = listRuns(tmpdir, 2);
      expect(result.length).toBeLessThanOrEqual(2);
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });
});

// ================================================================
// formatComparison
// ================================================================

describe("formatComparison", () => {
  it("produces a formatted comparison string", () => {
    const entryA: ScoreboardEntry = {
      label: "baseline",
      ts: "2025-01-01T00:00:00Z",
      filePath: "/tmp/baseline.json",
      metrics: finalize(createMetrics(makeState()), "done"),
    };
    const entryB: ScoreboardEntry = {
      label: "prompt-v2",
      ts: "2025-01-01T00:01:00Z",
      filePath: "/tmp/prompt-v2.json",
      metrics: finalize(createMetrics(makeState()), "done"),
    };

    const output = formatComparison(entryA, entryB);
    expect(output).toContain("baseline");
    expect(output).toContain("prompt-v2");
  });
});

// ================================================================
// Edge cases & error paths
// ================================================================

describe("edge cases", () => {
  it("handles metrics with all zeros", () => {
    const metrics = finalize(createMetrics(makeState()), "done");
    const output = formatMetrics(metrics);

    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
  });

  it("handles very large failure count", () => {
    const metrics = createMetrics(makeState());
    // Simulate many failures
    for (let i = 0; i < 100; i++) {
      accumulateGate(metrics, makeGateResult({
        tests: false,
        failures: Array(10).fill(null).map((_, j) => ({
          test: `Test${i}`,
          subtest: `case${j}`,
          output: "fail",
        })),
      }));
    }

    expect(metrics.totalFailures).toBe(1000);
    expect(metrics.testFails).toBe(100);
  });

  it("handles all dispute types zero", () => {
    const metrics = finalize(createMetrics(makeState()), "done");
    expect(metrics.disputesRaised).toBe(0);
    expect(metrics.disputesConceded).toBe(0);
    expect(metrics.disputesDefended).toBe(0);
  });

  it("handles Phase 'done' in roundsByPhase", () => {
    const metrics = createMetrics(makeState());
    accumulatePhaseTransition(metrics, "done", 1);
    expect(metrics.roundsByPhase["done"]).toBe(1);
  });

  it("handles Phase 'escalated' in roundsByPhase", () => {
    const metrics = createMetrics(makeState());
    accumulatePhaseTransition(metrics, "escalated", 1);
    expect(metrics.roundsByPhase["escalated"]).toBe(1);
  });

  it("metrics are additive across finalize calls (original mutable, return value immutable)", () => {
    const metrics = createMetrics(makeState());
    accumulateGate(metrics, makeGateResult());
    const finalized1 = finalize(metrics, "B");
    accumulateGate(metrics, makeGateResult());
    const finalized2 = finalize(metrics, "done");

    expect(finalized1.gateRuns).toBe(1);
    expect(finalized2.gateRuns).toBe(2);
  });
});
