// Unit tests for gates module (pure functions)

import { describe, it, expect } from "vitest";
import { formatFailures } from "../src/gates";
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
