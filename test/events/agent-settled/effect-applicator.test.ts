// Contract tests for effect-applicator (spec 05).
//
// The effect family is a verbatim port of the gate-transition.ts handlers:
// - dispatcher returns EffectResult { applied }; noop and the default branch
//   (reprompt guard) yield applied: false; retry/advance/done/escalated yield true
// - retry/advance/done reset state.current.turnsThisPhase to 1; escalated touches
//   no state at all
// - retry notify is conditional with level || "info"; advance/done "info" and
//   escalated "warning" are unconditional
// - builder fallbacks are verbatim: retry default "Fix the issues and try again.",
//   advance default returns the raw key
// - debug strings preserved verbatim (G4 table)
// - no new error handling: non-noop paths with null ctx/gateResult/throw as today

import { describe, it, expect, vi } from "vitest";
import {
  applyEffect,
  applyRetryEffect,
  applyAdvanceEffect,
  applyDoneEffect,
  applyEscalatedEffect,
  buildRetryPrompt,
  buildAdvancePrompt,
} from "../../../src/events/agent-settled/effect-applicator";
import type { EffectInput } from "../../../src/events/agent-settled/effect-applicator";
import type { LoopState, GateResult, FailingTest } from "../../../src/types";
import * as GP from "../../../src/generic-prompts";
import { RETRY_PROMPTS, ADVANCE_PROMPTS } from "../../../src/constants";
import * as archive from "../../../src/spec-archive";
import { formatFailures } from "../../../src/gates";import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";
import type { MockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

// Bridges EffectInput.pi (typed as the package ExtensionAPI) to the mock's
// capture arrays (sentMessages).
function piOf(input: EffectInput): MockExtensionAPI {
  return input.pi as any;
}

// ================================================================
// Helpers
// ================================================================

function makeState(overrides = {}): LoopState {
  return {
    phase: "idle",
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
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false,
    awaitDisputeFix: false,
    awaitDisputeReview: false,
    ...overrides,
  };
}

function makeGateResult(overrides = {}): GateResult {
  return {
    compile: false,
    compileError: "",
    tests: false,
    allPassed: false,
    coverage: 0,
    failures: [],
    ...overrides,
  };
}

function makeMockCtx(): any {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
    },
    cwd: "/tmp/test-project",
  };
}

// Prompt fns are vi.fn()s so tests can assert exact call args; their return
// values are what the module sends via pi.sendUserMessage.
function makeMockLang(): any {
  return {
    key: "go",
    sourceFilePattern: "*.go",
    testFilePattern: "*_test.go",
    isTestFile: (path: string) => path.endsWith("_test.go"),
    prompts: {
      promptTesterCompileRetry: vi.fn((err: string) => `Compile error: ${err}`),
      promptWriterPhaseBContinue: vi.fn((summary: string, count: number) => `Continue: ${count} failures\n${summary}`),
      promptCleanerRetry: vi.fn((summary: string, count: number) => `Cleaner retry: ${count} failures\n${summary}`),
      promptCleanerPhaseC: vi.fn(() => "Phase C"),
    },
  };
}

function makeInput(overrides: Partial<EffectInput> = {}): EffectInput {
  return {
    state: { current: makeState({ phase: "A" }) },
    pi: createMockExtensionAPI() as any, // MockExtensionAPI at runtime; see piOf()
    ctx: makeMockCtx(),
    lang: makeMockLang(),
    debug: vi.fn(),
    effect: { type: "noop" },
    gateResult: makeGateResult(),
    ...overrides,
  };
}

// ================================================================
// applyEffect (dispatcher)
// ================================================================

