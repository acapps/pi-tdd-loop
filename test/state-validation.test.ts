// Contract tests for state validation
// internal/done-loop-state-refactor.md — State validation rules

import { describe, it, expect } from "vitest";
import { createInitialState } from "../src/state-factory";
import { validateState } from "../src/state-validation";
import type { LoopState, Phase, LanguageKey, BuildTool } from "../src/types";
import type { LoopState as RefactoredState } from "../src/state-types";

// --- Helper: create state with sub-structure overrides ---

function makeState(overrides?: Partial<RefactoredState>): RefactoredState {
  return {
    ...createInitialState("spec.md", "go" as LanguageKey, "maven" as BuildTool),
    ...overrides,
  };
}

// ================================================================
// validateState — Rule 1: done phase with non-zero round
// ================================================================

describe("validateState — Rule 1: done phase with non-zero round", () => {
  it("returns error when phase is done and round is 5", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 5,
        lastPhase: null,
        turnsThisPhase: 0,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("done phase should have round 0");
  });

  it("returns error when phase is done and round is 1", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 1,
        lastPhase: null,
        turnsThisPhase: 0,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("done phase should have round 0");
  });

  it("returns no error when phase is done and round is 0", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 0,
        lastPhase: null,
        turnsThisPhase: 0,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).not.toContain("done phase should have round 0");
  });
});

// ================================================================
// validateState — Rule 2: done phase with non-zero turnsThisPhase
// ================================================================

describe("validateState — Rule 2: done phase with non-zero turnsThisPhase", () => {
  it("returns error when phase is done and turnsThisPhase is 3", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 0,
        lastPhase: null,
        turnsThisPhase: 3,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("done phase should have turnsThisPhase 0");
  });

  it("returns error when phase is done and turnsThisPhase is 1", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 0,
        lastPhase: null,
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("done phase should have turnsThisPhase 0");
  });

  it("returns no error when phase is done and turnsThisPhase is 0", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 0,
        lastPhase: null,
        turnsThisPhase: 0,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).not.toContain("done phase should have turnsThisPhase 0");
  });
});

// ================================================================
// validateState — Rule 3: escalated phase requires lastPhase B or C
// ================================================================

describe("validateState — Rule 3: escalated phase must come from B or C", () => {
  it("returns error when escalated and lastPhase is A", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 1,
        lastPhase: "A",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("escalated phase must come from B or C");
  });

  it("returns error when escalated and lastPhase is null", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 1,
        lastPhase: null,
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("escalated phase must come from B or C");
  });

  it("returns error when escalated and lastPhase is 'negotiate'", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 1,
        lastPhase: "negotiate",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("escalated phase must come from B or C");
  });

  it("returns no error when escalated and lastPhase is B", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 1,
        lastPhase: "B",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).not.toContain("escalated phase must come from B or C");
  });

  it("returns no error when escalated and lastPhase is C", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 1,
        lastPhase: "C",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).not.toContain("escalated phase must come from B or C");
  });
});

// ================================================================
// validateState — Rule 4: non-done phase requires round >= 1
// ================================================================

