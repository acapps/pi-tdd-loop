// Unit tests for selectors module (pure functions)

import { describe, it, expect } from "vitest";
import { formatStatus, parseLoopArgs } from "../src/selectors";
import type { LoopState, Phase } from "../src/types";

function makeState(phase: Phase = "idle", overrides = {}): LoopState {
  return {
    phase,
    round: 0,
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
  gateTimeoutSec: 60,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides};
}

describe("formatStatus", () => {
  it("shows 'no gate data' when lastGateResult is missing", () => {
    const state = makeState("idle");
    const result = formatStatus(state);
    expect(result).toContain("Phase: idle, round 0");
    expect(result).toContain("(no gate data)");
  });

  it("shows gate results when lastGateResult is present", () => {
    const state = makeState("A", {
      round: 2,
      lastGateResult: {
        compile: true,
        compileError: "",
        
        coverage: 0,
        failures: [
          { test: "TestAdd", subtest: "", output: "expected 3, got 2\n" },
        ],
        allPassed: false}});
    const result = formatStatus(state);
    expect(result).toContain("Phase: A, round 2");
    expect(result).toContain("compile: ✓");
    expect(result).toContain("allPassed: ✗ (1 failures)");
    expect(result).toContain("TestAdd");
  });

  it("truncates failures to 5 with overflow notice", () => {
  const failures = Array.from({ length: 8 }, (_, i) => ({
      test: `Test${i}`,
      subtest: "",
      output: `fail ${i}\n`}));
    const state = makeState("B", {
      round: 3,
      lastGateResult: {
        compile: true,
        compileError: "",
        
        coverage: 0,
        failures,
        allPassed: false}});
    const result = formatStatus(state);
    expect(result).toContain("... and 3 more");
  });

  it("shows coverage percentage and threshold", () => {
    const state = makeState("C", {
      round: 1,
      coverageThreshold: 90,
      gateTimeoutSec: 60,
      lastGateResult: {
        compile: true,
        compileError: "",
        
        coverage: 92.5,
        failures: [],
        allPassed: true}});
    const result = formatStatus(state);
    expect(result).toContain("92.5%");
    expect(result).toContain("threshold: 90%");
  });
});

describe("parseLoopArgs", () => {
  it("returns empty spec path for empty args", () => {
    const result = parseLoopArgs("");
    expect(result.specPath).toBe("");
    expect(result.coverage).toBeUndefined();
  });

  it("returns spec path for simple args", () => {
    const result = parseLoopArgs("path/to/spec.md");
    expect(result.specPath).toBe("path/to/spec.md");
    expect(result.coverage).toBeUndefined();
  });

  it("parses --coverage flag with integer value", () => {
    const result = parseLoopArgs("--coverage 90 path/to/spec.md");
    expect(result.specPath).toBe("path/to/spec.md");
    expect(result.coverage).toBe(90);
  });

  it("parses --coverage flag with decimal value", () => {
    const result = parseLoopArgs("--coverage 85.5 spec.md");
    expect(result.specPath).toBe("spec.md");
    expect(result.coverage).toBe(85.5);
  });

  it("handles --coverage after spec path", () => {
    const result = parseLoopArgs("spec.md --coverage 95");
    expect(result.specPath).toBe("spec.md");
    expect(result.coverage).toBe(95);
  });

  it("trims whitespace", () => {
    const result = parseLoopArgs("  spec.md  ");
    expect(result.specPath).toBe("spec.md");
  });

  it("strips @ prefix from pi paths", () => {
    const result = parseLoopArgs("@/Users/alancapps/project/spec.md");
    expect(result.specPath).toBe("/Users/alancapps/project/spec.md");
  });

  it("strips @ prefix with flags", () => {
    const result = parseLoopArgs("--coverage 90 @/path/to/spec.md");
    expect(result.specPath).toBe("/path/to/spec.md");
    expect(result.coverage).toBe(90);
  });

  it("expands ~ to home directory", () => {
    const result = parseLoopArgs("~/project/spec.md");
    const os = require("node:os");
    expect(result.specPath).toBe(`${os.homedir()}/project/spec.md`);
  });

  it("expands ~ and strips @ together", () => {
    const result = parseLoopArgs("@~/project/spec.md");
    const os = require("node:os");
    expect(result.specPath).toBe(`${os.homedir()}/project/spec.md`);
  });

  it("--no-auto-approve flag → autoApprove false", () => {
    const result = parseLoopArgs("--no-auto-approve spec.md");
    expect(result.specPath).toBe("spec.md");
    expect(result.autoApprove).toBe(false);
  });

  it("no --no-auto-approve flag → autoApprove true", () => {
    const result = parseLoopArgs("spec.md");
    expect(result.autoApprove).toBe(true);
  });

  it("--no-auto-approve combined with other flags", () => {
    const result = parseLoopArgs("--coverage 90 --language java --no-auto-approve spec.md");
    expect(result.specPath).toBe("spec.md");
    expect(result.coverage).toBe(90);
    expect(result.language).toBe("java");
    expect(result.autoApprove).toBe(false);
  });
});