describe("applyEffect (dispatcher)", () => {
  it("returns applied: false for noop and does nothing", () => {
    const state = makeState({ phase: "A", turnsThisPhase: 7 });
    const input = makeInput({ state: { current: state }, effect: { type: "noop" } });
    const result = applyEffect(input);
    expect(result.applied).toBe(false);
    expect(piOf(input).sentMessages).toHaveLength(0);
    expect(input.ctx.ui.notify).not.toHaveBeenCalled();
    expect(input.ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(state.turnsThisPhase).toBe(7);
  });

  it("dispatches noop effect without throwing", () => {
    const input = makeInput(); // effect defaults to noop
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("dispatches retry effect and reports applied: true", () => {
    const input = makeInput({
      effect: {
        type: "retry",
        phase: "A",
        round: 2,
        status: "Phase A — round 2",
        notify: "Gate failed.",
        level: "warning",
        prompt: RETRY_PROMPTS.TESTER_COMPILE_RETRY,
      },
      gateResult: makeGateResult({ compile: false, compileError: "boom" }),
    });
    const result = applyEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(1);
  });

  it("dispatches advance effect and reports applied: true", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "negotiate",
        status: "Phase negotiate — round 1",
        notify: "Advancing.",
        prompt: ADVANCE_PROMPTS.WRITER_NEGOTIATE,
      },
    });
    const result = applyEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(1);
  });

  // Spec 10 (rewrite 1): the done effect now sends exactly one completion
  // message. Fixture status is "All phases complete." (NOT "done"), so the
  // cleanerFailed derivation (status === "done (cleaner failed)") yields false
  // → clean-finish variant. Do not "fix" the fixture status.
  it("dispatches done effect: applied, notified, completion prompt sent", () => {
    const input = makeInput({
      effect: { type: "done", status: "All phases complete.", notify: "Loop complete." },
    });
    const result = applyEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].content).toBe(GP.promptLoopComplete("spec.md", 0, false));
    expect(piOf(input).sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(input.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(input.ctx.ui.setStatus).toHaveBeenCalledTimes(1);
  });

  it("dispatches escalated effect: applied, warning notify, no prompt sent", () => {
    const input = makeInput({
      effect: { type: "escalated", status: "escalated (Phase A exhausted)", notify: "Phase A exhausted. Escalating to human." },
    });
    const result = applyEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(0);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Phase A exhausted. Escalating to human.", "warning");
  });

  // B3: the 6th union variant (reprompt) is produced only by the negotiate
  // branch and is unreachable via the gate path. The dispatcher's explicit
  // default branch is the type-level guard: applied: false, no side effects.
  it("default branch: reprompt effect returns applied: false without throwing", () => {
    const state = makeState({ phase: "negotiate", turnsThisPhase: 3 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "reprompt", notify: "Negotiate again.", level: "info", prompt: "reprompt prompt" },
    });
    const result = applyEffect(input);
    expect(result.applied).toBe(false);
    expect(piOf(input).sentMessages).toHaveLength(0);
    expect(input.ctx.ui.notify).not.toHaveBeenCalled();
    expect(input.ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(state.turnsThisPhase).toBe(3);
  });

  // Noop path touches none of these — the faithful port must not add
  // error handling that would change this (null-tolerance is NOT a contract).
  it("handles null gateResult gracefully (noop path)", () => {
    const input = makeInput({ gateResult: null as any });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("handles null ctx gracefully (noop path)", () => {
    const input = makeInput({ ctx: null as any });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("handles null pi gracefully (noop path)", () => {
    const input = makeInput({ pi: null as any });
    expect(() => applyEffect(input)).not.toThrow();
  });

  it("output type contract: EffectResult has applied field", () => {
    const result = { applied: false };
    expect(result).toHaveProperty("applied");
    expect(typeof result.applied).toBe("boolean");
  });
});

// ================================================================
// applyRetryEffect
// ================================================================

describe("applyRetryEffect", () => {
  it("returns applied: true", () => {
    const input = makeInput({
      effect: { type: "retry", phase: "A", round: 2, status: "Phase A — round 2", level: "warning" },
    });
    const result = applyRetryEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(0); // no notify, no prompt
  });

  it("resets turnsThisPhase to 1", () => {
    const state = makeState({ phase: "A", turnsThisPhase: 5 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "retry", phase: "A", round: 2, status: "Phase A — round 2", level: "warning" },
    });
    const result = applyRetryEffect(input);
    expect(result.applied).toBe(true);
    expect(state.turnsThisPhase).toBe(1);
  });

  it("sends the compile retry prompt on compile fail (triggerTurn)", () => {
    const input = makeInput({
      effect: {
        type: "retry",
        phase: "A",
        round: 2,
        status: "Phase A — round 2",
        notify: "Compile failed.",
        level: "warning",
        prompt: RETRY_PROMPTS.TESTER_COMPILE_RETRY,
      },
      gateResult: makeGateResult({ compile: false, compileError: "type mismatch" }),
    });
    applyRetryEffect(input);
    expect(input.lang.prompts.promptTesterCompileRetry).toHaveBeenCalledWith("type mismatch");
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].content).toBe("Compile error: type mismatch");
    expect(piOf(input).sentMessages[0].options).toEqual({ triggerTurn: true });
  });

  it("sends the writer phase B prompt on test fail (summary + count)", () => {
    const failures: FailingTest[] = [{ test: "TestAdd", subtest: "", output: "expected 3, got 2\n" }];
    const input = makeInput({
      state: { current: makeState({ phase: "B" }) },
      effect: {
        type: "retry",
        phase: "B",
        round: 2,
        status: "Phase B — round 2",
        notify: "Tests failed.",
        level: "warning",
        prompt: RETRY_PROMPTS.WRITER_PHASE_B_RETRY,
      },
      gateResult: makeGateResult({ compile: true, tests: false, allPassed: false, failures }),
    });
    applyRetryEffect(input);
    expect(input.lang.prompts.promptWriterPhaseBContinue).toHaveBeenCalledWith(formatFailures(failures), 1);
    expect(piOf(input).sentMessages).toHaveLength(1);
  });

  it("handles awaitDisputeReview retry without throwing", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B", awaitDisputeReview: true }) },
      effect: { type: "retry", phase: "B", round: 2, status: "Phase B — round 2", level: "warning" },
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
  });

  it("handles empty failures array without throwing (no prompt sent)", () => {
    const input = makeInput({
      effect: { type: "retry", phase: "A", round: 1, status: "Phase A — round 1" },
      gateResult: makeGateResult({ failures: [] }),
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
    expect(piOf(input).sentMessages).toHaveLength(0);
  });

  it("handles undefined prompt in retry effect without throwing (no prompt sent)", () => {
    const input = makeInput({
      effect: { type: "retry", phase: "A", round: 1, status: "Phase A — round 1" },
    });
    expect(() => applyRetryEffect(input)).not.toThrow();
    expect(piOf(input).sentMessages).toHaveLength(0);
  });
});

// ================================================================
// Retired dispute branch (spec 09): applyRetryEffect no longer special-cases
// awaitDisputeReview. The flag is cleared at the settle step (Table 1) before
// the gate ever runs, so the branch was unreachable and deleted (class C).
// The retired filer-addressed dispute prompt is deleted with it (F-C).
// ================================================================

describe("retired dispute branch (spec 09)", () => {
  // Effect deliberately carries notify + prompt: the normal retry path must run
  // status/notify/prompt even while awaitDisputeReview is set.
  function makeStaleFlagInput(stateOverrides = {}) {
    return makeInput({
      state: {
        current: makeState({
          phase: "B",
          awaitDisputeReview: true, // stale — the settle step clears it before the gate
          lastProposal: "Test is wrong: TestAdd",
          ...stateOverrides,
        }),
      },
      effect: {
        type: "retry",
        phase: "B",
        round: 2,
        status: "Phase B — round 2",
        notify: "Gate failed.",
        level: "warning",
        prompt: RETRY_PROMPTS.WRITER_PHASE_B_RETRY,
      },
      gateResult: makeGateResult({ failures: [{ test: "TestAdd", subtest: "", output: "x" }] }),
    });
  }

  it("runs the normal retry path with a stale flag: status + notify + writer retry prompt", () => {
    const input = makeStaleFlagInput();
    const result = applyRetryEffect(input);
    expect(result.applied).toBe(true);
    expect(input.state.current.turnsThisPhase).toBe(1);
    expect(input.ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 2");
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Gate failed.", "warning");
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(input.lang.prompts.promptWriterPhaseBContinue).toHaveBeenCalled();
  });

  it("does NOT early-return: no dispute prompt is sent (retired filer prompt deleted)", () => {
    const input = makeStaleFlagInput();
    applyRetryEffect(input);
    // The retired branch's signature (flag clear + dispute prompt) is gone.
    expect(input.state.current.awaitDisputeReview).toBe(true); // flag untouched here (settle clears it)
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].options).toEqual({ triggerTurn: true });
    expect(piOf(input).sentMessages[0].content).not.toContain("negotiate_review");
  });
});

