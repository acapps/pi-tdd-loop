// Contract tests for src/commands/patch.ts — internal/refactor-commands-split.md
//
// Pins cmdPatch + helpers (parsePatchArgs, resolvePatchTargetPhase).
// Behavior is pinned VERBATIM from the current src/commands.ts (pure
// refactor — no behavioral change).
//
// Leaf modules (commit, prompt, spec-path, selectors) are mocked; tests
// assert on the command layer's decision table + state mutation.
// Fast + hermetic: no process spawning, no temp-dir scaffolding.

import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, Phase } from "../../src/types";

vi.mock("../../src/commit", () => ({ commit: vi.fn() }));
vi.mock("../../src/prompt", () => ({ sendPrompt: vi.fn() }));
vi.mock("../../src/spec-path", () => ({ resolveExistingSpec: vi.fn() }));
vi.mock("../../src/selectors", () => ({
  normalizeSpecPath: vi.fn((p: string) => p),
  formatStatus: vi.fn(),
}));
vi.mock("../../src/state-helpers", () => ({
  resetPhaseState: vi.fn((s: LoopState) => {
    s.round = 1;
    s.disputeCount = 0;
    s.dispute = { status: "none" };
    s.negotiateReprompted = false;
    s.negotiateProposed = false;
    s.negotiateFeedback = "";
    s.justTransitioned = false;
    s.turnsThisPhase = 1;
  }),
  isIdleOrDone: vi.fn((p: string) => p === "idle" || p === "done"),
}));

import { cmdPatch, parsePatchArgs, resolvePatchTargetPhase } from "../../src/commands/patch";
import * as Commit from "../../src/commit";
import * as Prompt from "../../src/prompt";
import * as SpecPath from "../../src/spec-path";

// --- Fixtures -------------------------------------------------------------

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
    round: 3,
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
    dispute: { status: "none" },
    disputeCount: 0,
    turnsThisPhase: 2,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides,
  };
}

function makeApi(): ExtensionAPI {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    state: { cwd: "/tmp/proj", model: { id: "test" } },
  } as unknown as ExtensionAPI;
}

function makeCtx(cwd = "/tmp/proj") {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd,
  } as any;
}

const debug = vi.fn();

// ================================================================
// Module contract
// ================================================================

describe("src/commands/patch.ts — module contract", () => {
  it("exports cmdPatch + the 2 patch helpers", () => {
    expect(typeof cmdPatch).toBe("function");
    expect(typeof parsePatchArgs).toBe("function");
    expect(typeof resolvePatchTargetPhase).toBe("function");
  });
});

// ================================================================
// parsePatchArgs — verbatim from src/commands.ts:665-681
// ================================================================

describe("parsePatchArgs", () => {
  it("empty args → keeps current specPath, no --from", () => {
    expect(parsePatchArgs("", "cur.md")).toEqual({ specPath: "cur.md", fromPhase: undefined, invalidFrom: undefined });
  });

  it("positional spec replaces the current one (last positional wins)", () => {
    expect(parsePatchArgs("new.md", "cur.md")).toEqual({ specPath: "new.md", fromPhase: undefined, invalidFrom: undefined });
  });

  it.each([
    ["--from a", "A"],
    ["--from A", "A"],
    ["--from b", "B"],
    ["--from c", "C"],
    ["--from negotiate", "negotiate"],
    ["--from Negotiate", "negotiate"],
  ] as const)("maps --from %j", (arg, expected) => {
    expect(parsePatchArgs(arg, "cur.md").fromPhase).toBe(expected);
  });

  it("invalid --from → invalidFrom carries the raw value", () => {
    const parsed = parsePatchArgs("--from zzz", "cur.md");
    expect(parsed.invalidFrom).toBe("zzz");
    expect(parsed.fromPhase).toBeUndefined();
  });

  it("spec + --from together", () => {
    expect(parsePatchArgs("n.md --from b", "cur.md")).toEqual({
      specPath: "n.md", fromPhase: "B", invalidFrom: undefined,
    });
  });
});

// ================================================================
// resolvePatchTargetPhase — verbatim from src/commands.ts:683-687
// ================================================================

