// Contract tests for deliverAdvancePrompt — the single advance-prompt delivery
// helper (spec internal/bug-advance-effect-dual-path.md).
//
// The bug: two independent code paths both apply an `advance` effect, and they
// diverged. The agent-settled applier (applyAdvanceEffect) sent the prompt; the
// tool-call applier (applyTransitionEffect) did not — so the Writer was never
// told to write the implementation and the loop stalled in a live session (twice).
// The first fix landed on the prompt *builder* (the path that already worked)
// and left the broken path broken.
//
// The fix: ONE shared helper, deliverAdvancePrompt, that BOTH appliers call.
// "What an advance does" (deliver the next phase's prompt) is defined in exactly
// one place, so the two paths cannot diverge again.
//
// Pinned contract (spec §Interface + §Behavior):
//   deliverAdvancePrompt(pi, state, lang, effect, debug): void
//   - calls sendPrompt EXACTLY ONCE when effect.prompt is set
//   - calls sendPrompt ZERO times when effect.prompt is unset (undefined / null / "")
//   - no state mutation (prompt delivery only)
//   - no new direct pi.sendUserMessage call — sendPrompt is the single delivery point
//   - the prompt is built by the existing single builder buildAdvancePrompt
//
// Per CLAUDE.md TEST SPEED RULE: no real toolchain, no npx, no temp-dir
// scaffolding. All assertions are on the mock ExtensionAPI (pi.sentMessages)
// and on buildAdvancePrompt's return value.

import { readFileSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import {
  deliverAdvancePrompt,
  buildAdvancePrompt,
  applyAdvanceEffect,
} from "../../../src/events/agent-settled/effect-applicator";
import { applyTransitionEffect, transitionToPhaseB } from "../../../src/tools/state-io";
import { ADVANCE_PROMPTS } from "../../../src/constants";
import type { LoopState } from "../../../src/types";
import type { LanguageConfig } from "../../../src/languages";
import * as Lang from "../../../src/languages";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";
import type { MockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

// Mock getLanguageConfig for the tool-call applier tests (applyTransitionEffect
// and transitionToPhaseB call it internally). The deliverAdvancePrompt and
// applyAdvanceEffect tests pass lang explicitly, so they don't need the mock.
const mockLang = makeMockLang();
vi.spyOn(Lang, "getLanguageConfig").mockReturnValue(mockLang as LanguageConfig);
afterAll(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A minimal LanguageConfig whose prompt fns are spies, so tests can assert the
// exact builder call and the delivered content. (Structurally cast: the helper
// only reads .prompts.promptWriterPhaseB / .testFilePattern via buildAdvancePrompt.)
function makeMockLang(): LanguageConfig {
  return {
    key: "go",
    sourceFilePattern: "*.go",
    testFilePattern: "*_test.go",
    isTestFile: (path: string) => path.endsWith("_test.go"),
    isPhaseAAllowed: () => true,
    prompts: {
      promptTesterPhaseA: () => "",
      promptTesterPhaseARestart: () => "",
      promptTesterCompileRetry: () => "",
      promptNegotiateAutoAdvance: () => "",
      promptWriterPhaseB: vi.fn(() => "Phase B writer prompt"),
      promptWriterPhaseBContinue: () => "",
      promptCleanerPhaseC: vi.fn(() => "Phase C"),
      promptCleanerRetry: () => "",
      promptCleanerRestart: () => "",
      promptTesterDisputeFix: () => "",
    },
    refusalMessage: { phaseA: "", negotiate: "", phaseC: "" },
  } as LanguageConfig;
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "negotiate",
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
    gateTimeoutSec: 60,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "negotiate",
    justTransitioned: false,
    negotiateReprompted: false,
    dispute: { status: "none" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deliverAdvancePrompt — the shared helper contract
// ---------------------------------------------------------------------------

describe("deliverAdvancePrompt (shared advance-prompt helper)", () => {
  it("sends EXACTLY ONE prompt when effect.prompt is set", () => {
    const pi = createMockExtensionAPI();
    const lang = makeMockLang();
    const state = makeState();
    const effect = {
      type: "advance" as const,
      phase: "B",
      status: "Phase B — round 1",
      notify: "Approved — moving to Phase B.",
      prompt: ADVANCE_PROMPTS.WRITER_PHASE_B,
    };

    deliverAdvancePrompt(pi as any, state, lang, effect as any, vi.fn());

    expect(pi.sentMessages).toHaveLength(1);
  });

  it("delivers the prompt built by buildAdvancePrompt (the single builder)", () => {
    const pi = createMockExtensionAPI();
    const lang = makeMockLang();
    const state = makeState({ specPath: "spec.md" });
    const effect = {
      type: "advance" as const,
      phase: "B",
      status: "s",
      notify: "n",
      prompt: ADVANCE_PROMPTS.WRITER_PHASE_B,
    };

    deliverAdvancePrompt(pi as any, state, lang, effect as any, vi.fn());

    // The writer_phase_b builder is invoked, and its output is what is delivered.
    expect(lang.prompts.promptWriterPhaseB).toHaveBeenCalled();
    expect(pi.sentMessages[0].content).toBe(
      buildAdvancePrompt(ADVANCE_PROMPTS.WRITER_PHASE_B, state, lang),
    );
  });

  it("delivers with deliverAs: 'followUp' (intra-process continuation)", () => {
    const pi = createMockExtensionAPI();
    const lang = makeMockLang();
    const effect = {
      type: "advance" as const,
      phase: "B",
      status: "s",
      notify: "n",
      prompt: ADVANCE_PROMPTS.WRITER_PHASE_B,
    };

    deliverAdvancePrompt(pi as any, makeState(), lang, effect as any, vi.fn());

    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("sends ZERO prompts when effect.prompt is undefined (empty/absent input)", () => {
    const pi = createMockExtensionAPI();
    const lang = makeMockLang();
    const effect = {
      type: "advance" as const,
      phase: "B",
      status: "s",
      notify: "n",
      // prompt intentionally omitted → undefined
    };

    deliverAdvancePrompt(pi as any, makeState(), lang, effect as any, vi.fn());

    expect(pi.sentMessages).toHaveLength(0);
    expect(lang.prompts.promptWriterPhaseB).not.toHaveBeenCalled();
  });

  it("sends ZERO prompts when effect.prompt is null (single null element edge)", () => {
    const pi = createMockExtensionAPI();
    const lang = makeMockLang();
    const effect = {
      type: "advance" as const,
      phase: "B",
      status: "s",
      notify: "n",
      prompt: null as any,
    };

    deliverAdvancePrompt(pi as any, makeState(), lang, effect as any, vi.fn());

    expect(pi.sentMessages).toHaveLength(0);
  });

  it("sends ZERO prompts when effect.prompt is an empty string (empty-string edge)", () => {
    const pi = createMockExtensionAPI();
    const lang = makeMockLang();
    const effect = {
      type: "advance" as const,
      phase: "B",
      status: "s",
      notify: "n",
      prompt: "" as any,
    };

    deliverAdvancePrompt(pi as any, makeState(), lang, effect as any, vi.fn());

    expect(pi.sentMessages).toHaveLength(0);
    expect(lang.prompts.promptWriterPhaseB).not.toHaveBeenCalled();
  });

  it("does NOT mutate state (prompt delivery only)", () => {
    const pi = createMockExtensionAPI();
    const lang = makeMockLang();
    const state = makeState({ phase: "negotiate", round: 4, turnsThisPhase: 3, justTransitioned: false });
    const effect = {
      type: "advance" as const,
      phase: "B",
      status: "s",
      notify: "n",
      prompt: ADVANCE_PROMPTS.WRITER_PHASE_B,
    };

    deliverAdvancePrompt(pi as any, state, lang, effect as any, vi.fn());

    expect(state.phase).toBe("negotiate");
    expect(state.round).toBe(4);
    expect(state.turnsThisPhase).toBe(3);
    expect(state.justTransitioned).toBe(false);
    expect(pi.sentMessages).toHaveLength(1);
  });

});

// ---------------------------------------------------------------------------
// buildAdvancePrompt — the single prompt builder (unchanged signature)
// ---------------------------------------------------------------------------

describe("buildAdvancePrompt (single advance-prompt builder)", () => {
  it("writer_phase_b → lang.prompts.promptWriterPhaseB(ws)", () => {
    const lang = makeMockLang();
    const state = makeState({ specPath: "spec.md" });
    const out = buildAdvancePrompt(ADVANCE_PROMPTS.WRITER_PHASE_B, state, lang);
    expect(lang.prompts.promptWriterPhaseB).toHaveBeenCalled();
    expect(out).toBe("Phase B writer prompt");
  });

  it("cleaner_phase_c → lang.prompts.promptCleanerPhaseC(ws)", () => {
    const lang = makeMockLang();
    const out = buildAdvancePrompt(ADVANCE_PROMPTS.CLEANER_PHASE_C, makeState(), lang);
    expect(lang.prompts.promptCleanerPhaseC).toHaveBeenCalled();
  });

  it("unknown key → returns the raw key verbatim (fallback, do not 'fix')", () => {
    const out = buildAdvancePrompt("some_unknown_key", makeState(), makeMockLang());
    expect(out).toBe("some_unknown_key");
  });
});

// ---------------------------------------------------------------------------
// applyAdvanceEffect (agent-settled applier) routes through the helper
// ---------------------------------------------------------------------------

describe("applyAdvanceEffect (agent-settled applier) → deliverAdvancePrompt", () => {
  function makeInput(overrides: any = {}) {
    const state = overrides.state ?? { current: makeState({ phase: "A" }) };
    const pi = createMockExtensionAPI();
    return {
      state,
      pi,
      ctx: { ui: { notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getEntries: () => [] }, cwd: "/tmp/test-project" },
      lang: makeMockLang(),
      debug: vi.fn(),
      effect: overrides.effect ?? { type: "noop" },
      gateResult: { compile: true, compileError: "", allPassed: true, coverage: 100, failures: [] },
    };
  }

  it("sends the advance prompt via the shared helper (one message)", () => {
    const input = makeInput({
      effect: {
        type: "advance",
        phase: "B",
        status: "Phase B — round 1",
        notify: "Advancing.",
        prompt: ADVANCE_PROMPTS.WRITER_PHASE_B,
      },
    });
    const result = applyAdvanceEffect(input as any);
    expect(result.applied).toBe(true);
    expect((input.pi as MockExtensionAPI).sentMessages).toHaveLength(1);
    expect((input.pi as MockExtensionAPI).sentMessages[0].content).toBe("Phase B writer prompt");
  });

  it("sends nothing when the advance effect has no prompt", () => {
    const input = makeInput({
      effect: { type: "advance", phase: "B", status: "s", notify: "n" },
    });
    applyAdvanceEffect(input as any);
    expect((input.pi as MockExtensionAPI).sentMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyTransitionEffect (tool-call applier) routes through the same helper —
// THIS is the path that stalled in the live session.
// ---------------------------------------------------------------------------

describe("applyTransitionEffect (tool-call applier) → deliverAdvancePrompt", () => {
  function run(state: LoopState, effect: any) {
    const pi = createMockExtensionAPI();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "loop", hasUI: true };
    const debug = vi.fn();
    applyTransitionEffect({ current: state }, pi as any, ctx as any, debug, effect as any);
    return { pi, ctx, debug };
  }

  it("sends the Phase B advance prompt (the path that stalled — must NOT be zero)", () => {
    const state = makeState({ phase: "B" });
    const effect = {
      type: "advance",
      phase: "B",
      status: "Phase B — round 1",
      notify: "Approved — moving to Phase B.",
      prompt: ADVANCE_PROMPTS.WRITER_PHASE_B,
    };
    const { pi, ctx } = run(state, effect);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1");
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe("Phase B writer prompt");
    expect(pi.sentMessages[0].options).toEqual({ deliverAs: "followUp" });
  });

  it("sends ZERO prompts when the advance effect has no prompt", () => {
    const state = makeState({ phase: "B" });
    const effect = { type: "advance", phase: "B", status: "s", notify: "n" };
    const { pi } = run(state, effect);
    expect(pi.sentMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// transitionToPhaseB — the full tool-call entry point (the live-session stall)
// ---------------------------------------------------------------------------

describe("transitionToPhaseB (tool-call entry: negotiate → B)", () => {
  it("resets transient fields and sends the Writer Phase B prompt in-turn", () => {
    const state = makeState({
      round: 2,
      turnsThisPhase: 4,
      lastPhase: "negotiate",
      dispute: { status: "defended", filer: "writer" },
      negotiateReprompted: true,
      negotiateProposed: true,
      negotiateFeedback: "old feedback",
    });
    const pi = createMockExtensionAPI();
    const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "loop", hasUI: true };

    transitionToPhaseB({ current: state }, pi as any, ctx as any, vi.fn());

    expect(state.phase).toBe("B");
    expect(state.round).toBe(1);
    expect(state.turnsThisPhase).toBe(1);
    expect(state.justTransitioned).toBe(true);
    expect(state.dispute).toEqual({ status: "none" });
    expect(state.negotiateProposed).toBe(false);
    expect(state.negotiateFeedback).toBe("");

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1");
    // The Writer Phase B prompt IS delivered in-turn (the whole point of the fix).
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toContain("Phase B");
  });
});

// ---------------------------------------------------------------------------
// Structural grep invariant: the inlined prompt send is gone from both appliers
// ---------------------------------------------------------------------------

describe("structural invariant (no inlined sendPrompt(buildAdvancePrompt(...)) in appliers)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = pathResolve(here, "..", "..", "..", "src");
  const targets = [
    pathJoin(root, "events", "agent-settled", "effect-applicator.ts"),
    pathJoin(root, "tools", "state-io.ts"),
  ];

  it("state-io.ts no longer inlines the advance prompt send", () => {
    // deliverAdvancePrompt lives in effect-applicator.ts, so a file-level
    // grep on that file would match the helper itself. Only state-io.ts
    // (the tool-call applier) must be free of the inlined call.
    const src = readFileSync(
      pathJoin(root, "tools", "state-io.ts"), "utf8");
    expect(src, "state-io.ts still inlines the advance prompt send").not.toMatch(
      /sendPrompt\(\s*[^,]+,\s*buildAdvancePrompt\(/,
    );
  });
});