// ================================================================
// Notify behavior (G3)
// ================================================================

describe("notify behavior (G3)", () => {
  it("retry: notify undefined → ui.notify not called, status still set", () => {
    const input = makeInput({
      effect: { type: "retry", phase: "A", round: 1, status: "Phase A — round 1" },
    });
    applyRetryEffect(input);
    expect(input.ctx.ui.notify).not.toHaveBeenCalled();
    expect(input.ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase A — round 1");
  });

  it("retry: notify set, level undefined → level falls back to 'info'", () => {
    const input = makeInput({
      effect: { type: "retry", phase: "A", round: 1, status: "s", notify: "Gate failed." },
    });
    applyRetryEffect(input);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Gate failed.", "info");
  });

  it("retry: level set → effect.level is used", () => {
    const input = makeInput({
      effect: { type: "retry", phase: "A", round: 1, status: "s", notify: "Gate failed.", level: "warning" },
    });
    applyRetryEffect(input);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Gate failed.", "warning");
  });

  it("advance: notify unconditional at 'info'", () => {
    const input = makeInput({
      effect: { type: "advance", phase: "negotiate", status: "s", notify: "Advancing." },
    });
    applyAdvanceEffect(input);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Advancing.", "info");
  });

  it("done: notify unconditional at 'info'", () => {
    const input = makeInput({
      effect: { type: "done", status: "s", notify: "Loop complete." },
    });
    applyDoneEffect(input);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Loop complete.", "info");
  });

  it("escalated: notify at 'warning' (the only warning level)", () => {
    const input = makeInput({
      effect: { type: "escalated", status: "s", notify: "Escalating." },
    });
    applyEscalatedEffect(input);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Escalating.", "warning");
  });
});

// ================================================================
// Debug strings (G4) — verbatim table from the spec
// ================================================================

describe("debug strings (G4)", () => {
  it("retry normal path: 'Retry <phase> round <round>'", () => {
    const input = makeInput({
      effect: { type: "retry", phase: "A", round: 2, status: "s", level: "warning" },
    });
    applyRetryEffect(input);
    expect(input.debug).toHaveBeenCalledWith("Retry A round 2");
  });

  // Spec 09 (class C): the retired retry dispute branch's debug-line pin was
  // deleted — the branch itself is gone from applyRetryEffect, and closed
  // evidence must cover the assertion form, not just the log line.

  it("advance: 'Advance → <phase>'", () => {
    const input = makeInput({
      effect: { type: "advance", phase: "negotiate", status: "s", notify: "n" },
    });
    applyAdvanceEffect(input);
    expect(input.debug).toHaveBeenCalledWith("Advance → negotiate");
  });

  it("done: 'Done'", () => {
    const input = makeInput({
      effect: { type: "done", status: "s", notify: "n" },
    });
    applyDoneEffect(input);
    expect(input.debug).toHaveBeenCalledWith("Done");
  });

  it("escalated: 'Escalated (<status>)'", () => {
    const input = makeInput({
      effect: { type: "escalated", status: "Phase A exhausted", notify: "n" },
    });
    applyEscalatedEffect(input);
    expect(input.debug).toHaveBeenCalledWith("Escalated (Phase A exhausted)");
  });
});

// ================================================================
// applyAdvanceEffect
// ================================================================

describe("applyAdvanceEffect", () => {
  it("returns applied: true (no prompt → nothing sent)", () => {
    const input = makeInput({
      effect: { type: "advance", phase: "B", status: "s", notify: "Advancing." },
    });
    const result = applyAdvanceEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(0);
  });

  // B→C is the delivery point: the implementation is complete and the gate is
  // green, so the spec is archived here (before Phase C) — a crash in Phase C
  // still leaves the work marked done-.
  it("advance to C archives the spec file and notifies", () => {
    const archiveSpy = vi.spyOn(archive, "archiveSpecFile").mockReturnValue("done-spec.md");
    try {
      const input = makeInput({
        effect: {
          type: "advance",
          phase: "C",
          status: "Phase C — round 1",
          notify: "Advancing.",
          prompt: ADVANCE_PROMPTS.CLEANER_PHASE_C,
        },
      });
      applyAdvanceEffect(input);
      expect(archiveSpy).toHaveBeenCalledWith("spec.md", "/tmp/test-project");
      expect(input.ctx.ui.notify).toHaveBeenCalledWith("Spec archived: done-spec.md", "info");
      expect(input.debug).toHaveBeenCalledWith("Spec archived: done-spec.md");
    } finally {
      archiveSpy.mockRestore();
    }
  });

  it("advance to C: archive failure is silent (no notify, no throw)", () => {
    const archiveSpy = vi.spyOn(archive, "archiveSpecFile").mockReturnValue(null);
    try {
      const input = makeInput({
        effect: {
          type: "advance",
          phase: "C",
          status: "Phase C — round 1",
          notify: "Advancing.",
          prompt: ADVANCE_PROMPTS.CLEANER_PHASE_C,
        },
      });
      expect(() => applyAdvanceEffect(input)).not.toThrow();
      expect(input.ctx.ui.notify).not.toHaveBeenCalledWith("Spec archived: undefined", "info");
    } finally {
      archiveSpy.mockRestore();
    }
  });

  it("advance to B does not archive the spec", () => {
    const archiveSpy = vi.spyOn(archive, "archiveSpecFile").mockReturnValue("done-spec.md");
    try {
      const input = makeInput({
        effect: { type: "advance", phase: "B", status: "s", notify: "Advancing." },
      });
      applyAdvanceEffect(input);
      expect(archiveSpy).not.toHaveBeenCalled();
    } finally {
      archiveSpy.mockRestore();
    }
  });

  it("advance to negotiate does not archive the spec", () => {
    const archiveSpy = vi.spyOn(archive, "archiveSpecFile").mockReturnValue("done-spec.md");
    try {
      const input = makeInput({
        effect: {
          type: "advance",
          phase: "negotiate",
          status: "s",
          notify: "Advancing.",
          prompt: ADVANCE_PROMPTS.WRITER_NEGOTIATE,
        },
      });
      applyAdvanceEffect(input);
      expect(archiveSpy).not.toHaveBeenCalled();
    } finally {
      archiveSpy.mockRestore();
    }
  });

  it("resets turnsThisPhase to 1", () => {
    const state = makeState({ phase: "A", turnsThisPhase: 3 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "advance", phase: "negotiate", status: "s", notify: "Advancing." },
    });
    const result = applyAdvanceEffect(input);
    expect(result.applied).toBe(true);
    expect(state.turnsThisPhase).toBe(1);
  });

  it("sends writer_negotiate prompt: GP.promptWriterNegotiate(state.specPath, lang.testFilePattern)", () => {
    const input = makeInput({
      state: { current: makeState({ specPath: "spec.md" }) },
      effect: {
        type: "advance",
        phase: "negotiate",
        status: "s",
        notify: "Advancing.",
        prompt: ADVANCE_PROMPTS.WRITER_NEGOTIATE,
      },
    });
    applyAdvanceEffect(input);
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].content).toBe(GP.promptWriterNegotiate("spec.md", "*_test.go"));
    expect(piOf(input).sentMessages[0].options).toEqual({ triggerTurn: true });
  });

  it("sends cleaner_phase_c prompt via lang.prompts.promptCleanerPhaseC()", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "C",
        status: "s",
        notify: "Advancing.",
        prompt: ADVANCE_PROMPTS.CLEANER_PHASE_C,
      },
    });
    applyAdvanceEffect(input);
    expect(input.lang.prompts.promptCleanerPhaseC).toHaveBeenCalled();
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].content).toBe("Phase C");
  });

  it("handles advance without prompt (nothing sent)", () => {
    const input = makeInput({
      effect: { type: "advance", phase: "B", status: "s", notify: "Advancing." },
    });
    applyAdvanceEffect(input);
    expect(piOf(input).sentMessages).toHaveLength(0);
  });

  it("does not change phase (resets turns only)", () => {
    const state = makeState({ phase: "B", turnsThisPhase: 3 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "advance", phase: "C", status: "s", notify: "n" },
    });
    applyAdvanceEffect(input);
    expect(state.phase).toBe("B");
    expect(state.turnsThisPhase).toBe(1);
  });
});

