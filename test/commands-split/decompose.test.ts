// Contract tests for src/commands/decompose.ts — internal/refactor-commands-split.md
//
// Pins cmdDecompose + helpers (parseDecomposeArgs, derivePrefix,
// buildDecomposePrompt). Behavior is pinned VERBATIM from the current
// src/commands.ts (pure refactor — no behavioral change).
//
// Leaf modules (prompt, spec-path, selectors) are mocked; tests assert on
// the command layer's decision rows (usage / not-found / prompt send).
// Fast + hermetic: no process spawning, no temp-dir scaffolding.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState } from "../../src/types";

vi.mock("../../src/prompt", () => ({ sendPrompt: vi.fn() }));
vi.mock("../../src/spec-path", () => ({ resolveExistingSpec: vi.fn() }));
vi.mock("../../src/selectors", () => ({
  normalizeSpecPath: vi.fn((p: string) => p),
  formatStatus: vi.fn(),
}));

import { cmdDecompose, parseDecomposeArgs, derivePrefix, buildDecomposePrompt } from "../../src/commands/decompose";
import * as Prompt from "../../src/prompt";
import * as SpecPath from "../../src/spec-path";

beforeEach(() => {
  vi.clearAllMocks();
  (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue("big-spec.md");
});

// --- Fixtures -------------------------------------------------------------

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
    round: 1,
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
    disputeCount: 0,
    turnsThisPhase: 1,
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

describe("src/commands/decompose.ts — module contract", () => {
  it("exports cmdDecompose + the 3 decompose helpers", () => {
    expect(typeof cmdDecompose).toBe("function");
    expect(typeof parseDecomposeArgs).toBe("function");
    expect(typeof derivePrefix).toBe("function");
    expect(typeof buildDecomposePrompt).toBe("function");
  });
});

// ================================================================
// parseDecomposeArgs — verbatim from src/commands.ts:751-758
// ================================================================

describe("parseDecomposeArgs", () => {
  it("empty args → empty specPath, defaults out='internal', prefix=''", () => {
    expect(parseDecomposeArgs("")).toEqual({ specPath: "", outDir: "internal", prefix: "" });
  });

  it("positional spec + --out + --prefix", () => {
    expect(parseDecomposeArgs("big.md --out docs --prefix big")).toEqual({
      specPath: "big.md", outDir: "docs", prefix: "big",
    });
  });

  it("single element edge: only the spec path", () => {
    expect(parseDecomposeArgs("only.md")).toEqual({
      specPath: "only.md", outDir: "internal", prefix: "",
    });
  });
});

// ================================================================
// derivePrefix — verbatim from src/commands.ts:760-763
// ================================================================

describe("derivePrefix", () => {
  it("strips the .md extension and lowercases", () => {
    expect(derivePrefix("My Spec.md")).toBe("my-spec");
  });

  it("uses the basename of a nested path", () => {
    expect(derivePrefix("internal/deep/spec-name.md")).toBe("spec-name");
  });

  it("replaces non-alphanumerics with '-'", () => {
    expect(derivePrefix("a_b.c.md")).toBe("a-b-c");
  });

  it("no extension → the whole basename", () => {
    expect(derivePrefix("README")).toBe("readme");
  });

  it("empty path → '' (empty string, not 'spec')", () => {
    expect(derivePrefix("")).toBe("");
  });
});

// ================================================================
// buildDecomposePrompt — verbatim from src/commands.ts:765-781
// ================================================================

describe("buildDecomposePrompt", () => {
  it("embeds specPath, outDir, prefix in the output paths", () => {
    const p = buildDecomposePrompt("big.md", "docs", "big");
    expect(p).toContain("Read the spec at big.md.");
    expect(p).toContain("Write each unit as docs/big-<N>.md.");
    expect(p).toContain("Write a summary at docs/big-index.md");
  });

  it("keeps the pinned rules (max 5 units, no parent modification)", () => {
    const p = buildDecomposePrompt("s.md", "internal", "s");
    expect(p).toContain("Maximum 5 units.");
    expect(p).toContain("Do NOT modify the parent spec.");
  });
});

// ================================================================
// cmdDecompose — the /loop-decompose handler (src/commands.ts:783-810)
// ================================================================

describe("cmdDecompose", () => {
  it("returns the pinned description", () => {
    const cmd = cmdDecompose({ current: makeState() }, makeApi(), debug);
    expect(cmd.description).toBe(
      "Decompose a spec into sub-specs: <spec-path> [--out <dir>] [--prefix <slug>]");
  });

  it("row 0: no args → usage warning, no prompt", async () => {
    const ctx = makeCtx();
    await cmdDecompose({ current: makeState() }, makeApi(), debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /loop-decompose <spec-path> [--out <dir>] [--prefix <slug>]", "warning");
    expect(Prompt.sendPrompt).not.toHaveBeenCalled();
  });

  it("row 1: spec not found → error, no prompt", async () => {
    (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const ctx = makeCtx();
    await cmdDecompose({ current: makeState() }, makeApi(), debug).handler("missing.md", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Spec not found: missing.md", "error");
    expect(Prompt.sendPrompt).not.toHaveBeenCalled();
  });

  it("row 2: no --prefix → derives it from the spec filename", async () => {
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdDecompose({ current: makeState() }, pi, debug).handler("big-spec.md", ctx);
    const sent = (Prompt.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sent).toContain("internal/big-spec-<N>.md");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Decomposing big-spec.md into internal/big-spec-* ...", "info");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "decomposing: big-spec.md");
  });

  it("row 2: explicit --prefix + --out win over the derivation", async () => {
    const ctx = makeCtx();
    const pi = makeApi();
    await cmdDecompose({ current: makeState() }, pi, debug).handler("big-spec.md --out docs --prefix x", ctx);
    const sent = (Prompt.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(sent).toContain("docs/x-<N>.md");
  });

  it("sends the prompt with the current state", async () => {
    (SpecPath.resolveExistingSpec as ReturnType<typeof vi.fn>).mockReturnValue("s.md");
    const state = { current: makeState() };
    const pi = makeApi();
    await cmdDecompose(state, pi, debug).handler("s.md", makeCtx());
    expect(Prompt.sendPrompt).toHaveBeenCalledWith(
      pi, expect.stringContaining("Read the spec at s.md."), state.current, debug);
  });
});
