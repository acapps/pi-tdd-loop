// Contract tests for the before-agent handler — role-specific prompt injection.
// Spec: internal/03-implement-before-agent-handler.md
// Strings are behavior: every prompt string below is verbatim from the spec's
// Prompt inventory, rendered with the Go language config values (src/languages/go.ts).

import { describe, it, expect, vi } from "vitest";
import { handleBeforeAgent } from "../../src/events/before-agent";
import type { LoopState } from "../../src/types";
import type { BeforeAgentHandlerInput } from "../../src/events/before-agent";
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";

// --- Fixtures ---

const BASE = "Base system prompt";

// Go language config (src/languages/go.ts) — the exact values interpolated into A/B/C prompts
const GO_SOURCE = "*.go (non-test files)";
const GO_TEST = "*_test.go";

// Prompt inventory (verbatim — do not rephrase)
const REVIEWER_CONTENT =
  "REVIEWER (Phase 0). Review the spec for ambiguities and missing edge cases.\n" +
  "Use negotiate_propose with plan='approve' to proceed, or provide feedback.\n" +
  "No file writes.";
const REVIEWER_SP = `${BASE}\n\nPhase 0 (Reviewer). Review the spec. Use negotiate_propose. No file writes.`;

const TESTER_CONTENT = `TESTER. Write contract: ${GO_TEST} and ${GO_SOURCE} stubs.\nStop when done.`;
const TESTER_SP = `${BASE}\n\nPhase A (Tester). Write ${GO_TEST} and ${GO_SOURCE} stubs.`;

const NEGOTIATE_WRITER_CONTENT =
  "WRITER (negotiate). Use negotiate_propose. No file writes.\n" +
  "plan='agree' if tests match spec. plan='your approach' otherwise.";
const NEGOTIATE_WRITER_SP = `${BASE}\n\nNegotiation. Use negotiate_propose tool. No file writes.`;

const NEGOTIATE_TESTER_CONTENT =
  "TESTER (negotiate). Use negotiate_review. No file writes.\n" +
  "'approve' if accept. feedback otherwise.";
const NEGOTIATE_TESTER_SP = `${BASE}\n\nNegotiation. Use negotiate_review tool. No file writes.`;

const WRITER_CONTENT =
  `WRITER. Write ${GO_SOURCE} to pass ${GO_TEST}.\n` +
  "Preserve stub signatures. Dispute wrong tests via negotiate_propose.\n" +
  "When done, stop producing tool calls.";
const WRITER_SP_ROUND = (round: number) =>
  `${BASE}\n\nPhase B (Writer), round ${round}. Write ${GO_SOURCE} only. Do not modify ${GO_TEST}.`;

const DISPUTE_FIX_CONTENT =
  "You are the TESTER (dispute fix). You conceded that the Writer's dispute was valid.\n" +
  "Fix the test(s) to match the spec.\n" +
  "After fixing, stop producing tool calls.";
const DISPUTE_FIX_SP = `${BASE}\n\nYou are in Phase B dispute fix (Tester). You may write test files.`;

const CLEANER_CONTENT =
  "CLEANER. Refactor for readability:\n" +
  "- Return early. Extract helpers. Clear names.\n" +
  `You may only write ${GO_SOURCE}. Do not modify ${GO_TEST}. All tests must pass.`;
const CLEANER_SP_ROUND = (round: number) =>
  `${BASE}\n\nPhase C (Cleaner), round ${round}. Refactor ${GO_SOURCE} only. Do not modify ${GO_TEST}.`;

// --- Helpers ---

function makeState(overrides: Partial<LoopState> = {}): LoopState {
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

function makeInput(overrides: Partial<BeforeAgentHandlerInput> = {}): BeforeAgentHandlerInput {
  return {
    state: { current: makeState() },
    pi: createMockExtensionAPI() as any,
    debug: vi.fn(),
    systemPrompt: BASE,
    ...overrides,
  };
}

function msg(content: string): Record<string, unknown> {
  return { customType: "loop-context", content, display: false };
}

// --- Entry order (S1): idle short-circuit BEFORE lang resolution ---

describe("entry order (S1)", () => {
  it("idle + corrupted language → undefined, no throw (lang resolution never reached)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "idle", language: "bogus" as any }) } });
    expect(() => handleBeforeAgent(input)).not.toThrow();
    expect(handleBeforeAgent(input)).toBeUndefined();
  });

  it("every non-idle phase + corrupted language → throws 'Language not available' (R4 parity)", () => {
    const phases: LoopState["phase"][] = ["review", "A", "negotiate", "B", "C", "done", "escalated"];
    for (const phase of phases) {
      const input = makeInput({ state: { current: makeState({ phase, language: "bogus" as any }) } });
      expect(() => handleBeforeAgent(input), `phase ${phase}`).toThrow("Language not available: bogus");
    }
  });
});

// --- Phase dispatch ---

