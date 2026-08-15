// Unit tests for the Phase 0 baseline module (pure functions).
// runBaselineTests is not tested here — it spawns processes; the pure
// classification (evaluateBaseline) and formatting are covered instead.

import { describe, it, expect } from "vitest";
import { evaluateBaseline, formatBaselineFailure } from "../src/baseline";
import type { BaselineResult } from "../src/baseline";

// ================================================================
// evaluateBaseline — Go
// ================================================================

describe("evaluateBaseline (go)", () => {
  it("green suite with passing tests → ok, not noTests", () => {
    const output =
      JSON.stringify({ Action: "run", Test: "TestAdd" }) + "\n" +
      JSON.stringify({ Action: "pass", Test: "TestAdd" });
    const r = evaluateBaseline(output, "go", true);
    expect(r.ok).toBe(true);
    expect(r.noTests).toBe(false);
    expect(r.failures).toHaveLength(0);
  });

  it("project with no test files → ok, noTests", () => {
    const output =
      JSON.stringify({ Action: "output", Package: "example.com/m/pkg", Output: "?   example.com/m/pkg [no test files]" }) + "\n" +
      JSON.stringify({ Action: "output", Package: "example.com/m/other", Output: "?   example.com/m/other [no test files]" });
    const r = evaluateBaseline(output, "go", true);
    expect(r.ok).toBe(true);
    expect(r.noTests).toBe(true);
  });

  it("failing test → not ok, failure listed", () => {
    const output =
      JSON.stringify({ Action: "run", Test: "TestAdd" }) + "\n" +
      JSON.stringify({ Action: "fail", Test: "TestAdd", Output: "expected 3, got 2\n" });
    const r = evaluateBaseline(output, "go", false);
    expect(r.ok).toBe(false);
    expect(r.noTests).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].test).toBe("TestAdd");
  });

  it("build failure (no test events) → not ok, no parsed failures", () => {
    const output =
      JSON.stringify({ Action: "fail", Package: "example.com/m/pkg", Output: "# example.com/m/pkg\npkg.go:3: undefined: X\n" });
    const r = evaluateBaseline(output, "go", false);
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(0);
  });

  it("build failure is not masked by [no test files] lines from other packages", () => {
    const output =
      JSON.stringify({ Action: "output", Package: "example.com/m/empty", Output: "?   example.com/m/empty [no test files]" }) + "\n" +
      JSON.stringify({ Action: "fail", Package: "example.com/m/bad", Output: "build failed\n" });
    const r = evaluateBaseline(output, "go", false);
    expect(r.ok).toBe(false);
    expect(r.noTests).toBe(false);
  });
});

// ================================================================
// evaluateBaseline — Java (Maven)
// ================================================================

describe("evaluateBaseline (java)", () => {
  it("mvn with no tests → ok, noTests", () => {
    const r = evaluateBaseline(
      "Nothing to compile.\nNo tests to run.\nBUILD SUCCESS",
      "java",
      true,
    );
    expect(r.ok).toBe(true);
    expect(r.noTests).toBe(true);
  });

  it("failing tests → not ok, failure listed", () => {
    const output = "Tests run: 5, Failures: 2\nFAIL com.example.MyTest\nBUILD FAILURE";
    const r = evaluateBaseline(output, "java", false);
    expect(r.ok).toBe(false);
    expect(r.noTests).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].test).toContain("com.example.MyTest");
  });

  it("build failure with no FAIL lines → not ok", () => {
    const r = evaluateBaseline("[ERROR] Failed to execute goal ... compilation failure\nBUILD FAILURE", "java", false);
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(0);
  });
});

// ================================================================
// evaluateBaseline — TypeScript (vitest)
// ================================================================

describe("evaluateBaseline (typescript)", () => {
  it("green suite → ok", () => {
    const r = evaluateBaseline(
      "Test Files  2 passed (2)\n     Tests  8 passed (8)",
      "typescript",
      true,
    );
    expect(r.ok).toBe(true);
    expect(r.noTests).toBe(false);
  });

  it("vitest with no test files (non-zero exit) → ok, noTests", () => {
    const r = evaluateBaseline(
      "No test files found, exiting with code 1",
      "typescript",
      false,
    );
    expect(r.ok).toBe(true);
    expect(r.noTests).toBe(true);
  });

  it("failing suite → not ok, failure listed", () => {
    const output = "Test Files  1 failed (1)\n     Tests  2 failed (5)\nFAIL  src/handler.test.ts";
    const r = evaluateBaseline(output, "typescript", false);
    expect(r.ok).toBe(false);
    expect(r.noTests).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].test).toContain("src/handler.test.ts");
  });
});

// ================================================================
// formatBaselineFailure
// ================================================================

describe("formatBaselineFailure", () => {
  it("uses parsed failures when present", () => {
    const r: BaselineResult = {
      ok: false,
      noTests: false,
      failures: [{ test: "TestX", subtest: "", output: "boom\n" }],
      output: "raw",
    };
    const text = formatBaselineFailure(r);
    expect(text).toContain("TestX");
    expect(text).toContain("boom");
  });

  it("falls back to a tail of the raw output when no failures parsed", () => {
    const r: BaselineResult = {
      ok: false,
      noTests: false,
      failures: [],
      output: "build error: undefined: X\n",
    };
    expect(formatBaselineFailure(r)).toContain("build error");
  });

  it("reports when no output was captured", () => {
    const r: BaselineResult = { ok: false, noTests: false, failures: [], output: "" };
    expect(formatBaselineFailure(r)).toBe("(no output captured)");
  });

  it("truncates very long raw output to a tail", () => {
    const r: BaselineResult = {
      ok: false,
      noTests: false,
      failures: [],
      output: "x".repeat(5000) + "\nfinal error line",
    };
    const text = formatBaselineFailure(r);
    expect(text).toContain("final error line");
    expect(text.length).toBeLessThanOrEqual(1500 + 20);
  });
});
