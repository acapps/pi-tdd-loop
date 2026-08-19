// Behavioral contract for handleToolCall — the path-enforcement decision table
// from internal/02-implement-tool-call-handler.md, in evaluation order (first match wins).
//
// Complements test/events/tool-call.test.ts (no-throw + shape contract, which must
// keep passing unchanged). Verbatim reason and debug strings mirror the monolith
// eventToolCall in src/events/index.ts (rules 1-7), including the F1-F5 review fixes:
//   F1: rule 6's !disputeMode exclusion (dispute-fix turn may write test files)
//   F2: rule 2 is debug-only — it emits NO loop-refusal entry
//   F3: missing path (undefined/null) never throws; only rules 2 and 4 can block
//   F4: rule 2's reason string asserted in full, verbatim

import { describe, it, expect, vi } from "vitest";
import { handleToolCall } from "../../src/events/tool-call";
import type { LoopState } from "../../src/types";
import { getLanguageConfig } from "../../src/languages";
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";
import type { MockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";

const lang = getLanguageConfig("go");
const CWD = "/tmp/test-project";

// F4: rule 2's full verbatim reason string (not truncated).
// Spec 09: role-neutral ("dispute review") — the reviewer may be Tester OR Writer.
const RULE2_REASON = "Dispute filed. Waiting for dispute review. STOP producing tool calls.";

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

function makeCtx(cwd: string = CWD) {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd,
  };
}

interface CallResult {
  result: { block: true; reason: string } | undefined;
  pi: MockExtensionAPI;
  debug: ReturnType<typeof vi.fn>;
}

// path defaults to undefined (pathless tool call); pass "" explicitly for the
// empty-string quirk, and null for the null variant (F3).
function call(opts: {
  state?: Partial<LoopState>;
  toolName?: string;
  path?: string | null;
  cwd?: string;
} = {}): CallResult {
  const pi = createMockExtensionAPI();
  const debug = vi.fn();
  const input = {
    state: { current: makeState(opts.state) },
    pi: pi as any,
    debug,
    toolName: opts.toolName ?? "write",
    path: opts.path as any,
    ctx: makeCtx(opts.cwd),
  };
  const result = handleToolCall(input);
  return { result, pi, debug };
}

// loop-refusal entry payloads, in call order (exact data objects).
function refusalData(pi: MockExtensionAPI) {
  return pi.appendedEntries.filter((e) => e.customType === "loop-refusal").map((e) => e.data);
}

// ---------------------------------------------------------------------------
// Rule 1 — escalated: allow everything, no side effects
// ---------------------------------------------------------------------------