describe("phase dispatch", () => {
  it("returns undefined for idle phase", () => {
    const input = makeInput({ state: { current: makeState({ phase: "idle" }) } });
    expect(handleBeforeAgent(input)).toBeUndefined();
  });

  it("returns undefined for done phase (F3: explicit terminal row)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "done" }) } });
    expect(handleBeforeAgent(input)).toBeUndefined();
  });

  it("returns undefined for escalated phase (F3: explicit terminal row)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "escalated" }) } });
    expect(handleBeforeAgent(input)).toBeUndefined();
  });

  it("returns undefined for unknown phase value (R5: defensive default, no throw)", () => {
    const input = makeInput({ state: { current: makeState({ phase: "not-a-phase" as any }) } });
    expect(() => handleBeforeAgent(input)).not.toThrow();
    expect(handleBeforeAgent(input)).toBeUndefined();
  });
});

// --- Prompt inventory: exact strings (strings are behavior) ---

describe("review phase (Phase 0)", () => {
  it("returns the reviewer prompt with exact message + systemPrompt", () => {
    const input = makeInput({ state: { current: makeState({ phase: "review" }) } });
    expect(handleBeforeAgent(input)).toEqual({ message: msg(REVIEWER_CONTENT), systemPrompt: REVIEWER_SP });
  });
});

describe("Phase A (Tester)", () => {
  it("returns the tester prompt with Go patterns interpolated", () => {
    const input = makeInput({ state: { current: makeState({ phase: "A" }) } });
    expect(handleBeforeAgent(input)).toEqual({ message: msg(TESTER_CONTENT), systemPrompt: TESTER_SP });
  });
});

describe("negotiate phase (round parity)", () => {
  it("round 1 (odd) → Writer prompt + debug 'Negotiate round 1 (Writer)'", () => {
    const debug = vi.fn();
    const input = makeInput({ state: { current: makeState({ phase: "negotiate", round: 1 }) }, debug });
    expect(handleBeforeAgent(input)).toEqual({ message: msg(NEGOTIATE_WRITER_CONTENT), systemPrompt: NEGOTIATE_WRITER_SP });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Negotiate round 1 (Writer)");
  });

  it("round 2 (even) → Tester prompt + debug 'Negotiate round 2 (Tester)'", () => {
    const debug = vi.fn();
    const input = makeInput({ state: { current: makeState({ phase: "negotiate", round: 2 }) }, debug });
    expect(handleBeforeAgent(input)).toEqual({ message: msg(NEGOTIATE_TESTER_CONTENT), systemPrompt: NEGOTIATE_TESTER_SP });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Negotiate round 2 (Tester)");
  });

  it("round 0 (even edge) → Tester prompt", () => {
    const input = makeInput({ state: { current: makeState({ phase: "negotiate", round: 0 }) } });
    expect(handleBeforeAgent(input)?.message).toEqual(msg(NEGOTIATE_TESTER_CONTENT));
  });
});

describe("Phase B (Writer)", () => {
  it("normal turn round 1 → Writer prompt with resolved round + debug 'Writer round 1'", () => {
    const debug = vi.fn();
    const input = makeInput({ state: { current: makeState({ phase: "B", round: 1 }) }, debug });
    expect(handleBeforeAgent(input)).toEqual({ message: msg(WRITER_CONTENT), systemPrompt: WRITER_SP_ROUND(1) });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Writer round 1");
  });
});

describe("Phase B (dispute fix) — F1, R3", () => {
  it("returns the dispute-fix prompt", () => {
    const input = makeInput({ state: { current: makeState({ phase: "B", round: 3, awaitDisputeFix: true }) } });
    expect(handleBeforeAgent(input)).toEqual({ message: msg(DISPUTE_FIX_CONTENT), systemPrompt: DISPUTE_FIX_SP });
  });

  it("clears awaitDisputeFix and persists the full snapshot AFTER the clear", () => {
    const state = makeState({ phase: "B", round: 3, awaitDisputeFix: true });
    const pi = createMockExtensionAPI();
    handleBeforeAgent({ state: { current: state }, pi: pi as any, debug: vi.fn(), systemPrompt: BASE });

    expect(state.awaitDisputeFix).toBe(false);
    expect(pi.appendedEntries).toHaveLength(1);
    const [entry] = pi.appendedEntries;
    expect(entry.customType).toBe("loop-state");
    expect(entry.data).toEqual(state); // full state snapshot, taken after the clear
    expect(entry.data).toMatchObject({ phase: "B", round: 3, awaitDisputeFix: false });
  });

  it("executes the exact order: debug → clear flag → persist snapshot (R3)", () => {
    const order: string[] = [];
    const state = makeState({ phase: "B", round: 1, awaitDisputeFix: true });
    let flag = true;
    Object.defineProperty(state, "awaitDisputeFix", {
      get: () => flag,
      set: (v: boolean) => {
        order.push("clear");
        flag = v;
      },
      enumerable: true,
      configurable: true,
    });
    const pi = createMockExtensionAPI();
    pi.appendEntry = ((..._args: any[]) => {
      order.push("persist");
    }) as any;
    const debugSpy = vi.fn();
    const debug = (m: string) => {
      order.push("debug");
      debugSpy(m);
    };

    handleBeforeAgent({ state: { current: state }, pi: pi as any, debug, systemPrompt: BASE });

    expect(order).toEqual(["debug", "clear", "persist"]);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith("Tester fixing test");
  });
});