describe("validateState — Rule 4: non-done phase requires round >= 1", () => {
  it("returns error when phase A has round 0", () => {
    const state = makeState({
      machine: {
        phase: "A",
        round: 0,
        lastPhase: null,
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("non-done phase must have round >= 1");
  });

  it("returns error when phase B has round 0", () => {
    const state = makeState({
      machine: {
        phase: "B",
        round: 0,
        lastPhase: "A",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("non-done phase must have round >= 1");
  });

  it("returns no error when phase A has round 1", () => {
    const state = makeState({
      machine: {
        phase: "A",
        round: 1,
        lastPhase: null,
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).not.toContain("non-done phase must have round >= 1");
  });

  it("returns no error when phase C has round 5", () => {
    const state = makeState({
      machine: {
        phase: "C",
        round: 5,
        lastPhase: "B",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).not.toContain("non-done phase must have round >= 1");
  });
});

// ================================================================
// validateState — Rule 5: non-done phase requires turnsThisPhase >= 1
// ================================================================

describe("validateState — Rule 5: non-done phase requires turnsThisPhase >= 1", () => {
  it("returns error when phase A has turnsThisPhase 0", () => {
    const state = makeState({
      machine: {
        phase: "A",
        round: 1,
        lastPhase: null,
        turnsThisPhase: 0,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("non-done phase must have turnsThisPhase >= 1");
  });

  it("returns error when phase B has turnsThisPhase 0", () => {
    const state = makeState({
      machine: {
        phase: "B",
        round: 1,
        lastPhase: "A",
        turnsThisPhase: 0,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("non-done phase must have turnsThisPhase >= 1");
  });

  it("returns no error when phase A has turnsThisPhase 1", () => {
    const state = makeState({
      machine: {
        phase: "A",
        round: 1,
        lastPhase: null,
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).not.toContain("non-done phase must have turnsThisPhase >= 1");
  });
});

// ================================================================
// validateState — dispute mode + count transient invariant (NOT enforced)
// ================================================================

describe("validateState — dispute mode + count transient invariant", () => {
  it("does NOT flag dispute mode true with count 0 (transient state)", () => {
    // Per spec: "dispute.mode + dispute.count == 0 is NOT an error"
    const state = makeState({
      dispute: {
        mode: true,
        count: 0,
        max: 3,
        awaitFix: false,
        awaitReview: false,
      },
    });
    const errors = validateState(state);
    // Should not contain any dispute-related error
    expect(errors.some(e => e.includes("dispute"))).toBe(false);
  });

  it("does NOT flag dispute mode true with count 0 in any phase", () => {
    for (const phase of ["A", "B", "C"] as Phase[]) {
      const state = makeState({
        machine: {
          ...makeState().machine,
          phase,
          lastPhase: phase === "A" ? null : "A",
        },
        dispute: {
          mode: true,
          count: 0,
          max: 3,
          awaitFix: false,
          awaitReview: false,
        },
      });
      const errors = validateState(state);
      expect(errors.some(e => e.includes("dispute"))).toBe(false);
    }
  });
});

// ================================================================
// validateState — multiple errors collected
// ================================================================

describe("validateState — multiple errors", () => {
  it("collects both round and turnsThisPhase errors for done phase", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 5,
        lastPhase: null,
        turnsThisPhase: 3,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("done phase should have round 0");
    expect(errors).toContain("done phase should have turnsThisPhase 0");
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("collects escalated error and round error together", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 0,
        lastPhase: "A",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toContain("escalated phase must come from B or C");
    expect(errors).toContain("non-done phase must have round >= 1");
  });
});

// ================================================================
// validateState — valid states return empty array
// ================================================================

describe("validateState — valid states", () => {
  it("returns empty array for initial state (phase A, round 1)", () => {
    const state = makeState();
    const errors = validateState(state);
    expect(errors).toEqual([]);
  });

  it("returns empty array for done state with round 0 and turnsThisPhase 0", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 0,
        lastPhase: "C",
        turnsThisPhase: 0,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toEqual([]);
  });

  it("returns empty array for escalated state from B", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 1,
        lastPhase: "B",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toEqual([]);
  });

  it("returns empty array for escalated state from C", () => {
    const state = makeState({
      machine: {
        phase: "escalated",
        round: 1,
        lastPhase: "C",
        turnsThisPhase: 1,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors).toEqual([]);
  });
});

// ================================================================
// validateState — return type
// ================================================================

describe("validateState — return type", () => {
  it("returns string array", () => {
    const state = makeState();
    const errors = validateState(state);
    expect(Array.isArray(errors)).toBe(true);
    for (const err of errors) {
      expect(typeof err).toBe("string");
    }
  });

  it("returns non-empty array when validation fails", () => {
    const state = makeState({
      machine: {
        phase: "done",
        round: 5,
        lastPhase: null,
        turnsThisPhase: 3,
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxTurnsPerPhase: 5,
        justTransitioned: false,
        negotiateReprompted: false,
      },
    });
    const errors = validateState(state);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ================================================================
// Edge cases: all Phase values
// ================================================================

describe("validateState — all Phase values", () => {
  const validMachine = {
    round: 1,
    lastPhase: null as Phase | null,
    turnsThisPhase: 1,
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxTurnsPerPhase: 5,
    justTransitioned: false,
    negotiateReprompted: false,
  };

  it("accepts 'review' phase (round 1, turnsThisPhase 1)", () => {
    const state = makeState({ machine: { ...validMachine, phase: "review", lastPhase: null } });
    expect(validateState(state)).toEqual([]);
  });

  it("accepts 'idle' phase (round 1, turnsThisPhase 1)", () => {
    const state = makeState({ machine: { ...validMachine, phase: "idle", lastPhase: null } });
    expect(validateState(state)).toEqual([]);
  });

  it("accepts 'negotiate' phase (round 1, turnsThisPhase 1)", () => {
    const state = makeState({ machine: { ...validMachine, phase: "negotiate", lastPhase: "A" } });
    expect(validateState(state)).toEqual([]);
  });
});
