// Contract tests — bug-gate-signal-integrity
// Spec: internal/bug-gate-signal-integrity.md
//
// Contract pinned by this file:
//  - The test process exit code is the gate signal; parsed failures are
//    display-only (S1, S2 spurious-green regressions).
//  - `runGates` is async, returns GateOutcome ("result" | "error"), and a
//    tool that cannot run is an error — never a fabricated pass.
//  - `parseCoverage` is a pure, exported, deterministic parser: one attempt
//    per language, last match wins, finite values in [0, 100] only,
//    null when nothing matches (row 6: skip, never a fabricated 0).
//  - `getTestCommand` emits exactly one command string per language in B/C
//    (single invocation yielding signal + coverage; no `|| true`).
//  - transitions: T1 (advance when coverage unavailable or >= threshold),
//    T2 (coverage below threshold → retry with pinned notify),
//    T5 (GateOutcome error → retry via computeGateErrorTransition,
//    escalation at phase max with pinned notify).
//  - generic-prompts: promptGateError / promptCoverageBelowThreshold
//    verbatim strings.
//  - constants: RETRY_PROMPTS gains COVERAGE_BELOW_THRESHOLD and GATE_ERROR.
//
// NOTE (Tester → Writer): the dispatcher-level duplicate-settle lock test
// (module-local `gateInFlight` in src/events/agent-settled/gate-transition.ts)
// is deliberately NOT covered here — it requires the handler to expose the
// in-flight window (e.g. an injectable runGates that can be held open),
// which is an implementation detail the Writer decides. File it as a
// follow-up test in test/events/agent-settled/gate-transition.test.ts once
// the async handler lands.

import { describe, it, expect } from "vitest";
import { runGates, parseCoverage, getTestCommand } from "../src/gates";
import type { GateOutcome } from "../src/gates";
import * as T from "../src/transitions";
import { RETRY_PROMPTS } from "../src/constants";
import * as GP from "../src/generic-prompts";
import type { LoopState, GateResult } from "../src/types";

// --- Fixtures ---

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
    round: 1,
    specPath: "spec.md",
    language: "go",
    buildTool: "go",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
    ...overrides,
  };
}

function makeGate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    compile: true,
    compileError: "",
    tests: true,
    allPassed: true,
    coverage: 85,
    failures: [],
    ...overrides,
  };
}

// Verbatim example strings pinned in the spec's Coverage parse patterns table.
const GO_COVER_OUTPUT =
  "ok  \texample.com/foo\t0.012s\tcoverage: 82.5% of statements";
const MAVEN_COVER_OUTPUT =
  "Total, 1234, 56, 78, 9, 10, 11, 82.5% ...";
const VITEST_COVER_OUTPUT =
  "All files          |  85.71 |";

// ================================================================
// parseCoverage — pure parser (deterministic, no live tool execution)
// ================================================================

describe("parseCoverage", () => {
  it("go: parses the cover summary line (82.5)", () => {
    expect(parseCoverage(GO_COVER_OUTPUT, "go")).toBe(82.5);
  });

  it("java (maven): parses the JaCoCo Total line (82.5)", () => {
    expect(parseCoverage(MAVEN_COVER_OUTPUT, "java")).toBe(82.5);
  });

  it("java (gradle): parses the JaCoCo Total line (82.5)", () => {
    expect(parseCoverage(MAVEN_COVER_OUTPUT, "java")).toBe(82.5);
  });

  it("typescript: parses the vitest coverage table All-files row (85.71)", () => {
    expect(parseCoverage(VITEST_COVER_OUTPUT, "typescript")).toBe(85.71);
  });

  it("go: no cover line → null (row 6: unavailable, not 0)", () => {
    expect(parseCoverage("ok  \texample.com/foo\t0.012s\n", "go")).toBeNull();
  });

  it("java: no JaCoCo summary → null", () => {
    expect(parseCoverage("Tests run: 5, Failures: 0\nBUILD SUCCESS\n", "java")).toBeNull();
  });

  it("typescript: no coverage table → null", () => {
    expect(parseCoverage("Test Files  2 passed (2)\n", "typescript")).toBeNull();
  });

  it("empty string → null for every language (edge: empty input)", () => {
    expect(parseCoverage("", "go")).toBeNull();
    expect(parseCoverage("", "java")).toBeNull();
    expect(parseCoverage("", "typescript")).toBeNull();
  });

  it("last match wins when multiple matches exist", () => {
    const output =
      "ok  \ta\t0.1s\tcoverage: 10.0% of statements\n" +
      "ok  \tb\t0.2s\tcoverage: 90.0% of statements\n";
    expect(parseCoverage(output, "go")).toBe(90);
  });

  it("rejects non-finite / out-of-range values as null", () => {
    expect(parseCoverage("coverage: NaN% of statements", "go")).toBeNull();
    expect(parseCoverage("Total, 1, 2, 3, 4, 5, 6, 150.0% ...", "java")).toBeNull();
    expect(parseCoverage("All files          |  85.71 |  -1", "typescript")).toBeNull();
  });

  it("accepts boundary values 0 and 100 (single element / edge values)", () => {
    expect(parseCoverage("coverage: 0% of statements", "go")).toBe(0);
    expect(parseCoverage("coverage: 100% of statements", "go")).toBe(100);
  });
});