describe("Phase C (Cleaner)", () => {
  it("round 2 → Cleaner prompt with resolved round in systemPrompt", () => {
    const input = makeInput({ state: { current: makeState({ phase: "C", round: 2 }) } });
    expect(handleBeforeAgent(input)).toEqual({ message: msg(CLEANER_CONTENT), systemPrompt: CLEANER_SP_ROUND(2) });
  });
});

// --- Side-effect contract: only dispute-fix touches state/session ---

describe("side-effect contract", () => {
  it("persists no session entries in any non-dispute-fix branch", () => {
    const cases: Partial<LoopState>[] = [
      { phase: "review" },
      { phase: "A" },
      { phase: "negotiate", round: 1 },
      { phase: "negotiate", round: 2 },
      { phase: "B", round: 1, awaitDisputeFix: false },
      { phase: "C" },
      { phase: "done" },
      { phase: "escalated" },
      { phase: "idle" },
    ];
    for (const c of cases) {
      const pi = createMockExtensionAPI();
      handleBeforeAgent({ state: { current: makeState(c) }, pi: pi as any, debug: vi.fn(), systemPrompt: BASE });
      expect(pi.appendedEntries, `phase ${c.phase}`).toEqual([]);
    }
  });

  it("makes no debug calls in review/A/C branches (F6)", () => {
    const phases: LoopState["phase"][] = ["review", "A", "C"];
    for (const phase of phases) {
      const debug = vi.fn();
      handleBeforeAgent(makeInput({ state: { current: makeState({ phase }) }, debug }));
      expect(debug, `phase ${phase}`).not.toHaveBeenCalled();
    }
  });

  it("normal phases mutate nothing (F4 mutation contract)", () => {
    const cases: Partial<LoopState>[] = [
      { phase: "review" },
      { phase: "A" },
      { phase: "negotiate", round: 1 },
      { phase: "B", round: 1, awaitDisputeFix: false },
      { phase: "C" },
      { phase: "done" },
      { phase: "escalated" },
      { phase: "idle" },
    ];
    for (const c of cases) {
      const state = makeState(c);
      const before = structuredClone(state);
      handleBeforeAgent({ state: { current: state }, pi: createMockExtensionAPI() as any, debug: vi.fn(), systemPrompt: BASE });
      expect(state, `phase ${c.phase}`).toEqual(before);
    }
  });

  it("B + dispute-fix clears exactly awaitDisputeFix and nothing else", () => {
    const state = makeState({ phase: "B", round: 1, awaitDisputeFix: true });
    const before = structuredClone(state);
    const pi = createMockExtensionAPI();
    const input = { state: { current: state }, pi: pi as any, debug: vi.fn(), systemPrompt: BASE } as BeforeAgentHandlerInput;

    expect(handleBeforeAgent(input)).toBeDefined();

    expect(state.awaitDisputeFix).toBe(false);
    const after = structuredClone(state);
    after.awaitDisputeFix = before.awaitDisputeFix; // restore the single permitted change
    expect(after).toEqual(before);
  });
});

// --- Kept no-throw / edge tests (F4) ---

describe("no-throw and edge cases", () => {
  it("handles all 8 phases without throwing (valid language)", () => {
    const phases: LoopState["phase"][] = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"];
    for (const phase of phases) {
      const input = makeInput({ state: { current: makeState({ phase }) } });
      expect(() => handleBeforeAgent(input), `phase ${phase}`).not.toThrow();
    }
  });

  it("handles empty system prompt (renders empty base prefix exactly)", () => {
    const input = makeInput({ systemPrompt: "", state: { current: makeState({ phase: "review" }) } });
    expect(() => handleBeforeAgent(input)).not.toThrow();
    expect(handleBeforeAgent(input)?.systemPrompt).toBe("\n\nPhase 0 (Reviewer). Review the spec. Use negotiate_propose. No file writes.");
  });

  it("handles undefined pi gracefully (idle never touches pi)", () => {
    const input = makeInput({ pi: undefined as any });
    expect(() => handleBeforeAgent(input)).not.toThrow();
    expect(handleBeforeAgent(input)).toBeUndefined();
  });

  it("does not throw on null system prompt", () => {
    const input = makeInput({ systemPrompt: null as any, state: { current: makeState({ phase: "review" }) } });
    expect(() => handleBeforeAgent(input)).not.toThrow();
  });

  it("handles dispute mode in Phase B without throwing", () => {
    const input = makeInput({ state: { current: makeState({ phase: "B", round: 1, disputeMode: true, awaitDisputeFix: true }) } });
    expect(() => handleBeforeAgent(input)).not.toThrow();
  });
});