describe("resolvePatchTargetPhase", () => {
  it("explicit fromPhase always wins", () => {
    expect(resolvePatchTargetPhase({ current: makeState({ phase: "escalated", lastPhase: "C" }) }, "B")).toBe("B");
  });

  it("no --from + escalated → lastPhase", () => {
    expect(resolvePatchTargetPhase({ current: makeState({ phase: "escalated", lastPhase: "C" }) }, undefined)).toBe("C");
  });

  it("no --from + active phase → 'A'", () => {
    expect(resolvePatchTargetPhase({ current: makeState({ phase: "B" }) }, undefined)).toBe("A");
  });
});

// ================================================================
// cmdPatch — the /loop-patch handler (src/commands.ts:689-746)
// ================================================================

describe("cmdPatch", () => {
  it("returns the pinned description", () => {
    const cmd = cmdPatch({ current: makeState() }, makeApi(), debug);
    expect(cmd.description).toBe(
      "Patch the spec and restart from a phase: [spec-path] [--from <phase>]");
  });

  it("invalid --from → warning, no state change", async () => {
    const state = { current: makeState() };
    const ctx = makeCtx();
    await cmdPatch(state, makeApi(), debug).handler("--from zzz", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Invalid --from value: zzz. Use A, negotiate, B, or C.", "warning");
    expect(state.current.phase).toBe("B");
    expect(Commit.commit).not.toHaveBeenCalled();
  });

  it("idle → 'not running' warning", async () => {
    const state = { current: makeState({ phase: "idle" }) };
    const ctx = makeCtx();
    await cmdPatch(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Loop is not running. Use /loop <spec> to start.", "warning");
  });

  it("done → 'complete' warning", async () => {
    const state = { current: makeState({ phase: "done" }) };
    const ctx = makeCtx();
    await cmdPatch(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Loop is complete. Use /loop <spec> to start a new loop.", "warning");
  });

  it("spec file not found → error, no state change", async () => {
    (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const state = { current: makeState({ specPath: "missing.md" }) };
    const ctx = makeCtx();
    await cmdPatch(state, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Spec file not found: missing.md", "error");
    expect(state.current.lastPhase).toBe("A");
    expect(Commit.commit).not.toHaveBeenCalled();
  });

  it("happy path → appends the patch entry, mutates state, resets, commits, notifies, prompts", async () => {
    (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue("internal/spec.md");
    const state = { current: makeState({ phase: "B", round: 3 }) };
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdPatch(state, pi, debug).handler("", ctx);

    // Patch event recorded (best-effort)
    expect(pi.appendEntry).toHaveBeenCalledWith("loop-spec-patch", expect.objectContaining({
      specPath: "internal/spec.md",
      fromPhase: "B",
      toPhase: "A",
    }));

    // State mutation
    expect(state.current.phase).toBe("A");
    expect(state.current.lastPhase).toBe("B");
    expect(state.current.round).toBe(1); // resetPhaseState
    expect(state.current.justTransitioned).toBe(true);

    expect(Commit.commit).toHaveBeenCalledWith(state.current, pi, debug);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Spec patched. Restarting from Phase A, round 1.", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase A — round 1 (patched)");
    const sent = (Prompt.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sent).toContain("has been patched. Re-read it carefully.");
    expect(sent).toContain("Phase A");
  });

  it("escalated + no --from → restarts from lastPhase", async () => {
    (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue("internal/spec.md");
    const state = { current: makeState({ phase: "escalated", lastPhase: "C" }) };
    const ctx = makeCtx();
    await cmdPatch(state, makeApi(), debug).handler("", ctx);
    expect(state.current.phase).toBe("C");
    expect(state.current.lastPhase).toBe("escalated");
  });

  it("--from b → restarts from B even when escalated", async () => {
    (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue("internal/spec.md");
    const state = { current: makeState({ phase: "escalated", lastPhase: "C" }) };
    await cmdPatch(state, makeApi(), debug).handler("--from b", makeCtx());
    expect(state.current.phase).toBe("B");
  });

  it("appendEntry throwing (print mode) is swallowed — the patch proceeds", async () => {
    (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue("internal/spec.md");
    const state = { current: makeState() };
    const pi = { ...makeApi(), appendEntry: vi.fn(() => { throw new Error("no session"); }) } as unknown as ExtensionAPI;
    await cmdPatch(state, pi, debug).handler("", makeCtx());
    expect(state.current.phase).toBe("A");
    expect(Commit.commit).toHaveBeenCalled();
  });
});