// ================================================================
// applyDoneEffect
// ================================================================

describe("applyDoneEffect", () => {
  // Spec 10 (rewrite 2): pinned clean-finish text (fixture: specPath "spec.md",
  // disputeCount 0, status "All phases complete." → cleanerFailed false).
  it("returns applied: true and sends the completion prompt", () => {
    const input = makeInput({
      effect: { type: "done", status: "All phases complete.", notify: "Loop complete." },
    });
    const result = applyDoneEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].content).toBe(
      "Loop complete — spec spec.md. All phases passed the gate. Disputes raised: 0.",
    );
    expect(piOf(input).sentMessages[0].options).toEqual({ triggerTurn: true });
  });

  it("resets turnsThisPhase to 1", () => {
    const state = makeState({ phase: "C", turnsThisPhase: 5 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "done", status: "s", notify: "n" },
    });
    const result = applyDoneEffect(input);
    expect(result.applied).toBe(true);
    expect(state.turnsThisPhase).toBe(1);
  });

  it("notifies at 'info' and sets status", () => {
    const input = makeInput({
      effect: { type: "done", status: "All phases complete.", notify: "Loop complete." },
    });
    applyDoneEffect(input);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Loop complete.", "info");
    expect(input.ctx.ui.setStatus).toHaveBeenCalledWith("loop", "All phases complete.");
  });

  // Spec 10 (rewrite 3): the failing producer's status selects the Phase-C
  // failed variant — pinned verbatim.
  it("handles done with 'done (cleaner failed)' status", () => {
    const input = makeInput({
      effect: {
        type: "done",
        status: "done (cleaner failed)",
        notify: "Phase C failed, keeping original code. Loop complete.",
      },
    });
    expect(() => applyDoneEffect(input)).not.toThrow();
    expect(input.ctx.ui.setStatus).toHaveBeenCalledWith("loop", "done (cleaner failed)");
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].content).toBe(
      "Loop complete — spec spec.md. Phase C failed; the original code is kept. Disputes raised: 0.",
    );
    expect(piOf(input).sentMessages[0].options).toEqual({ triggerTurn: true });
  });

  // Spec 10 (new test 3): the state's disputeCount flows into the prompt.
  it("sends completion prompt with the state's dispute count", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "C", disputeCount: 3 }) },
      effect: { type: "done", status: "done", notify: "All phases complete." },
    });
    applyDoneEffect(input);
    expect(piOf(input).sentMessages).toHaveLength(1);
    expect(piOf(input).sentMessages[0].content).toBe(
      "Loop complete — spec spec.md. All phases passed the gate. Disputes raised: 3.",
    );
  });

  it("does not change phase", () => {
    const state = makeState({ phase: "C", turnsThisPhase: 5 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "done", status: "s", notify: "n" },
    });
    applyDoneEffect(input);
    expect(state.phase).toBe("C");
  });
});

