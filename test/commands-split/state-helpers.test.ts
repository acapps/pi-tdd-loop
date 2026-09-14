// Contract tests for the extracted shared state helpers —
// internal/refactor-commands-split.md (Target Structure, Findings Log row 2).
//
// src/state-helpers.ts is a LEAF module: it must exist, must export exactly
// the three shared helpers, and must import only from src/types.ts
// (never from src/commands/* — the no-sibling-import rule).
//
// Behavior is pinned VERBATIM from the current src/commands.ts (pure
// refactor — no behavioral change).
//
// Fast + hermetic: pure functions + static file reads only. No process
// spawning, no toolchain.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resetPhaseState, isIdleOrDone, resolvePhaseArg } from "../../src/state-helpers";
import type { LoopState, Phase } from "../../src/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readRel = (p: string) => readFileSync(resolve(ROOT, p), "utf-8");

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
    round: 4,
    specPath: "internal/spec.md",
    language: "go",
    buildTool: "go",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    gateTimeoutSec: 60,
    dispute: { status: "filed", filer: "writer", claim: "test is wrong" },
    disputeCount: 2,
    turnsThisPhase: 3,
    lastProposal: "old proposal",
    lastPhase: "A",
    justTransitioned: true,
    negotiateReprompted: true,
    negotiateProposed: true,
    negotiateFeedback: "old feedback",
    ...overrides,
  };
}

// ================================================================
// Module existence + leaf-ness (spec: Module Dependencies)
// ================================================================

describe("src/state-helpers.ts — module contract", () => {
  it("exists", () => {
    expect(existsSync(resolve(ROOT, "src/state-helpers.ts"))).toBe(true);
  });

  it("imports only from leaf modules (types) — no sibling command modules", () => {
    const src = readRel("src/state-helpers.ts");
    const importLines = src
      .split("\n")
      .filter((l) => l.includes("import") || l.includes("from "));
    expect(importLines.join("\n")).not.toMatch(/commands/);
    expect(importLines.join("\n")).not.toMatch(/state-helpers/);
  });

  it("exports all three shared helpers", () => {
    const src = readRel("src/state-helpers.ts");
    expect(src).toMatch(/export\s+function\s+resetPhaseState\b/);
    expect(src).toMatch(/export\s+function\s+isIdleOrDone\b/);
    expect(src).toMatch(/export\s+function\s+resolvePhaseArg\b/);
  });

  it("does NOT export createInitialState (cmdLoop-only — stays in commands/loop.ts)", () => {
    const src = readRel("src/state-helpers.ts");
    expect(src).not.toMatch(/export\s+function\s+createInitialState\b/);
  });
});

// ================================================================
// resetPhaseState — verbatim from src/commands.ts:88-97
// ================================================================

describe("resetPhaseState", () => {
  it("resets exactly the 8 pinned fields", () => {
    const s = makeState();
    resetPhaseState(s);
    expect(s.round).toBe(1);
    expect(s.disputeCount).toBe(0);
    expect(s.dispute).toEqual({ status: "none" });
    expect(s.negotiateReprompted).toBe(false);
    expect(s.negotiateProposed).toBe(false);
    expect(s.negotiateFeedback).toBe("");
    expect(s.justTransitioned).toBe(false);
    expect(s.turnsThisPhase).toBe(1);
  });

  it("leaves the other fields untouched (phase, specPath, lastPhase, lastProposal, branch)", () => {
    const s = makeState({ phase: "B", branch: { name: "feat", base: "main", merged: false } });
    resetPhaseState(s);
    expect(s.phase).toBe("B");
    expect(s.specPath).toBe("internal/spec.md");
    expect(s.lastPhase).toBe("A");
    expect(s.lastProposal).toBe("old proposal");
    expect(s.branch).toEqual({ name: "feat", base: "main", merged: false });
  });

  it("mutates in place (returns nothing; same object identity)", () => {
    const s = makeState();
    const result = resetPhaseState(s);
    expect(result).toBeUndefined();
    expect(s.round).toBe(1);
  });

  it("works on a minimal state with undefined dispute/negotiate fields", () => {
    const s = makeState({ dispute: undefined, negotiateProposed: undefined, negotiateFeedback: undefined });
    resetPhaseState(s);
    expect(s.dispute).toEqual({ status: "none" });
    expect(s.negotiateProposed).toBe(false);
    expect(s.negotiateFeedback).toBe("");
  });
});

// ================================================================
// isIdleOrDone — verbatim from src/commands.ts:399-401
// ================================================================

describe("isIdleOrDone", () => {
  it.each(["idle", "done"] as Phase[])("returns true for %j", (p) => {
    expect(isIdleOrDone(p)).toBe(true);
  });

  it.each(["review", "A", "negotiate", "B", "C", "escalated"] as Phase[])(
    "returns false for %j",
    (p) => {
      expect(isIdleOrDone(p)).toBe(false);
    },
  );
});

// ================================================================
// resolvePhaseArg — verbatim from src/commands.ts:99-105
// ================================================================

describe("resolvePhaseArg", () => {
  it.each([
    ["a", "A"],
    ["A", "A"],
    ["b", "B"],
    ["c", "C"],
  ] as const)("maps %j → %j", (raw, expected) => {
    expect(resolvePhaseArg(raw)).toBe(expected);
  });

  it("maps 'negotiate' → 'negotiate' (case-preserved lowercase)", () => {
    expect(resolvePhaseArg("negotiate")).toBe("negotiate");
    expect(resolvePhaseArg("Negotiate")).toBe("negotiate");
  });

  it("accepts 'review' and uppercases it", () => {
    expect(resolvePhaseArg("review")).toBe("REVIEW" as Phase);
  });

  it("accepts 'done', 'escalated', 'idle' (uppercased)", () => {
    expect(resolvePhaseArg("done")).toBe("DONE" as Phase);
    expect(resolvePhaseArg("escalated")).toBe("ESCALATED" as Phase);
    expect(resolvePhaseArg("idle")).toBe("IDLE" as Phase);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolvePhaseArg("  b  ")).toBe("B");
    expect(resolvePhaseArg("\tb\n")).toBe("B");
  });

  it.each(["", "x", "phase-a", "loop", "5"])("throws 'Invalid phase' for %j", (raw) => {
    expect(() => resolvePhaseArg(raw)).toThrow("Invalid phase");
  });

  it("throws for empty string (no args)", () => {
    expect(() => resolvePhaseArg("")).toThrow("Invalid phase");
  });
});