describe("Rule 1 — escalated phase allows everything", () => {
  it("allows a non-test write with no side effects", () => {
    const { result, pi, debug } = call({ state: { phase: "escalated" }, path: "src/main.go" });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(pi.appendedEntries).toHaveLength(0);
  });

  it("first match wins: rule 1 beats rule 2 (escalated + awaitDisputeReview → allow)", () => {
    const { result, pi, debug } = call({
      state: { phase: "escalated", awaitDisputeReview: true },
      path: "src/main.go",
    });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(refusalData(pi)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — awaitDisputeReview: block every call, debug only (F2)
// ---------------------------------------------------------------------------

describe("Rule 2 — awaitDisputeReview blocks all tool calls", () => {
  it("blocks a write with the verbatim reason and emits NO loop-refusal entry (F2)", () => {
    const { result, pi, debug } = call({
      state: { phase: "B", awaitDisputeReview: true },
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: RULE2_REASON });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Blocked: write (awaiting dispute review)");
    expect(refusalData(pi)).toHaveLength(0);
    expect(pi.appendedEntries).toHaveLength(0);
  });

  it("blocks non-write tools too (tool- and phase-independent)", () => {
    const { result } = call({
      state: { phase: "review", awaitDisputeReview: true },
      toolName: "read",
      path: "src/main_test.go",
    });
    expect(result).toEqual({ block: true, reason: RULE2_REASON });
  });

  it("blocks with a missing path (path-independent)", () => {
    const { result } = call({
      state: { phase: "C", awaitDisputeReview: true },
      path: undefined,
    });
    expect(result).toEqual({ block: true, reason: RULE2_REASON });
  });

  it("first match wins: rule 2 beats rule 3 (disputeMode + awaitDisputeReview → rule 2 payload)", () => {
    const { result, pi, debug } = call({
      state: { phase: "B", disputeMode: true, awaitDisputeReview: true },
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: RULE2_REASON });
    expect(refusalData(pi)).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith("Blocked: write (awaiting dispute review)");
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — dispute mode: block non-test paths (any tool, any phase, any path)
// ---------------------------------------------------------------------------

describe("Rule 3 — dispute mode blocks non-test paths", () => {
  it("blocks a non-test write with reason, debug, and B-dispute entry", () => {
    const { result, pi, debug } = call({
      state: { phase: "B", disputeMode: true },
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Blocked: src/main.go (dispute mode, not test file)");
    expect(refusalData(pi)).toEqual([{ phase: "B-dispute", path: "src/main.go", tool: "write" }]);
  });

  it("hardcodes tool: 'write' in the entry even for edit (matches monolith)", () => {
    const { result, pi } = call({
      state: { phase: "B", disputeMode: true },
      toolName: "edit",
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(refusalData(pi)).toEqual([{ phase: "B-dispute", path: "src/main.go", tool: "write" }]);
  });

  it("fires for non-write tools too (monolith has no write-action guard here)", () => {
    const { result, pi } = call({
      state: { phase: "B", disputeMode: true },
      toolName: "read",
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(refusalData(pi)).toHaveLength(1);
  });

  it("has no project-path guard: blocks non-test paths outside the project", () => {
    const { result } = call({
      state: { phase: "B", disputeMode: true },
      path: "/etc/passwd",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
  });

  it("cannot fire with a missing path (F3): B + disputeMode + write + undefined → allow", () => {
    const { result, pi, debug } = call({
      state: { phase: "B", disputeMode: true },
      path: undefined,
    });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(refusalData(pi)).toHaveLength(0);
  });

  it("first match wins: rule 3 beats rule 5 (A + disputeMode → B-dispute payload, not phase A)", () => {
    const { result, pi } = call({
      state: { phase: "A", disputeMode: true },
      path: "README.md",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(refusalData(pi)).toEqual([{ phase: "B-dispute", path: "README.md", tool: "write" }]);
  });

  it("first match wins: rule 3 beats rule 4 (negotiate + disputeMode → B-dispute payload)", () => {
    const { result, pi } = call({
      state: { phase: "negotiate", disputeMode: true },
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(refusalData(pi)).toEqual([{ phase: "B-dispute", path: "src/main.go", tool: "write" }]);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — negotiate phase: block write actions, path-independent
// ---------------------------------------------------------------------------

describe("Rule 4 — negotiate phase blocks write actions", () => {
  it("blocks write with reason, debug, and negotiate entry (entry has NO path field)", () => {
    const { result, pi, debug } = call({
      state: { phase: "negotiate" },
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.negotiate });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Blocked: write (negotiate phase, discussion only)");
    expect(refusalData(pi)).toEqual([{ phase: "negotiate", tool: "write" }]);
  });

  it("blocks edit and records the real tool name in the entry", () => {
    const { result, pi } = call({
      state: { phase: "negotiate" },
      toolName: "edit",
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.negotiate });
    expect(refusalData(pi)).toEqual([{ phase: "negotiate", tool: "edit" }]);
  });

  it("allows non-write tools with no side effects", () => {
    const { result, pi, debug } = call({
      state: { phase: "negotiate" },
      toolName: "read",
      path: "src/main.go",
    });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(pi.appendedEntries).toHaveLength(0);
  });

  it("F3: blocks with a missing path (path-independent)", () => {
    const { result, pi } = call({
      state: { phase: "negotiate" },
      path: undefined,
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.negotiate });
    expect(refusalData(pi)).toEqual([{ phase: "negotiate", tool: "write" }]);
  });

  it("has no project-path guard: blocks writes to paths outside the project", () => {
    const { result } = call({
      state: { phase: "negotiate" },
      path: "/etc/passwd",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.negotiate });
  });

  it("pathless/unknown tool names (e.g. bash) are not write actions → allow", () => {
    const { result } = call({
      state: { phase: "negotiate" },
      toolName: "bash",
      path: undefined,
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — phase A: block non-allowlisted project writes (F3 edge cases)
// ---------------------------------------------------------------------------

describe("Rule 5 — phase A blocks non-allowlisted project writes", () => {
  it("blocks a non-allowlisted project write with reason, debug, and phase A entry", () => {
    const { result, pi, debug } = call({ state: { phase: "A" }, path: "README.md" });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseA });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Blocked: write README.md (phase A, not allowed)");
    expect(refusalData(pi)).toEqual([{ phase: "A", path: "README.md", tool: "write" }]);
  });

  it("blocks edit and records the real tool name in the entry", () => {
    const { result, pi } = call({ state: { phase: "A" }, toolName: "edit", path: "src/notes.md" });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseA });
    expect(refusalData(pi)).toEqual([{ phase: "A", path: "src/notes.md", tool: "edit" }]);
  });

  it("allows test-file writes (allowlisted) with no side effects", () => {
    const { result, pi, debug } = call({ state: { phase: "A" }, path: "src/main_test.go" });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(pi.appendedEntries).toHaveLength(0);
  });

  it("allows stub/source .go writes (allowlisted)", () => {
    const { result } = call({ state: { phase: "A" }, path: "src/main.go" });
    expect(result).toBeUndefined();
  });

  it("allows non-write tools even on non-allowlisted paths", () => {
    const { result } = call({ state: { phase: "A" }, toolName: "read", path: "README.md" });
    expect(result).toBeUndefined();
  });

  it("allows non-project paths", () => {
    const { result } = call({ state: { phase: "A" }, path: "/etc/passwd" });
    expect(result).toBeUndefined();
  });

  it("blocks absolute paths inside the project (starts-with-cwd branch)", () => {
    const { result, pi } = call({ state: { phase: "A" }, path: `${CWD}/README.md` });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseA });
    expect(refusalData(pi)).toEqual([{ phase: "A", path: `${CWD}/README.md`, tool: "write" }]);
  });

  it("allows absolute paths outside the project", () => {
    const { result } = call({ state: { phase: "A" }, path: "/other/README.md" });
    expect(result).toBeUndefined();
  });

  it("cwd boundary: '<cwd>-evil/...' is NOT inside the project (startsWith must include '/')", () => {
    const { result, pi } = call({ state: { phase: "A" }, path: `${CWD}-evil/README.md` });
    expect(result).toBeUndefined();
    expect(refusalData(pi)).toHaveLength(0);
  });

  it("F3 fix: undefined path must not throw (monolith crashed here in phase A) and must allow", () => {
    const { result, pi, debug } = call({ state: { phase: "A" }, path: undefined });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(refusalData(pi)).toHaveLength(0);
  });

  it("F3 fix: null path must not throw and must allow", () => {
    const { result } = call({ state: { phase: "A" }, path: null });
    expect(result).toBeUndefined();
  });

  it("F3 note: empty string is NOT missing — '' is a project path matching no allowlist → block", () => {
    const { result, pi } = call({ state: { phase: "A" }, path: "" });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseA });
    expect(refusalData(pi)).toEqual([{ phase: "A", path: "", tool: "write" }]);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — phases B/C: block test-file writes (except dispute mode, F1)
// ---------------------------------------------------------------------------

describe("Rule 6 — phases B/C block test-file writes", () => {
  it("B: blocks a test-file write with reason, debug, and phase B entry", () => {
    const { result, pi, debug } = call({ state: { phase: "B" }, path: "src/main_test.go" });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("Blocked: write src/main_test.go (phase B, is test file)");
    expect(refusalData(pi)).toEqual([{ phase: "B", path: "src/main_test.go", tool: "write" }]);
  });

  it("C: blocks a test-file edit with phase C entry and the real tool name", () => {
    const { result, pi, debug } = call({
      state: { phase: "C" },
      toolName: "edit",
      path: "src/main_test.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(debug).toHaveBeenCalledWith("Blocked: edit src/main_test.go (phase C, is test file)");
    expect(refusalData(pi)).toEqual([{ phase: "C", path: "src/main_test.go", tool: "edit" }]);
  });

  it("B: allows non-test project writes with no side effects", () => {
    const { result, pi, debug } = call({ state: { phase: "B" }, path: "src/main.go" });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(pi.appendedEntries).toHaveLength(0);
  });

  it("B: allows reads of test files (non-write action)", () => {
    const { result } = call({ state: { phase: "B" }, toolName: "read", path: "src/main_test.go" });
    expect(result).toBeUndefined();
  });

  it("B: allows test-looking paths outside the project", () => {
    const { result } = call({ state: { phase: "B" }, path: "/elsewhere/x_test.go" });
    expect(result).toBeUndefined();
  });

  it("F3 fix: undefined path must not throw in B/C either (monolith crashed here too)", () => {
    const { result } = call({ state: { phase: "B" }, path: undefined });
    expect(result).toBeUndefined();
  });

  it("empty string: rules 3/6 skip it via !path and '' is not a test file → allow in B", () => {
    const { result } = call({ state: { phase: "B" }, path: "" });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F1 — dispute-fix turn: phase B, disputeMode true
// ---------------------------------------------------------------------------

describe("F1 — dispute-fix turn (phase B, disputeMode: true)", () => {
  it("Tester MAY fix the test: write of a test file is allowed (rule 6 exclusion)", () => {
    const { result, pi, debug } = call({
      state: { phase: "B", disputeMode: true },
      path: "src/main_test.go",
    });
    expect(result).toBeUndefined();
    expect(debug).not.toHaveBeenCalled();
    expect(refusalData(pi)).toHaveLength(0);
  });

  it("Tester MAY fix the test: edit of a test file is allowed too", () => {
    const { result } = call({
      state: { phase: "B", disputeMode: true },
      toolName: "edit",
      path: "src/main_test.go",
    });
    expect(result).toBeUndefined();
  });

  it("symmetrically: non-test project writes stay blocked (rule 3)", () => {
    const { result, pi } = call({
      state: { phase: "B", disputeMode: true },
      path: "src/main.go",
    });
    expect(result).toEqual({ block: true, reason: lang.refusalMessage.phaseC });
    expect(refusalData(pi)).toEqual([{ phase: "B-dispute", path: "src/main.go", tool: "write" }]);
  });
});

// ---------------------------------------------------------------------------
// F3 — missing-path semantics across all phases
// ---------------------------------------------------------------------------

describe("F3 — missing path (undefined/null) across phases", () => {
  it("never throws in any phase", () => {
    const phases: LoopState["phase"][] = [
      "review", "A", "negotiate", "B", "C", "done", "escalated", "idle",
    ];
    for (const phase of phases) {
      expect(() => call({ state: { phase }, path: undefined })).not.toThrow();
      expect(() => call({ state: { phase }, path: null })).not.toThrow();
    }
  });

  it("only rule 4 (negotiate + write) can block with a missing path", () => {
    expect(call({ state: { phase: "negotiate" }, path: undefined }).result?.block).toBe(true);
  });

  it("only rule 2 (awaitDisputeReview) can block with a missing path", () => {
    expect(
      call({ state: { phase: "C", awaitDisputeReview: true }, path: undefined }).result?.block,
    ).toBe(true);
  });

  it("rules 3/5/6 cannot fire: phases A/B/C allow missing-path writes", () => {
    for (const phase of ["A", "B", "C"] as const) {
      expect(call({ state: { phase }, path: undefined }).result).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Result shape and immutability
// ---------------------------------------------------------------------------

describe("Result shape and immutability", () => {
  it("a blocked result has exactly { block: true, reason: string }", () => {
    const { result } = call({ state: { phase: "B" }, path: "src/main_test.go" });
    expect(result).toBeDefined();
    if (result) {
      expect(Object.keys(result).sort()).toEqual(["block", "reason"]);
      expect(result.block).toBe(true);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("does not mutate state", () => {
    const state = makeState({ phase: "B" });
    const pi = createMockExtensionAPI();
    const debug = vi.fn();
    handleToolCall({
      state: { current: state },
      pi: pi as any,
      debug,
      toolName: "write",
      path: "src/main_test.go",
      ctx: makeCtx(),
    });
    expect(state.phase).toBe("B");
    expect(state.disputeMode).toBe(false);
    expect(state.awaitDisputeReview).toBe(false);
  });
});
