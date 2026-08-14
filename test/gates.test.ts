// Unit tests for gates module (pure functions)

import { describe, it, expect } from "vitest";
import { formatFailures, parseTestOutput } from "../src/gates";
import type { FailingTest } from "../src/types";

describe("formatFailures", () => {
  it("returns '(unknown failures)' for empty array", () => {
    expect(formatFailures([])).toBe("(unknown failures)");
  });

  it("formats simple test failures", () => {
    const failures: FailingTest[] = [
      { test: "TestAdd", subtest: "", output: "expected 3, got 2\n" },
    ];
    const result = formatFailures(failures);
    expect(result).toContain("TestAdd");
    expect(result).toContain("expected 3, got 2");
  });

  it("formats subtest failures with slash separator", () => {
    const failures: FailingTest[] = [
      { test: "TestCalculate", subtest: "edge_case", output: "want 28.75, got 70.00\n" },
    ];
    const result = formatFailures(failures);
    expect(result).toContain("TestCalculate/edge_case");
    expect(result).toContain("want 28.75, got 70.00");
  });

  it("deduplicates identical test/subtest pairs", () => {
    const failures: FailingTest[] = [
      { test: "TestAdd", subtest: "overflow", output: "msg1\n" },
      { test: "TestAdd", subtest: "overflow", output: "msg2\n" },
    ];
    const result = formatFailures(failures);
    // Should appear only once (last unique entry wins)
    expect(result.split("TestAdd/overflow").length - 1).toBe(1);
  });

  it("truncates long output to 1000 chars", () => {
    const longOutput = "x".repeat(1200);
    const failures: FailingTest[] = [
      { test: "TestVerbose", subtest: "", output: longOutput + "\n" },
    ];
    const result = formatFailures(failures);
    // Should truncate to ~1000 chars + test name prefix
    expect(result.length).toBeLessThan(1100);
  });

  it("joins multiple failures with newlines", () => {
    const failures: FailingTest[] = [
      { test: "TestA", subtest: "", output: "fail A\n" },
      { test: "TestB", subtest: "", output: "fail B\n" },
    ];
    const result = formatFailures(failures);
    expect(result).toContain("TestA");
    expect(result).toContain("TestB");
    expect(result.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});

// ================================================================
// parseTestOutput — Go JSON mode
// ================================================================

describe("parseTestOutput (Go JSON)", () => {
  it("parses passing tests", () => {
    const output = JSON.stringify({ Action: "run", Test: "TestAdd" }) + "\n" +
      JSON.stringify({ Action: "pass", Test: "TestAdd" });
    const result = parseTestOutput(output, "go");
    expect(result.passed).toBe(true);
    expect(result.allPassed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("parses failing test with output", () => {
    const output = JSON.stringify({ Action: "run", Test: "TestAdd" }) + "\n" +
      JSON.stringify({ Action: "fail", Test: "TestAdd", Output: "expected 3, got 2\n" });
    const result = parseTestOutput(output, "go");
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].test).toBe("TestAdd");
    expect(result.failures[0].subtest).toBe("TestAdd");
    expect(result.failures[0].output).toContain("expected 3");
  });

  it("parses subtest failures with parent test context", () => {
    const output = JSON.stringify({ Action: "run", Test: "TestCalc" }) + "\n" +
      JSON.stringify({ Action: "run", Test: "TestCalc/overflow" }) + "\n" +
      JSON.stringify({ Action: "fail", Test: "TestCalc/overflow", Output: "overflow detected\n" });
    const result = parseTestOutput(output, "go");
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    // currentTest tracks the last "run" action, so it becomes the subtest name
    expect(result.failures[0].test).toBe("TestCalc/overflow");
    expect(result.failures[0].subtest).toBe("TestCalc/overflow");
  });

  it("handles multiple test suites", () => {
    const output = JSON.stringify({ Action: "run", Test: "TestA" }) + "\n" +
      JSON.stringify({ Action: "pass", Test: "TestA" }) + "\n" +
      JSON.stringify({ Action: "run", Test: "TestB" }) + "\n" +
      JSON.stringify({ Action: "fail", Test: "TestB", Output: "failed\n" });
    const result = parseTestOutput(output, "go");
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].test).toBe("TestB");
  });

  it("ignores non-JSON lines gracefully", () => {
    const output = "WARNING: package is not used\n" +
      JSON.stringify({ Action: "run", Test: "TestA" }) + "\n" +
      JSON.stringify({ Action: "pass", Test: "TestA" });
    const result = parseTestOutput(output, "go");
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("handles empty output", () => {
    const result = parseTestOutput("", "go");
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("filters out WARNING-prefixed test names", () => {
    const output = JSON.stringify({ Action: "run", Test: "TestA" }) + "\n" +
      JSON.stringify({ Action: "fail", Test: "WARNING: something" });
    const result = parseTestOutput(output, "go");
    expect(result.failures).toHaveLength(0);
    expect(result.passed).toBe(true);
  });
});

// ================================================================
// parseTestOutput — Generic (non-Go) mode
// ================================================================

describe("parseTestOutput (generic)", () => {
  it("parses FAIL lines for Java", () => {
    const output = "Tests run: 5, Failures: 2\n" +
      "FAIL com.example.MyTest\n" +
      "FAIL com.example.OtherTest";
    const result = parseTestOutput(output, "java");
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });

  it("parses FAIL lines for TypeScript", () => {
    const output = "Test Suites: 1 failed\n" +
      "FAIL src/handler.test.ts\n" +
      "FAIL src/utils.test.ts";
    const result = parseTestOutput(output, "typescript");
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(2);
  });

  it("returns allPassed when no FAIL lines found", () => {
    const output = "Tests run: 5, All passed\n";
    const result = parseTestOutput(output, "java");
    expect(result.passed).toBe(true);
    expect(result.allPassed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});
