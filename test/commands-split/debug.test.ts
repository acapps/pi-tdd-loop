// Contract tests for src/commands/debug.ts — internal/refactor-commands-split.md
//
// Pins cmdDebug + the log-bug sub-command (parseLogBugArgs, showDebugLog,
// runLogBug, notifyBugSpecResult, SessionEntry, DEBUG_LOG_TYPES,
// isDebugLogEntry, entryTimestamp, extractDebugLogs).
//
// Behavior is pinned VERBATIM from the current src/commands.ts (pure
// refactor — no behavioral change). The leaf module src/bug-spec.ts is
// mocked; tests assert on the command layer's decisions (slug → result →
// notification). Fast + hermetic: no process spawning.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoopState } from "../../src/types";

vi.mock("../../src/bug-spec", () => ({
  slugBugName: vi.fn((name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")),
  extractLoopLogs: vi.fn(() => []),
  renderBugSpec: vi.fn(() => "# Bug: X"),
  writeBugSpec: vi.fn(),
}));

import {
  cmdDebug,
  parseLogBugArgs,
  showDebugLog,
  runLogBug,
  notifyBugSpecResult,
  DEBUG_LOG_TYPES,
  isDebugLogEntry,
  entryTimestamp,
  extractDebugLogs,
} from "../../src/commands/debug";
import * as BugSpec from "../../src/bug-spec";

beforeEach(() => {
  vi.clearAllMocks();
  (BugSpec.slugBugName as ReturnType<typeof vi.fn>).mockImplementation(
    (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
  (BugSpec.extractLoopLogs as ReturnType<typeof vi.fn>).mockReturnValue([]);
  (BugSpec.renderBugSpec as ReturnType<typeof vi.fn>).mockReturnValue("# Bug: X");
});

// --- Fixtures -------------------------------------------------------------

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
    round: 2,
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

function makeCtx(entries: unknown[] = []) {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => entries },
    cwd: "/tmp/proj",
  } as any;
}

const debug = () => {};

// ================================================================
// Module contract (spec: Target Structure — debug.ts inventory)
// ================================================================

describe("src/commands/debug.ts — module contract", () => {
  it("exports cmdDebug, the 4 log-bug functions, and the 5 log helpers", () => {
    expect(typeof cmdDebug).toBe("function");
    expect(typeof parseLogBugArgs).toBe("function");
    expect(typeof showDebugLog).toBe("function");
    expect(typeof runLogBug).toBe("function");
    expect(typeof notifyBugSpecResult).toBe("function");
    expect(typeof DEBUG_LOG_TYPES).toBe("object");
    expect(typeof isDebugLogEntry).toBe("function");
    expect(typeof entryTimestamp).toBe("function");
    expect(typeof extractDebugLogs).toBe("function");
  });

  it("DEBUG_LOG_TYPES is the pinned 5-entry closed set", () => {
    expect(new Set(DEBUG_LOG_TYPES)).toEqual(
      new Set(["loop-debug", "loop-gate", "loop-refusal", "loop-negotiate", "loop-dispute"]));
  });
});

// ================================================================
// parseLogBugArgs — verbatim from src/commands.ts:481-496
// ================================================================

describe("parseLogBugArgs", () => {
  it("no flag → null (legacy mode)", () => {
    expect(parseLogBugArgs("")).toBeNull();
    expect(parseLogBugArgs("   ")).toBeNull();
    expect(parseLogBugArgs("--other foo")).toBeNull();
  });

  it("space form: leftmost --log-bug, name = following non--- tokens joined with ' '", () => {
    expect(parseLogBugArgs("--log-bug my bug name")).toEqual({ name: "my bug name" });
    expect(parseLogBugArgs("--log-bug name --other")).toEqual({ name: "name" });
    expect(parseLogBugArgs("--log-bug")).toEqual({ name: "" });
  });

  it("space form consumes tokens after other leading args", () => {
    expect(parseLogBugArgs("foo --log-bug a b")).toEqual({ name: "a b" });
  });

  it("equals form: value after = taken verbatim (single token)", () => {
    expect(parseLogBugArgs("--log-bug=my")).toEqual({ name: "my" });
    expect(parseLogBugArgs("--log-bug=")).toEqual({ name: "" });
  });

  it("leftmost flag wins when both forms appear", () => {
    expect(parseLogBugArgs("--log-bug=a --log-bug b")).toEqual({ name: "a" });
    expect(parseLogBugArgs("--log-bug b --log-bug=c")).toEqual({ name: "b" });
  });
});

// ================================================================
// isDebugLogEntry / entryTimestamp / extractDebugLogs — verbatim
// from src/commands.ts:551-582
// ================================================================

describe("isDebugLogEntry", () => {
  it("accepts only type:'custom' with a customType in the closed set", () => {
    expect(isDebugLogEntry({ type: "custom", customType: "loop-debug" })).toBe(true);
    expect(isDebugLogEntry({ type: "custom", customType: "loop-gate" })).toBe(true);
    expect(isDebugLogEntry({ type: "custom", customType: "unknown-type" })).toBe(false);
    expect(isDebugLogEntry({ type: "message", customType: "loop-debug" })).toBe(false);
    expect(isDebugLogEntry({})).toBe(false);
    expect(isDebugLogEntry({ type: "custom", customType: 42 })).toBe(false);
  });
});

describe("entryTimestamp", () => {
  it("data.ts number → ISO string", () => {
    expect(entryTimestamp({ data: { ts: 0 } })).toBe(new Date(0).toISOString());
  });

  it("string timestamp (no data.ts) → returned verbatim", () => {
    expect(entryTimestamp({ timestamp: "2026-01-01T00:00:00.000Z" }))
      .toBe("2026-01-01T00:00:00.000Z");
  });

  it("data.ts takes precedence over timestamp", () => {
    expect(entryTimestamp({ data: { ts: 0 }, timestamp: "x" }))
      .toBe(new Date(0).toISOString());
  });

  it("neither → '-'", () => {
    expect(entryTimestamp({})).toBe("-");
    expect(entryTimestamp({ data: null })).toBe("-");
    expect(entryTimestamp({ data: { ts: "not-a-number" } })).toBe("-");
  });
});

describe("extractDebugLogs", () => {
  it("empty entries → []", () => {
    expect(extractDebugLogs([])).toEqual([]);
  });

  it("filters non-debug entries and formats the rest", () => {
    const out = extractDebugLogs([
      { type: "message" },
      { type: "custom", customType: "loop-state" },
      { type: "custom", customType: "loop-debug", timestamp: "T1" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("loop-debug");
    expect(out[0]).toContain("T1");
  });

  it("single element edge: one matching entry", () => {
    const out = extractDebugLogs([{ type: "custom", customType: "loop-gate" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("loop-gate");
    expect(out[0]).toContain("[-]");
  });
});

// ================================================================
// showDebugLog — verbatim from src/commands.ts:498-503
// ================================================================

describe("showDebugLog", () => {
  it("notifies the entry count + the last 20 lines", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      type: "custom", customType: "loop-debug", timestamp: `T${i}`,
    }));
    const ctx = makeCtx(entries);
    showDebugLog(ctx);
    const [msg, level] = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(level).toBe("info");
    expect(msg).toContain("Loop debug (25 entries):");
    expect(msg).toContain("T24"); // last entry
    expect(msg).not.toContain("T3]"); // entries beyond the last 20 are cut
  });

  it("no entries → '0 entries' with an empty body", () => {
    const ctx = makeCtx([]);
    showDebugLog(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop debug (0 entries):"), "info");
  });
});

// ================================================================
// runLogBug — verbatim from src/commands.ts:505-527
// ================================================================

describe("runLogBug", () => {
  it("empty slug → usage warning, no render/write", () => {
    (BugSpec.slugBugName as ReturnType<typeof vi.fn>).mockReturnValue("");
    const ctx = makeCtx();
    runLogBug({ current: makeState() }, debug, ctx, "!!!");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /loop-debug --log-bug <name>", "warning");
    expect(BugSpec.renderBugSpec).not.toHaveBeenCalled();
    expect(BugSpec.writeBugSpec).not.toHaveBeenCalled();
  });

  it("renders with state fields + extracted logs, then writes to ctx.cwd", () => {
    (BugSpec.slugBugName as ReturnType<typeof vi.fn>).mockReturnValue("my-bug");
    (BugSpec.extractLoopLogs as ReturnType<typeof vi.fn>).mockReturnValue(["line1"]);
    (BugSpec.writeBugSpec as ReturnType<typeof vi.fn>).mockReturnValue(
      { ok: true, path: "/tmp/proj/bug-fix-my-bug.md" });
    const state = { current: makeState({ phase: "B", round: 2 }) };
    const ctx = makeCtx();
    runLogBug(state, debug, ctx, "My Bug");

    expect(BugSpec.renderBugSpec).toHaveBeenCalledWith({
      name: "My Bug",
      slug: "my-bug",
      phase: "B",
      round: 2,
      specPath: "internal/spec.md",
      language: "go",
      lines: ["line1"],
      now: expect.any(Date),
    });
    expect(BugSpec.writeBugSpec).toHaveBeenCalledWith("/tmp/proj", "my-bug", expect.any(String));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("bug-fix-my-bug.md"), "info");
  });
});

// ================================================================
// notifyBugSpecResult — verbatim from src/commands.ts:529-547
// ================================================================

describe("notifyBugSpecResult", () => {
  it("ok → info notification naming the file", () => {
    const ctx = makeCtx();
    notifyBugSpecResult(ctx, debug, { ok: true, path: "p" }, "slug");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("bug-fix-slug.md"), "info");
  });

  it("reason 'exists' → error 'already exists'", () => {
    const ctx = makeCtx();
    notifyBugSpecResult(ctx, debug, { ok: false, reason: "exists", message: "" }, "slug");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "bug-fix-slug.md already exists. Pick a different name.", "error");
  });

  it("reason 'write-failed' → error with the failure message", () => {
    const ctx = makeCtx();
    notifyBugSpecResult(ctx, debug, { ok: false, reason: "write-failed", message: "EACCES" }, "slug");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Failed to write bug-fix-slug.md: EACCES", "error");
  });
});

// ================================================================
// cmdDebug — the /loop-debug handler (src/commands.ts:456-470)
// ================================================================

describe("cmdDebug", () => {
  it("no --log-bug → legacy showDebugLog path", async () => {
    const ctx = makeCtx([]);
    await cmdDebug({ current: makeState() }, debug).handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop debug (0 entries):"), "info");
    expect(BugSpec.writeBugSpec).not.toHaveBeenCalled();
  });

  it("--log-bug <name> → runLogBug path (writes the bug spec)", async () => {
    (BugSpec.slugBugName as ReturnType<typeof vi.fn>).mockReturnValue("x");
    (BugSpec.writeBugSpec as ReturnType<typeof vi.fn>).mockReturnValue(
      { ok: true, path: "p" });
    const ctx = makeCtx();
    await cmdDebug({ current: makeState() }, debug).handler("--log-bug x", ctx);
    expect(BugSpec.writeBugSpec).toHaveBeenCalled();
  });

  it("--log-bug with unsluggable name → usage warning", async () => {
    (BugSpec.slugBugName as ReturnType<typeof vi.fn>).mockReturnValue("");
    const ctx = makeCtx();
    await cmdDebug({ current: makeState() }, debug).handler("--log-bug ???", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /loop-debug --log-bug <name>", "warning");
  });
});
