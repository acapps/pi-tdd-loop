// Contract tests for the dead-code deletions — internal/refactor-state-model-divergence.md
// (Inventory, Scope lines, Acceptance criteria 3–6).
//
// Grep-sweep style: the dead symbols must not exist anywhere in src/ or test/.
// Fast + hermetic: static file reads only, no process spawning.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeSpec } from "../src/reviewer";
import { cmdLoop } from "../src/commands";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = resolve(__dirname, "..");

function readRel(p: string): string {
  return readFileSync(resolve(ROOT, p), "utf-8");
}

function collectSources(dir: string, out: string[] = []): string[] {
  const base = resolve(ROOT, dir);
  const fs = require("node:fs");
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const full = resolve(base, entry.name);
    if (entry.isDirectory()) collectSources(full.slice(ROOT.length + 1).replace(/^\//, ""), out);
    else if (entry.name.endsWith(".ts")) out.push(full.slice(ROOT.length + 1).replace(/^\//, ""));
  }
  return out;
}

// test/e2e is excluded: real-toolchain runs live there, not in the default suite.
// This test file is also excluded: it contains the needles as string literals.
const ALL_TS = [...collectSources("src"), ...collectSources("test")].filter(
  (f) => !f.startsWith("test/e2e/") && f !== "test/state-divergence-cleanup.test.ts"
);

function grepNeedle(needle: string): string[] {
  return ALL_TS.filter((f) => readRel(f).includes(needle));
}

// ================================================================
// Deletions: the five dead modules must be gone
// ================================================================

describe("dead module files deleted", () => {
  it.each([
    "src/state-types.ts",
    "src/state-factory.ts",
    "src/state-migration.ts",
    "src/transient-flags.ts",
  ])("%s does not exist", (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(false);
  });

  it("src/metrics.ts survives — the golden/e2e harness imports its LoopMetrics shape", () => {
    expect(existsSync(resolve(ROOT, "src/metrics.ts"))).toBe(true);
  });

  it.each([
    "test/state-types.test.ts",
    "test/state-factory.test.ts",
    "test/state-migration.test.ts",
    "test/transient-flags.test.ts",
    "test/metrics.test.ts",
    "test/make-state-helper.test.ts",
  ])("%s does not exist", (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(false);
  });
});

// ================================================================
// Grep sweeps (acceptance criterion 3): needles must reach 0
// ================================================================

describe("grep sweeps — dead symbols reach 0 in src/ and test/", () => {
  it.each([
    "toSubStructures",
    "applySubStructures",
    "LoopSubStructures",
    "PhaseZeroThresholds",
    "DEFAULT_PHASE_ZERO_THRESHOLDS",
    "skipPhase0",
    "shouldActivatePhase0",
    "--skip-review",
  ])("needle %j appears in no .ts file", (needle) => {
    const hits = grepNeedle(needle);
    expect(hits).toEqual([]);
  });

  it("needle 'validateState(' appears in no .ts file (superseded by validateLoopState)", () => {
    expect(grepNeedle("validateState(")).toEqual([]);
  });
});

// ================================================================
// validateLoopState surface (acceptance criterion 4):
// 1 definition + 2 production call sites (commit.ts, session-start.ts) + tests
// ================================================================

describe("validateLoopState — call-site census", () => {
  const hits = grepNeedle("validateLoopState");

  it("has exactly one definition (in src/state-validation.ts)", () => {
    const defs = hits.filter((f) => f === "src/state-validation.ts");
    expect(defs).toEqual(["src/state-validation.ts"]);
  });

  it("is called from src/commit.ts", () => {
    expect(hits).toContain("src/commit.ts");
  });

  it("is called from src/events/session-start.ts", () => {
    expect(hits).toContain("src/events/session-start.ts");
  });

  it("is referenced by the rewritten validator test", () => {
    expect(hits).toContain("test/state-validation.test.ts");
  });

  it("is not imported by any other src/ module", () => {
    const prod = hits.filter((f) => f.startsWith("src/"));
    expect(prod.sort()).toEqual(["src/commit.ts", "src/events/session-start.ts", "src/state-validation.ts"].sort());
  });
});

// ================================================================
// --skip-review removed from the /loop usage strings
// ================================================================

describe("/loop usage strings — --skip-review removed", () => {
  it("cmdLoop description does not mention --skip-review", () => {
    const cmd = cmdLoop(
      { current: makeEmptyState() },
      {} as ExtensionAPI,
      () => {});
    expect(cmd.description).not.toContain("--skip-review");
  });

  it("the usage-error notification does not mention --skip-review", async () => {
    const notifies: Array<[string, string]> = [];
    const ctx = {
      ui: { notify: (m: string, l: string) => notifies.push([m, l]) },
      cwd: "/tmp/none"} as never;
    const cmd = cmdLoop({ current: makeEmptyState() }, {} as ExtensionAPI, () => {});
    await cmd.handler("", ctx);
    const usage = notifies.find(([m]) => m.startsWith("Usage: /loop"));
    expect(usage).toBeDefined();
    expect(usage![0]).not.toContain("--skip-review");
  });

  it("SPEC.md does not advertise --skip-review", () => {
    expect(readRel("SPEC.md")).not.toContain("--skip-review");
  });

  it("README.md does not advertise --skip-review", () => {
    if (existsSync(resolve(ROOT, "README.md"))) {
      expect(readRel("README.md")).not.toContain("--skip-review");
    }
  });
});

// ================================================================
// reviewer: analyzeSpec simplified — SpecAnalysis loses shouldActivatePhase0
// ================================================================

describe("analyzeSpec — simplified SpecAnalysis shape", () => {
  it("returns findings + reasons, no shouldActivatePhase0 key", () => {
    const analysis = analyzeSpec("# Spec\n\n- Func1() — does a thing.\n- Func2() — does another.\n");
    expect(Array.isArray(analysis.findings)).toBe(true);
    expect(analysis.reasons).toEqual(["Phase 0 is the baseline"]);
    expect("shouldActivatePhase0" in analysis).toBe(false);
  });

  it("keeps reasons for an empty spec", () => {
    const analysis = analyzeSpec("");
    expect(analysis.reasons).toEqual(["Phase 0 is the baseline"]);
  });
});

// --- helper: minimal idle state for command fixtures ---
function makeEmptyState() {
  return {
    phase: "idle" as const,
    round: 0,
    specPath: "",
    language: "go" as const,
    buildTool: "maven" as const,
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
  coverageThreshold: 80,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle" as const,
    justTransitioned: false,
    negotiateReprompted: false};
}