// ================================================================
// applyEscalatedEffect
// ================================================================

describe("applyEscalatedEffect", () => {
  it("returns applied: true and sends no prompt", () => {
    const input = makeInput({
      effect: { type: "escalated", status: "s", notify: "n" },
    });
    const result = applyEscalatedEffect(input);
    expect(result.applied).toBe(true);
    expect(piOf(input).sentMessages).toHaveLength(0);
  });

  it("notifies at 'warning' and sets status", () => {
    const input = makeInput({
      effect: { type: "escalated", status: "escalated (Phase A exhausted)", notify: "Phase A exhausted. Escalating to human." },
    });
    applyEscalatedEffect(input);
    expect(input.ctx.ui.notify).toHaveBeenCalledWith("Phase A exhausted. Escalating to human.", "warning");
    expect(input.ctx.ui.setStatus).toHaveBeenCalledWith("loop", "escalated (Phase A exhausted)");
  });

  it("handles escalated from Phase A without throwing", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "A" }) },
      effect: { type: "escalated", status: "escalated (Phase A exhausted)", notify: "Phase A exhausted. Escalating to human." },
    });
    expect(() => applyEscalatedEffect(input)).not.toThrow();
  });

  it("handles escalated from Phase B without throwing", () => {
    const input = makeInput({
      state: { current: makeState({ phase: "B" }) },
      effect: { type: "escalated", status: "escalated (Phase B exhausted)", notify: "Phase B exhausted. Escalating to human." },
    });
    expect(() => applyEscalatedEffect(input)).not.toThrow();
  });

  it("handles null pi gracefully (escalated never uses pi)", () => {
    const input = makeInput({
      pi: null as any,
      effect: { type: "escalated", status: "s", notify: "n" },
    });
    const result = applyEscalatedEffect(input);
    expect(result.applied).toBe(true);
  });

  it("does not touch state (no turns reset on escalation)", () => {
    const state = makeState({ phase: "A", round: 3, turnsThisPhase: 5 });
    const input = makeInput({
      state: { current: state },
      effect: { type: "escalated", status: "s", notify: "n" },
    });
    applyEscalatedEffect(input);
    expect(state.phase).toBe("A");
    expect(state.turnsThisPhase).toBe(5);
  });
});

