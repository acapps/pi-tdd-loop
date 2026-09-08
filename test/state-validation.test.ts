// Contract tests for the flat-state validator — internal/refactor-state-model-divergence.md
//
// validateLoopState(data: unknown): data is LoopState (returns false, never throws).
// Decision table (5 rows) + shape rejections + live-builder fixtures.
// 0 old sub-structure tests kept — every old assertion targeted state.machine.*.
//
// NOTE: the two pinned call sites (commit.ts, events/session-start.ts) live in
// test/state-commit.test.ts — this file covers the validator itself only.

import { describe, it, expect } from "vitest";
import { PHASES, validateLoopState } from "../src/state-validation";
import type { LoopState, Phase, LanguageKey, BuildTool } from "../src/types";

// ================================================================
// Live-builder fixtures — the validator must ACCEPT the machine's
// real states. These mirror the actual outputs of the live builders
// (transitions.ts:markDone / escalateTo, index.ts initial state).
// ================================================================

/** Minimal valid state: phase A, round 1 (mirrors commands.ts:createInitialState). */
function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    phase: "A",
    round: 1,
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
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides};
}

/** Live initial state — index.ts (idle, round 0, turnsThisPhase 0). */
function makeInitialState(): LoopState {
  return {
    phase: "idle",
    round: 0,
    specPath: "",
    language: "go",
    buildTool: "maven",
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
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false};
}

/** markDone(makeState({phase:"C"})) — transitions.ts keeps round, sets lastPhase to source phase, turnsThisPhase 1. */
function markDoneFixture(sourcePhase: Phase = "C"): LoopState {
  return makeState({ phase: "done", lastPhase: sourcePhase, round: 3, turnsThisPhase: 1 });
}

/** escalateTo(state) — transitions.ts keeps round, lastPhase = source phase. */
function escalateFixture(from: Phase): LoopState {
  return makeState({ phase: "escalated", lastPhase: from, turnsThisPhase: 1 });
}

// ================================================================
// PHASES constant
// ================================================================

describe("PHASES", () => {
  it("exports the 8 live phases in order", () => {
    expect(PHASES).toEqual(["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"]);
  });

  it("has exactly 8 entries", () => {
    expect(PHASES.length).toBe(8);
  });
});

// ================================================================
// Shape check — non-object inputs (edge: empty, undefined, null)
// ================================================================