// ================================================================
// getTestCommand — single invocation, no `|| true`
// ================================================================

describe("getTestCommand (B/C single invocation)", () => {
  it("go: exactly `go test -json -cover ./...`", () => {
    expect(getTestCommand("go")).toBe("go test -json -cover ./...");
  });

  it("typescript: `npx vitest run --coverage`", () => {
    expect(getTestCommand("typescript")).toBe("npx vitest run --coverage");
  });

  it("java/maven: `mvn test -Djacoco.skip=false`", () => {
    expect(getTestCommand("java", "maven")).toBe("mvn test -Djacoco.skip=false");
  });

  it("java/gradle: `gradle test`", () => {
    expect(getTestCommand("java", "gradle")).toBe("gradle test");
  });

  it("no command carries a `|| true` or `|| echo` fallback", () => {
    for (const cmd of [
      getTestCommand("go"),
      getTestCommand("java", "maven"),
      getTestCommand("java", "gradle"),
      getTestCommand("typescript"),
    ]) {
      expect(cmd).not.toContain("|| true");
      expect(cmd).not.toContain("|| echo");
    }
  });
});

// ================================================================
// runGates — exit code is the signal (S1/S2 spurious-green regressions)
//
// These tests execute the real command in a temp cwd; the pre-fix
// code reads the signal from parsed output only, so:
//   - a go run that exits non-zero with no parseable `fail` JSON line
//     (panic / vet / build error in a _test.go) MUST be red (S1),
//   - a java/ts run that exits non-zero with no `FAIL <id>` line MUST be
//     red (S2).
// The exit-1 fixtures below produce no parseable failure lines, which is
// exactly the spurious-green condition the fix closes.
// ================================================================

describe("runGates — exit code is the gate signal", () => {
  it("S1 regression: go exit ≠ 0 with no parseable fail line → allPassed false", async () => {
    const cwd = makeGoCwd(`package main

import "testing"

func TestPanic(t *testing.T) { panic("boom") }
`);
    try {
      const outcome = await runGates(cwd, 0, "go", "go", "B");
      if (outcome.kind === "result" && outcome.result) {
        expect(outcome.result.tests).toBe(false);
        expect(outcome.result.allPassed).toBe(false);
        // A red run never reports a coverage number (row-ordering pin).
        expect(outcome.result.coverage).toBe(0);
      } else {
        // A spawn error is also acceptable (environment without go) — but it
        // must NOT be reported as a pass.
        expect(outcome.kind).toBe("error");
      }
    } finally {
      removeDir(cwd);
    }
  }, 120_000);

  it("S2 regression: java/ts exit ≠ 0 with no FAIL line → allPassed false", async () => {
    const cwd = makeTsCwd();
    try {
      const outcome = await runGates(cwd, 0, "typescript", "maven", "B");
      if (outcome.kind === "result" && outcome.result) {
        expect(outcome.result.tests).toBe(false);
        expect(outcome.result.allPassed).toBe(false);
      } else {
        expect(outcome.kind).toBe("error");
      }
    } finally {
      removeDir(cwd);
    }
  }, 120_000);

  it("exit 0 + no FAIL lines → allPassed true (green stays green)", async () => {
    const cwd = makeGoCwd(`package main

import "testing"

func TestOk(t *testing.T) { }
`);
    try {
      const outcome = await runGates(cwd, 0, "go", "go", "B");
      if (outcome.kind === "result" && outcome.result) {
        expect(outcome.result.tests).toBe(true);
        expect(outcome.result.allPassed).toBe(true);
      } else {
        expect(outcome.kind).toBe("error");
      }
    } finally {
      removeDir(cwd);
    }
  }, 120_000);

  it("spawn error (command cannot start) → kind 'error', never a GateResult", async () => {
    // A cwd that does not exist makes the child process fail to start.
    const outcome = await runGates("/nonexistent-cwd-gate-test-xyz", 0, "go", "go", "A");
    expect(outcome.kind).toBe("error");
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toEqual(expect.stringMatching(/./));
  });

  it("returns a Promise (async contract)", async () => {
    const p = runGates(process.cwd(), 0, "go", "go", "A");
    expect(p).toBeInstanceOf(Promise);
    await p; // drain — must not reject
  });
});