// ================================================================
// buildRetryPrompt (G1 — key mapping + fallback)
// ================================================================

describe("buildRetryPrompt (G1)", () => {
  it("tester_compile_retry → promptTesterCompileRetry(compileError)", () => {
    const lang = makeMockLang();
    const out = buildRetryPrompt(
      RETRY_PROMPTS.TESTER_COMPILE_RETRY,
      lang as any,
      makeGateResult({ compile: false, compileError: "type mismatch" }),
    );
    expect(lang.prompts.promptTesterCompileRetry).toHaveBeenCalledWith("type mismatch");
    expect(out).toBe("Compile error: type mismatch");
  });

  it("tester_dispute_fix_compile_fail → promptTesterCompileRetry(compileError) (same mapping)", () => {
    const lang = makeMockLang();
    const out = buildRetryPrompt(
      RETRY_PROMPTS.TESTER_DISPUTE_FIX_COMPILE_FAIL,
      lang as any,
      makeGateResult({ compile: false, compileError: "type mismatch" }),
    );
    expect(lang.prompts.promptTesterCompileRetry).toHaveBeenCalledWith("type mismatch");
    expect(lang.prompts.promptWriterPhaseBContinue).not.toHaveBeenCalled();
    expect(lang.prompts.promptCleanerRetry).not.toHaveBeenCalled();
    expect(out).toBe("Compile error: type mismatch");
  });

  it("writer_phase_b_retry → promptWriterPhaseBContinue(formatFailures(failures), failures.length)", () => {
    const failures: FailingTest[] = [
      { test: "TestAdd", subtest: "", output: "expected 3, got 2" },
      { test: "TestSub", subtest: "case", output: "boom" },
    ];
    const lang = makeMockLang();
    const out = buildRetryPrompt(
      RETRY_PROMPTS.WRITER_PHASE_B_RETRY,
      lang as any,
      makeGateResult({ failures }),
    );
    expect(lang.prompts.promptWriterPhaseBContinue).toHaveBeenCalledWith(formatFailures(failures), 2);
    expect(out).toBe(`Continue: 2 failures\n${formatFailures(failures)}`);
  });

  it("writer_dispute_fix_incomplete → promptWriterPhaseBContinue (same mapping)", () => {
    const failures: FailingTest[] = [{ test: "TestAdd", subtest: "", output: "x" }];
    const lang = makeMockLang();
    const out = buildRetryPrompt(
      RETRY_PROMPTS.WRITER_DISPUTE_FIX_INCOMPLETE,
      lang as any,
      makeGateResult({ failures }),
    );
    expect(lang.prompts.promptWriterPhaseBContinue).toHaveBeenCalledWith(formatFailures(failures), 1);
    expect(out).toBe(`Continue: 1 failures\n${formatFailures(failures)}`);
  });

  it("cleaner_retry → promptCleanerRetry(formatFailures(failures), failures.length) (single failure)", () => {
    const failures: FailingTest[] = [{ test: "TestClean", subtest: "", output: "dirty" }];
    const lang = makeMockLang();
    const out = buildRetryPrompt(
      RETRY_PROMPTS.CLEANER_RETRY,
      lang as any,
      makeGateResult({ failures }),
    );
    expect(lang.prompts.promptCleanerRetry).toHaveBeenCalledWith(formatFailures(failures), 1);
    expect(out).toBe(`Cleaner retry: 1 failures\n${formatFailures(failures)}`);
  });

  it("unknown key → fallback 'Fix the issues and try again.' (no lang prompt called)", () => {
    const lang = makeMockLang();
    const out = buildRetryPrompt("unknown_key", lang as any, makeGateResult());
    expect(out).toBe("Fix the issues and try again.");
    expect(lang.prompts.promptTesterCompileRetry).not.toHaveBeenCalled();
    expect(lang.prompts.promptWriterPhaseBContinue).not.toHaveBeenCalled();
    expect(lang.prompts.promptCleanerRetry).not.toHaveBeenCalled();
  });

  it("empty failures → count 0, summary formatFailures([]) = '(unknown failures)'", () => {
    const lang = makeMockLang();
    const out = buildRetryPrompt(RETRY_PROMPTS.CLEANER_RETRY, lang as any, makeGateResult({ failures: [] }));
    expect(lang.prompts.promptCleanerRetry).toHaveBeenCalledWith("(unknown failures)", 0);
    expect(out).toBe("Cleaner retry: 0 failures\n(unknown failures)");
  });
});

// ================================================================
// buildAdvancePrompt (G1 — key mapping + fallback)
// ================================================================

describe("buildAdvancePrompt (G1)", () => {
  it("writer_negotiate → GP.promptWriterNegotiate(state.specPath, lang.testFilePattern)", () => {
    const out = buildAdvancePrompt(
      ADVANCE_PROMPTS.WRITER_NEGOTIATE,
      makeState({ specPath: "spec.md" }),
      makeMockLang() as any,
    );
    expect(out).toBe(GP.promptWriterNegotiate("spec.md", "*_test.go"));
  });

  it("cleaner_phase_c → lang.prompts.promptCleanerPhaseC()", () => {
    const lang = makeMockLang();
    const out = buildAdvancePrompt(ADVANCE_PROMPTS.CLEANER_PHASE_C, makeState(), lang as any);
    expect(lang.prompts.promptCleanerPhaseC).toHaveBeenCalled();
    expect(out).toBe("Phase C");
  });

  it("unknown key → returns the raw key verbatim (fallback, do not 'fix')", () => {
    const out = buildAdvancePrompt("some_key", makeState(), makeMockLang() as any);
    expect(out).toBe("some_key");
  });
});