describe("validateLoopState — shape: non-object inputs", () => {
  it("returns false for undefined", () => {
    expect(validateLoopState(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(validateLoopState(null)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(validateLoopState("")).toBe(false);
  });

  it("returns false for a plain string", () => {
    expect(validateLoopState("done")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(validateLoopState(42)).toBe(false);
  });

  it("returns false for a boolean", () => {
    expect(validateLoopState(true)).toBe(false);
  });

  it("returns false for an array (object, but not a state shape)", () => {
    expect(validateLoopState([])).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(validateLoopState({})).toBe(false);
  });

  it("never throws on any of the above", () => {
    expect(() => {
      for (const v of [undefined, null, "", 0, false, [], {}]) {
        validateLoopState(v);
      }
    }).not.toThrow();
  });
});

// ================================================================
// Shape check — wrong types / missing fields / wrong enums
// ================================================================

describe("validateLoopState — shape: field types and enums", () => {
  it.each(["go", "java", "typescript"] as LanguageKey[])(
    "accepts language %s",
    (language) => {
      expect(validateLoopState(makeState({ language }))).toBe(true);
    }
  );

  it.each(["rust", "python", "", "GO"] as string[])(
    "rejects language %j",
    (language) => {
      expect(validateLoopState(makeState({ language: language as LanguageKey }))).toBe(false);
    }
  );

  it.each(["maven", "gradle", "go"] as BuildTool[])(
    "accepts buildTool %s",
    (buildTool) => {
      expect(validateLoopState(makeState({ buildTool }))).toBe(true);
    }
  );

  it.each(["npm", "cargo", ""] as string[])(
    "rejects buildTool %j",
    (buildTool) => {
      expect(validateLoopState(makeState({ buildTool: buildTool as BuildTool }))).toBe(false);
    }
  );

  it.each(["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"] as Phase[])(
    "accepts a well-formed state in phase %s",
    (phase) => {
      const valid = {
        review: makeState({ phase: "review", lastPhase: "idle" }),
        A: makeState({ phase: "A" }),
        negotiate: makeState({ phase: "negotiate", lastPhase: "A" }),
        B: makeState({ phase: "B", lastPhase: "A" }),
        C: makeState({ phase: "C", lastPhase: "B" }),
        done: makeState({ phase: "done", lastPhase: "C" }),
        escalated: escalateFixture("C"),
        idle: makeInitialState()}[phase];
      expect(validateLoopState(valid)).toBe(true);
    }
  );

  it("rejects an unknown phase", () => {
    expect(validateLoopState(makeState({ phase: "D" as Phase }))).toBe(false);
  });

  it("rejects a missing phase", () => {
    const { phase: _p, ...rest } = makeState();
    expect(validateLoopState(rest)).toBe(false);
  });

  it.each([
    "round",
    "turnsThisPhase",
    "maxA",
    "maxNegotiate",
    "maxB",
    "maxC",
    "maxDispute",
    "maxTurnsPerPhase",
    "coverageThreshold",
    "disputeCount",
  ] as const)("rejects when numeric field %s is a string", (field) => {
    expect(validateLoopState(makeState({ [field]: "3" } as unknown as Partial<LoopState>))).toBe(false);
  });

  it.each([
    "justTransitioned",
    "negotiateReprompted",
  ] as const)("rejects when boolean field %s is a number", (field) => {
    expect(validateLoopState(makeState({ [field]: 1 } as Partial<LoopState>))).toBe(false);
  });

  it.each(["specPath", "lastProposal"] as const)(
    "rejects when string field %s is a number",
    (field) => {
      expect(validateLoopState(makeState({ [field]: 7 } as Partial<LoopState>))).toBe(false);
    }
  );

  it("rejects when a required boolean is missing", () => {
    const { justTransitioned: _x, ...rest } = makeState();
    expect(validateLoopState(rest)).toBe(false);
  });

  it("rejects when specPath is missing", () => {
    const { specPath: _x, ...rest } = makeState();
    expect(validateLoopState(rest)).toBe(false);
  });

  it("accepts a valid state with all optional fields absent (single required set)", () => {
    expect(validateLoopState(makeState())).toBe(true);
  });

  it("accepts optional negotiate fields when present and correctly typed", () => {
    expect(
      validateLoopState(makeState({ negotiateProposed: true, negotiateFeedback: "agree" }))
    ).toBe(true);
  });

  it("accepts optional fields with undefined values (undefined ≡ absent)", () => {
    expect(
      validateLoopState(makeState({ negotiateProposed: undefined, negotiateFeedback: undefined }))
    ).toBe(true);
  });

  it("rejects optional negotiateProposed when a string", () => {
    expect(validateLoopState(makeState({ negotiateProposed: "yes" } as unknown as Partial<LoopState>))).toBe(false);
  });

  it("rejects optional negotiateFeedback when a number", () => {
    expect(validateLoopState(makeState({ negotiateFeedback: 5 } as unknown as Partial<LoopState>))).toBe(false);
  });

  it("accepts empty-string specPath and lastProposal (strings are strings)", () => {
    expect(validateLoopState(makeState({ specPath: "", lastProposal: "" }))).toBe(true);
  });
});

// ================================================================
// Invariant row 1: done ⇒ no constraint on round (markDone keeps it)
// Live-builder fixture: markDone(makeState({phase:"C"}))
// ================================================================

describe("validateLoopState — row 1: done keeps round (live markDone output accepted)", () => {
  it("accepts markDone output: done with round 3", () => {
    const state = markDoneFixture("C");
    expect(state.phase).toBe("done");
    expect(state.round).toBe(3); // markDone does not zero round
    expect(validateLoopState(state)).toBe(true);
  });

  it("accepts done with round 5", () => {
    expect(validateLoopState(makeState({ phase: "done", round: 5, lastPhase: "C" }))).toBe(true);
  });

  it("accepts done with round 1", () => {
    expect(validateLoopState(makeState({ phase: "done", round: 1, lastPhase: "B" }))).toBe(true);
  });

  it("accepts done with round 0 (no floor either — row 1 pins: NO constraint on round in done)", () => {
    expect(validateLoopState(makeState({ phase: "done", round: 0, lastPhase: "C" }))).toBe(true);
  });
});

// ================================================================
// Invariant row 2: escalated ⇒ lastPhase ∈ {A, negotiate, B, C}
// Live-builder fixture: escalateTo(state, "A")
// ================================================================

describe("validateLoopState — row 2: escalated origin (live escalateTo output accepted)", () => {
  it("accepts the A-escalation state: escalated with lastPhase A", () => {
    const state = escalateFixture("A");
    expect(state.phase).toBe("escalated");
    expect(state.lastPhase).toBe("A");
    expect(validateLoopState(state)).toBe(true);
  });

  it("accepts the negotiate-escalation state: escalated with lastPhase negotiate", () => {
    expect(validateLoopState(escalateFixture("negotiate"))).toBe(true);
  });

  it.each(["A", "negotiate", "B", "C"] as Phase[])(
    "accepts escalated with lastPhase %s",
    (lastPhase) => {
      expect(validateLoopState(escalateFixture(lastPhase))).toBe(true);
    }
  );

  it("rejects escalated with lastPhase done", () => {
    expect(validateLoopState(escalateFixture("done"))).toBe(false);
  });

  it("rejects escalated with lastPhase idle", () => {
    expect(validateLoopState(escalateFixture("idle"))).toBe(false);
  });

  it("rejects escalated with lastPhase review", () => {
    expect(validateLoopState(escalateFixture("review"))).toBe(false);
  });
});

// ================================================================
// Invariant row 3: turnsThisPhase >= 1 only in {review, A, negotiate, B, C}
// Live-builder fixture: the index.ts initial state (idle, turnsThisPhase 0)
// ================================================================

describe("validateLoopState — row 3: idle counter (live initial state accepted)", () => {
  it("accepts the index.ts initial state literal (idle, round 0, turnsThisPhase 0)", () => {
    const state = makeInitialState();
    expect(state.phase).toBe("idle");
    expect(state.turnsThisPhase).toBe(0);
    expect(validateLoopState(state)).toBe(true);
  });

  it("accepts idle with turnsThisPhase 0 and round 0 (Q2: lastPhase idle unconstrained)", () => {
    expect(validateLoopState(makeInitialState())).toBe(true);
  });

  it.each(["review", "A", "negotiate", "B", "C"] as Phase[])(
    "rejects turnsThisPhase 0 in phase %s",
    (phase) => {
      expect(validateLoopState(makeState({ phase, lastPhase: "A", turnsThisPhase: 0 }))).toBe(false);
    }
  );

  it.each(["review", "A", "negotiate", "B", "C"] as Phase[])(
    "accepts turnsThisPhase 1 in phase %s",
    (phase) => {
      expect(validateLoopState(makeState({ phase, lastPhase: "A", turnsThisPhase: 1 }))).toBe(true);
    }
  );

  it("accepts escalated with turnsThisPhase 0 (the >= 1 rule does not apply to escalated)", () => {
    expect(
      validateLoopState(makeState({ phase: "escalated", lastPhase: "B", turnsThisPhase: 0 }))
    ).toBe(true);
  });

  it("accepts done with turnsThisPhase 0", () => {
    expect(
      validateLoopState(makeState({ phase: "done", lastPhase: "C", turnsThisPhase: 0 }))
    ).toBe(true);
  });
});

// ================================================================
// Invariant row 4: round >= 1 in all phases except idle
// ================================================================

describe("validateLoopState — row 4: round floor", () => {
  it("accepts idle with round 0", () => {
    expect(validateLoopState(makeInitialState())).toBe(true);
  });

  it.each(["review", "A", "negotiate", "B", "C", "escalated"] as Phase[])(
    "rejects round 0 in phase %s",
    (phase) => {
      const base =
        phase === "escalated"
          ? escalateFixture("B")
          : makeState({ phase, lastPhase: "A" });
      expect(validateLoopState({ ...base, round: 0 })).toBe(false);
    }
  );

  it.each(["review", "A", "negotiate", "B", "C", "done", "escalated"] as Phase[])(
    "accepts round 1 in phase %s",
    (phase) => {
      const base =
        phase === "escalated"
          ? escalateFixture("B")
          : phase === "done"
            ? makeState({ phase: "done", lastPhase: "C" })
            : makeState({ phase, lastPhase: "A" });
      expect(validateLoopState({ ...base, round: 1 })).toBe(true);
    }
  );
});

// ================================================================
// Invariant row 5: disputeCount <= maxDispute
// ================================================================

describe("validateLoopState — row 5: dispute budget", () => {
  it("accepts disputeCount 0 with maxDispute 3", () => {
    expect(validateLoopState(makeState({ disputeCount: 0, maxDispute: 3 }))).toBe(true);
  });

  it("accepts disputeCount at the boundary (3 <= 3)", () => {
    expect(validateLoopState(makeState({ disputeCount: 3, maxDispute: 3 }))).toBe(true);
  });

  it("rejects disputeCount one over the budget (4 > 3)", () => {
    expect(validateLoopState(makeState({ disputeCount: 4, maxDispute: 3 }))).toBe(false);
  });

  it("rejects disputeCount over a zero budget", () => {
    expect(validateLoopState(makeState({ disputeCount: 1, maxDispute: 0 }))).toBe(false);
  });

  it("accepts disputeCount 0 with a zero budget (0 <= 0)", () => {
    expect(validateLoopState(makeState({ disputeCount: 0, maxDispute: 0 }))).toBe(true);
  });

  it("holds under the resolve-time increment semantics too (count set at resolution)", () => {
    // bug-dispute-reload-evaporation.md moves the increment to resolution —
    // the inequality must hold under both semantics.
    expect(validateLoopState(makeState({ disputeCount: 2, maxDispute: 3 }))).toBe(true);
  });
});

// ================================================================
// done ⇒ lastPhase ∈ {A, negotiate, B, C} (NEW rule, pinned)
// ================================================================

describe("validateLoopState — done origin", () => {
  it.each(["A", "negotiate", "B", "C"] as Phase[])(
    "accepts done with lastPhase %s",
    (lastPhase) => {
      expect(validateLoopState(makeState({ phase: "done", lastPhase, turnsThisPhase: 1 }))).toBe(true);
    }
  );

  it("rejects done with lastPhase idle", () => {
    expect(validateLoopState(makeState({ phase: "done", lastPhase: "idle", turnsThisPhase: 0 }))).toBe(false);
  });

  it("rejects done with lastPhase review", () => {
    expect(validateLoopState(makeState({ phase: "done", lastPhase: "review", turnsThisPhase: 1 }))).toBe(false);
  });
});

// ================================================================
// Q2: lastPhase idle in non-escalated, non-done states is accepted
// ================================================================

describe("validateLoopState — Q2: lastPhase idle unconstrained", () => {
  it("accepts review with lastPhase idle (fresh /loop start)", () => {
    expect(
      validateLoopState(makeState({ phase: "review", lastPhase: "idle", turnsThisPhase: 1 }))
    ).toBe(true);
  });

  it("accepts A with lastPhase idle", () => {
    expect(validateLoopState(makeState({ phase: "A", lastPhase: "idle", turnsThisPhase: 1 }))).toBe(true);
  });
});

// ================================================================
// Multiple failures + return contract
// ================================================================

describe("validateLoopState — return contract", () => {
  it("returns a boolean (type guard), never an error list", () => {
    expect(typeof validateLoopState(makeState())).toBe("boolean");
    expect(typeof validateLoopState(null)).toBe("boolean");
  });

  it("returns false (not throw) when several rules fail at once", () => {
    expect(
      validateLoopState(
        makeState({
          phase: "escalated" as Phase,
          lastPhase: "idle" as Phase, // row 2 fail
          round: 0, // row 4 fail
          turnsThisPhase: -1, // row 3 fail (negative)
          disputeCount: 9, // row 5 fail
        })
      )
    ).toBe(false);
  });

  it("returns false for a state with every required field wrong-typed", () => {
    expect(
      validateLoopState({
        phase: 1,
        round: "one",
        specPath: null,
        language: "cobol",
        buildTool: "make",
        maxA: null,
        maxNegotiate: null,
        maxB: null,
        maxC: null,
        maxDispute: null,
        maxTurnsPerPhase: null,
        coverageThreshold: null,
        disputeCount: null,
        turnsThisPhase: null,
        lastProposal: 0,
        lastPhase: null,
        justTransitioned: null,
        negotiateReprompted: null})
    ).toBe(false);
  });

  it("accepts a state with extra unknown fields (forward compatibility)", () => {
    expect(validateLoopState({ ...makeState(), someFutureField: true })).toBe(true);
  });
});