// --- temp-cwd helpers (real toolchain execution for signal tests) ---

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeGoCwd(testSrc: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-go-"));
  writeFileSync(join(dir, "go.mod"), "module example.com/gate\n\ngo 1.21\n");
  writeFileSync(join(dir, "main_test.go"), testSrc);
  return dir;
}

function makeTsCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-ts-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "gate-ts", private: true, type: "module" }),
  );
  // A test that fails at runtime → non-zero exit, no `FAIL <id>` line shape
  // that the old parser could miss (vitest does print FAIL, but the exit
  // code is the signal either way).
  writeFileSync(
    join(dir, "src", "fail.test.ts"),
    "import { it, expect } from 'vitest';\nit('fails', () => { expect(1).toBe(2); });\n",
  );
  return dir;
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ================================================================
// constants — new RETRY_PROMPTS keys
// ================================================================

describe("constants — RETRY_PROMPTS new keys", () => {
  it("COVERAGE_BELOW_THRESHOLD = 'coverage_below_threshold'", () => {
    expect(RETRY_PROMPTS.COVERAGE_BELOW_THRESHOLD).toBe("coverage_below_threshold");
  });

  it("GATE_ERROR = 'gate_error'", () => {
    expect(RETRY_PROMPTS.GATE_ERROR).toBe("gate_error");
  });
});

// ================================================================
// generic-prompts — verbatim pinned strings
// ================================================================

describe("generic-prompts — gate error / coverage prompts", () => {
  it("promptGateError renders the pinned verbatim string", () => {
    expect(GP.promptGateError("spawn go ENOENT")).toBe(
      "Gate could not run: spawn go ENOENT. Fix the environment and retry.",
    );
  });

  it("promptCoverageBelowThreshold renders the pinned verbatim string", () => {
    expect(GP.promptCoverageBelowThreshold(62.5, 80)).toBe(
      "Coverage 62.5% is below the 80% threshold.",
    );
  });

  it("promptCoverageBelowThreshold with integer values", () => {
    expect(GP.promptCoverageBelowThreshold(60, 80)).toBe(
      "Coverage 60% is below the 80% threshold.",
    );
  });
});

// ================================================================
// transitions — T1 / T2 (Phase B coverage gate)
// ================================================================

describe("transitions — Phase B coverage rows (T1/T2)", () => {
  it("T1: allPassed + coverage >= threshold → advance to C (existing behavior)", () => {
    const state = makeState({ phase: "B", round: 1, coverageThreshold: 80 });
    const result = T.computeTransition(state, makeGate({ coverage: 85, allPassed: true }));
    expect(result.effect.type).toBe("advance");
    if (result.effect.type === "advance") {
      expect(result.state.phase).toBe("C");
    }
  });

  it("T1: allPassed + coverage unavailable (0) → advance (skip, not fail)", () => {
    const state = makeState({ phase: "B", round: 1, coverageThreshold: 80 });
    const result = T.computeTransition(state, makeGate({ coverage: 0, allPassed: true }));
    expect(result.effect.type).toBe("advance");
    if (result.effect.type === "advance") {
      expect(result.state.phase).toBe("C");
    }
  });

  it("T2: allPassed + coverage below threshold → retry with pinned notify", () => {
    const state = makeState({ phase: "B", round: 1, coverageThreshold: 80 });
    const result = T.computeTransition(state, makeGate({ coverage: 62.5, allPassed: true }));
    expect(result.effect.type).toBe("retry");
    if (result.effect.type === "retry") {
      expect(result.effect.notify).toBe(
        "Coverage 62.5% is below the 80% threshold.",
      );
      expect(result.effect.level).toBe("warning");
      expect(result.effect.prompt).toBe(RETRY_PROMPTS.COVERAGE_BELOW_THRESHOLD);
    }
    expect(result.state.phase).toBe("B");
    expect(result.state.round).toBe(2);
  });

  it("T2 boundary: coverage === threshold → advance (not below)", () => {
    const state = makeState({ phase: "B", round: 1, coverageThreshold: 80 });
    const result = T.computeTransition(state, makeGate({ coverage: 80, allPassed: true }));
    expect(result.effect.type).toBe("advance");
  });

  it("T3 precedence: !allPassed beats T2 (red run never reports coverage)", () => {
    const state = makeState({ phase: "B", round: 1, coverageThreshold: 80 });
    const result = T.computeTransition(
      state,
      makeGate({ tests: false, allPassed: false, coverage: 0, failures: [{ test: "T", subtest: "", output: "x" }] }),
    );
    expect(result.effect.type).toBe("retry");
    if (result.effect.type === "retry") {
      // The existing writer retry, NOT the coverage retry.
      expect(result.effect.prompt).not.toBe(RETRY_PROMPTS.COVERAGE_BELOW_THRESHOLD);
    }
  });

  it("Phase C ignores coverage (T4 pinned): allPassed → done even below threshold", () => {
    const state = makeState({ phase: "C", round: 1, coverageThreshold: 80 });
    const result = T.computeTransition(state, makeGate({ coverage: 10, allPassed: true, tests: true }));
    expect(result.effect.type).toBe("done");
  });
});

