// Contract tests for state factory
// internal/done-loop-state-refactor.md — State factory with validation

import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/state-factory";
import type { Phase, LanguageKey, BuildTool } from "../src/types";

// ================================================================
// createInitialState — happy path
// ================================================================

describe("createInitialState", () => {
  it("creates valid initial state with default coverage", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);

    // Identity
    expect(state.identity.specPath).toBe("spec.md");
    expect(state.identity.language).toBe("go");
    expect(state.identity.buildTool).toBe("maven");
    expect(state.identity.coverageThreshold).toBe(80); // default

    // Machine
    expect(state.machine.phase).toBe("A");
    expect(state.machine.round).toBe(1);
    expect(state.machine.lastPhase).toBeNull();
    expect(state.machine.turnsThisPhase).toBe(1);
    expect(state.machine.maxA).toBe(3);
    expect(state.machine.maxNegotiate).toBe(3);
    expect(state.machine.maxB).toBe(5);
    expect(state.machine.maxC).toBe(3);
    expect(state.machine.maxTurnsPerPhase).toBe(5);
    expect(state.machine.justTransitioned).toBe(false);
    expect(state.machine.negotiateReprompted).toBe(false);

    // Negotiation
    expect(state.negotiation.lastProposal).toBe("");

    // Dispute
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.count).toBe(0);
    expect(state.dispute.max).toBe(3);
    expect(state.dispute.awaitFix).toBe(false);
    expect(state.dispute.awaitReview).toBe(false);

    // Gates
    expect(state.gates.lastResult).toBeUndefined();

    // Phase 0
    expect(state.phase0.awaitingReview).toBe(false);
    expect(state.phase0.findings).toBeUndefined();
  });

  it("creates valid initial state with custom coverage", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "gradle" as BuildTool, 90);
    expect(state.identity.coverageThreshold).toBe(90);
  });

  it("uses all supported language keys", () => {
    for (const lang of ["go", "java", "typescript"] as LanguageKey[]) {
      const state = createInitialState("spec.md", lang, "maven" as BuildTool);
      expect(state.identity.language).toBe(lang);
    }
  });

  it("uses all supported build tools", () => {
    for (const tool of ["maven", "gradle", "go"] as BuildTool[]) {
      const state = createInitialState("spec.md", "go" as LanguageKey, tool);
      expect(state.identity.buildTool).toBe(tool);
    }
  });

  it("returns state with all 6 sub-structures", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.identity).toBeDefined();
    expect(state.machine).toBeDefined();
    expect(state.negotiation).toBeDefined();
    expect(state.dispute).toBeDefined();
    expect(state.gates).toBeDefined();
    expect(state.phase0).toBeDefined();
  });
});

// ================================================================
// createInitialState — initial values match spec defaults
// ================================================================

describe("createInitialState — default values", () => {
  it("phase starts as 'A'", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.phase).toBe("A");
  });

  it("round starts as 1", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.round).toBe(1);
  });

  it("lastPhase starts as null (not 'A')", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.lastPhase).toBeNull();
  });

  it("turnsThisPhase starts as 1", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.turnsThisPhase).toBe(1);
  });

  it("maxA defaults to 3", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.maxA).toBe(3);
  });

  it("maxNegotiate defaults to 3", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.maxNegotiate).toBe(3);
  });

  it("maxB defaults to 5", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.maxB).toBe(5);
  });

  it("maxC defaults to 3", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.maxC).toBe(3);
  });

  it("maxTurnsPerPhase defaults to 5", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.maxTurnsPerPhase).toBe(5);
  });

  it("dispute max defaults to 3", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.dispute.max).toBe(3);
  });

  it("transient flags start as false", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.machine.justTransitioned).toBe(false);
    expect(state.machine.negotiateReprompted).toBe(false);
  });

  it("dispute flags start as false", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.dispute.mode).toBe(false);
    expect(state.dispute.awaitFix).toBe(false);
    expect(state.dispute.awaitReview).toBe(false);
  });

  it("lastProposal starts as empty string", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.negotiation.lastProposal).toBe("");
  });

  it("dispute count starts as 0", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.dispute.count).toBe(0);
  });

  it("gates start empty (no lastResult)", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.gates.lastResult).toBeUndefined();
  });

  it("phase0 awaitingReview starts as false", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.phase0.awaitingReview).toBe(false);
  });

  it("phase0 findings starts undefined", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.phase0.findings).toBeUndefined();
  });
});

// ================================================================
// createInitialState — coverage edge cases
// ================================================================

describe("createInitialState — coverage edge cases", () => {
  it("defaults coverage to 80 when undefined", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.identity.coverageThreshold).toBe(80);
  });

  it("defaults coverage to 80 when coverage parameter omitted", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.identity.coverageThreshold).toBe(80);
  });

  it("uses 0 when explicitly passed", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool, 0);
    expect(state.identity.coverageThreshold).toBe(0);
  });

  it("uses custom coverage value 100", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool, 100);
    expect(state.identity.coverageThreshold).toBe(100);
  });

  it("uses custom coverage value 50", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool, 50);
    expect(state.identity.coverageThreshold).toBe(50);
  });
});

// ================================================================
// createInitialState — specPath edge cases
// ================================================================

describe("createInitialState — specPath edge cases", () => {
  it("accepts empty string specPath", () => {
    const state = createInitialState("", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.identity.specPath).toBe("");
  });

  it("accepts single character specPath", () => {
    const state = createInitialState("x", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.identity.specPath).toBe("x");
  });

  it("accepts path with directories", () => {
    const state = createInitialState("/path/to/deep/nested/spec.md", "go" as LanguageKey, "maven" as BuildTool);
    expect(state.identity.specPath).toBe("/path/to/deep/nested/spec.md");
  });
});

// ================================================================
// createInitialState — no skipPhase0 in output
// ================================================================

describe("createInitialState — skipPhase0 removed", () => {
  it("does not include skipPhase0 in state", () => {
    const state = createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool);
    // In the refactored state, skipPhase0 is removed entirely
    // It should not appear in any sub-structure
    const allKeys = [
      ...Object.keys(state.identity),
      ...Object.keys(state.machine),
      ...Object.keys(state.negotiation),
      ...Object.keys(state.dispute),
      ...Object.keys(state.gates),
      ...Object.keys(state.phase0),
    ];
    expect(allKeys).not.toContain("skipPhase0");
  });
});
