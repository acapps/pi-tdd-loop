// Unit tests for selectors module (pure functions)

import { describe, it, expect, vi, afterEach } from "vitest";
import { formatStatus, parseLoopArgs, loadLoopConfig, mergeLoopArgs } from "../src/selectors";
import type { LoopState, Phase } from "../src/types";
import { writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

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

  it("bare --coverage at end → undefined (not NaN)", () => {
    const result = parseLoopArgs("spec.md --coverage");
    expect(result.coverage).toBeUndefined();
  });

  it("bare --timeout at end → undefined (not NaN)", () => {
    const result = parseLoopArgs("spec.md --timeout");
    expect(result.timeout).toBeUndefined();
  });

  it("bare --branch at end → empty string (default name)", () => {
    const result = parseLoopArgs("spec.md --branch");
    expect(result.branch).toBe("");
  });

  it("--branch=feat/x → value preserved", () => {
    const result = parseLoopArgs("spec.md --branch=feat/x");
    expect(result.branch).toBe("feat/x");
  });

  it("--branch --coverage 90 → branch bare, coverage gets value", () => {
    const result = parseLoopArgs("spec.md --branch --coverage 90");
    expect(result.branch).toBe("");
    expect(result.coverage).toBe(90);
  });
});

// ================================================================
// loadLoopConfig
// ================================================================

describe("loadLoopConfig", () => {
  let tmpDir: string;

  // Use real fs in a temp dir (not mocked) for file I/O tests
  it("returns empty args when no config file exists", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      const result = loadLoopConfig(tmpDir);
      expect(result.args).toEqual({});
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads valid JSON from loop.config.json", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      writeFileSync(join(tmpDir, "loop.config.json"), JSON.stringify({ coverage: 90, timeout: 120 }));
      const result = loadLoopConfig(tmpDir);
      expect(result.args.coverage).toBe(90);
      expect(result.args.timeout).toBe(120);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads from .pi/loop.config.json when root doesn't exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      mkdirSync(join(tmpDir, ".pi"), { recursive: true });
      writeFileSync(join(tmpDir, ".pi", "loop.config.json"), JSON.stringify({ language: "java" }));
      const result = loadLoopConfig(tmpDir);
      expect(result.args.language).toBe("java");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("root loop.config.json takes priority over .pi/", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      writeFileSync(join(tmpDir, "loop.config.json"), JSON.stringify({ coverage: 80 }));
      mkdirSync(join(tmpDir, ".pi"), { recursive: true });
      writeFileSync(join(tmpDir, ".pi", "loop.config.json"), JSON.stringify({ coverage: 90 }));
      const result = loadLoopConfig(tmpDir);
      expect(result.args.coverage).toBe(80);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns warnings for invalid JSON", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      writeFileSync(join(tmpDir, "loop.config.json"), "{ invalid json");
      const result = loadLoopConfig(tmpDir);
      expect(result.args).toEqual({});
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("invalid JSON");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores unknown fields", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      writeFileSync(join(tmpDir, "loop.config.json"), JSON.stringify({ coverage: 85, unknownField: "hello" }));
      const result = loadLoopConfig(tmpDir);
      expect(result.args.coverage).toBe(85);
      expect((result.args as any).unknownField).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores wrong-typed fields", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      writeFileSync(join(tmpDir, "loop.config.json"), JSON.stringify({ coverage: "high", timeout: 120 }));
      const result = loadLoopConfig(tmpDir);
      expect(result.args.coverage).toBeUndefined();
      expect(result.args.timeout).toBe(120);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("branch: true → empty string (default name)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      writeFileSync(join(tmpDir, "loop.config.json"), JSON.stringify({ branch: true }));
      const result = loadLoopConfig(tmpDir);
      expect(result.args.branch).toBe("");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads max* fields", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
    try {
      writeFileSync(join(tmpDir, "loop.config.json"), JSON.stringify({ maxA: 5, maxB: 10, maxDispute: 2 }));
      const result = loadLoopConfig(tmpDir);
      expect(result.args.maxA).toBe(5);
      expect(result.args.maxB).toBe(10);
      expect(result.args.maxDispute).toBe(2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ================================================================
// mergeLoopArgs
// ================================================================

describe("mergeLoopArgs", () => {
  it("CLI wins over config", () => {
    const cli = { specPath: "spec.md", coverage: 95, autoApprove: true };
    const config = { coverage: 80, timeout: 120 };
    const merged = mergeLoopArgs(cli, config);
    expect(merged.coverage).toBe(95);
    expect(merged.timeout).toBe(120); // from config
  });

  it("config fills in CLI gaps", () => {
    const cli = { specPath: "spec.md" };
    const config = { coverage: 90, language: "java", timeout: 120 };
    const merged = mergeLoopArgs(cli, config);
    expect(merged.coverage).toBe(90);
    expect(merged.language).toBe("java");
    expect(merged.timeout).toBe(120);
  });

  it("both empty → all undefined (defaults apply downstream)", () => {
    const cli = { specPath: "spec.md" };
    const config = {};
    const merged = mergeLoopArgs(cli, config);
    expect(merged.coverage).toBeUndefined();
    expect(merged.language).toBeUndefined();
    expect(merged.timeout).toBeUndefined();
  });

  it("autoApprove: false from CLI is 'set' (not 'absent')", () => {
    const cli = { specPath: "spec.md", autoApprove: false };
    const config = { autoApprove: true };
    const merged = mergeLoopArgs(cli, config);
    expect(merged.autoApprove).toBe(false); // CLI wins, even though false
  });

  it("branch: true from config → empty string", () => {
    const cli = { specPath: "spec.md" };
    const config = { branch: "" };
    const merged = mergeLoopArgs(cli, config);
    expect(merged.branch).toBe("");
  });

  it("max* fields merge correctly", () => {
    const cli = { specPath: "spec.md", maxA: 5 };
    const config = { maxA: 3, maxB: 10, maxC: 2 };
    const merged = mergeLoopArgs(cli, config);
    expect(merged.maxA).toBe(5); // CLI wins
    expect(merged.maxB).toBe(10); // from config
    expect(merged.maxC).toBe(2); // from config
  });
});