// ================================================================
// transitions — T5 (gate error) via computeGateErrorTransition
// ================================================================

describe("transitions — T5 gate error (computeGateErrorTransition)", () => {
  it("error in B, round < maxB → retry with pinned notify, round increments", () => {
    const state = makeState({ phase: "B", round: 1, maxB: 5 });
    const result = T.computeGateErrorTransition(state, "spawn go ENOENT");
    expect(result.effect.type).toBe("retry");
    if (result.effect.type === "retry") {
      expect(result.effect.notify).toBe(
        "Gate could not run: spawn go ENOENT. Fix the environment and retry.",
      );
      expect(result.effect.level).toBe("warning");
      expect(result.effect.prompt).toBe(RETRY_PROMPTS.GATE_ERROR);
    }
    expect(result.state.phase).toBe("B");
    expect(result.state.round).toBe(2);
    // An error must not poison lastGateResult.
    expect(result.state.lastGateResult).toBeUndefined();
  });

  it("error in B, round >= maxB → escalation (same budget as the phase's existing retry)", () => {
    const state = makeState({ phase: "B", round: 5, maxB: 5 });
    const result = T.computeGateErrorTransition(state, "boom");
    expect(result.effect.type).toBe("escalated");
    expect(result.state.phase).toBe("escalated");
    expect(result.state.lastPhase).toBe("B");
  });

  it("error in A → retry within maxA", () => {
    const state = makeState({ phase: "A", round: 1, maxA: 3 });
    const result = T.computeGateErrorTransition(state, "boom");
    expect(result.effect.type).toBe("retry");
    expect(result.state.phase).toBe("A");
    expect(result.state.round).toBe(2);
  });

  it("error in A at maxA → escalation", () => {
    const state = makeState({ phase: "A", round: 3, maxA: 3 });
    const result = T.computeGateErrorTransition(state, "boom");
    expect(result.effect.type).toBe("escalated");
    expect(result.state.lastPhase).toBe("A");
  });

  it("error in C, round < maxC → retry", () => {
    const state = makeState({ phase: "C", round: 1, maxC: 3 });
    const result = T.computeGateErrorTransition(state, "boom");
    expect(result.effect.type).toBe("retry");
    expect(result.state.phase).toBe("C");
    expect(result.state.round).toBe(2);
  });

  it("never fabricates a GateResult: returned state carries no lastGateResult", () => {
    const state = makeState({ phase: "B", round: 1 });
    const result = T.computeGateErrorTransition(state, "boom");
    expect(result.state.lastGateResult).toBeUndefined();
  });
});

// ================================================================
// GateOutcome shape — type-level contract (compile-time + runtime spot check)
// ================================================================

describe("GateOutcome shape", () => {
  it("kind 'result' carries a GateResult; kind 'error' carries a string error", () => {
    const resultOutcome: GateOutcome = {
      kind: "result",
      result: makeGate(),
    };
    expect(resultOutcome.kind).toBe("result");
    expect(resultOutcome.result).toBeDefined();

    const errorOutcome: GateOutcome = { kind: "error", error: "boom" };
    expect(errorOutcome.kind).toBe("error");
    expect(errorOutcome.error).toBe("boom");
  });
});
