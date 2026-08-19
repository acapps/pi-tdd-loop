// Contract: internal/06-remove-monolith.md — remove the shim and consolidate
// the registration surface in src/events/index.ts (the barrel).
//
// The removed shim (the root-level src/events module file) is not a pure
// delegator: it owns raw-event extraction (B1) and a duplicate EventCtx (V1).
// Contract pinned here:
//   1. Deletion + placement — shim file gone; the four `event*` factories
//      live in the barrel verbatim, extraction lines included, using the
//      shortened ./X handler imports (B1).
//   2. Type surface — EventCtx has exactly one definition (V1); DebugFn is
//      moved and exported (V2); all existing type re-exports stay intact
//      (V3 — compile-time pin enforced by the tsc test below).
//   3. No behavioral change — each factory delegates to its handler with
//      exactly the same input object and extraction semantics (pathless
//      tools → path undefined, extraction never throws; null/undefined raw
//      events reject with TypeError exactly as the shim did — no added guard).
//   4. Entry point byte-identical (M3) — pinned by SHA-256.
//   5. Prose sweep (F3) — zero references to the removed file remain in
//      src/, test/, and index.ts.
//   6. tsc --noEmit clean (V3).
//
// NOTE: the F3 sweep scans this directory, so this file must not contain the
// literal two-word reference to the removed file; the needle is built
// at runtime for that reason.

import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as barrel from "../../src/events/index";
import * as sessionStartModule from "../../src/events/session-start";
import * as beforeAgentModule from "../../src/events/before-agent";
import * as toolCallModule from "../../src/events/tool-call";
import * as agentSettledModule from "../../src/events/agent-settled";
import type { LoopState } from "../../src/types";
import type { EventCtx, DebugFn } from "../../src/events/index";
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";

// ================================================================
// Compile-time type-surface pin (V3) — vitest erases these; the
// `tsc --noEmit` test below enforces them. Missing re-exports fail tsc.
// ================================================================

type _SessionStartHandler = import("../../src/events/index").SessionStartHandler;
type _BeforeAgentHandler = import("../../src/events/index").BeforeAgentHandler;
type _ToolCallHandler = import("../../src/events/index").ToolCallHandler;
type _AgentSettledDispatcher = import("../../src/events/index").AgentSettledDispatcher;
type _GateIn = import("../../src/events/index").GateHandlerInput;
type _GateOut = import("../../src/events/index").GateHandlerOutput;
type _EffectIn = import("../../src/events/index").EffectInput;
type _EffectOut = import("../../src/events/index").EffectResult;
type _ReviewIn = import("../../src/events/index").ReviewHandlerInput;
type _ReviewOut = import("../../src/events/index").ReviewHandlerOutput;
type _NegotiateIn = import("../../src/events/index").NegotiateHandlerInput;
type _NegotiateOut = import("../../src/events/index").NegotiateHandlerOutput;
type _DisputeIn = import("../../src/events/index").DisputeHandlerInput;
type _DisputeOut = import("../../src/events/index").DisputeHandlerOutput;

const _typeCheck: [
  _SessionStartHandler, _BeforeAgentHandler, _ToolCallHandler, _AgentSettledDispatcher,
  _GateIn, _GateOut, _EffectIn, _EffectOut, _ReviewIn, _ReviewOut,
  _NegotiateIn, _NegotiateOut, _DisputeIn, _DisputeOut,
] = null as any;
void _typeCheck;

// ================================================================
// Paths + references
// ================================================================

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Built at runtime so this file stays sweep-clean (F3).
const SHIM_PATH = path.join(ROOT, "src", "events" + ".ts");
const BARREL_PATH = path.join(ROOT, "src/events/index.ts");
const ENTRY_PATH = path.join(ROOT, "index.ts");

// SHA-256 of the root entry point (M3: must stay byte-identical). Re-baselined by
// spec 07 (Writer dispute, Phase B): the initial literal gained
// negotiateProposed/negotiateFeedback — +2 lines, the only spec-07 change to
// index.ts. Re-baselined again by internal/log-bug-spec.md (Writer dispute,
// Phase B): line 57 only — Cmd.cmdDebug() → Cmd.cmdDebug(state, debug) — the
// only log-bug change to index.ts. The registration-block diagnostic guard
// below still enforces the registration-surface invariant.
const ENTRY_SHA256 = "1bca9ee3e3716d8b9f04f06afb2df1144de7294b23e82f7b3c7622ba3d9e546e";

// F3 sweep needle (built to keep this file clean).
const NEEDLE = new RegExp("events" + String.raw`\.ts`);

// ================================================================
// Helpers
// ================================================================

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

function makeCtx(entries: unknown[] = []): EventCtx {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => entries,
    },
    cwd: "/tmp/test",
  };
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function srcFiles(): string[] {
  return listFiles(path.join(ROOT, "src"));
}

// ================================================================
// 1. Shim deletion + registration-surface placement (changes #1/#3)
// ================================================================

describe("shim deletion + registration-surface placement", () => {
  it("shim file does not exist (change #3)", () => {
    expect(existsSync(SHIM_PATH)).toBe(false);
  });

  it("barrel exists and its header names the registration surface (F4)", () => {
    expect(existsSync(BARREL_PATH)).toBe(true);
    const head = readFileSync(BARREL_PATH, "utf8")
      .split("\n")
      .slice(0, 10)
      .join("\n")
      .toLowerCase();
    expect(head).toContain("registration surface");
  });

  it("raw-event extraction lives in the barrel verbatim (B1)", () => {
    const src = readFileSync(BARREL_PATH, "utf8");
    expect(src).toMatch(/systemPrompt:\s*evt\.systemPrompt/);
    expect(src).toMatch(/toolName:\s*evt\.toolName/);
    expect(src).toMatch(/input\?\.path/); // pathless-tool guard — load-bearing
  });

  it("handler imports use the shortened ./X paths (B1 import inventory)", () => {
    const src = readFileSync(BARREL_PATH, "utf8");
    for (const mod of ["session-start", "before-agent", "tool-call", "agent-settled"]) {
      expect(src, `barrel imports from ./${mod}`).toMatch(
        new RegExp(`from ['"]\\./${mod}(\\.(js|ts))?['"]`),
      );
    }
    expect(src, "no pre-move ./events/ import paths remain in the barrel").not.toMatch(
      /from ['"]\.\/events\//,
    );
  });

  it("EventCtx has exactly one definition across src/ (V1)", () => {
    const defs: string[] = [];
    for (const file of srcFiles()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((ln, i) => {
          if (/interface\s+EventCtx\b/.test(ln)) defs.push(`${path.relative(ROOT, file)}:${i + 1}`);
        });
    }
    expect(defs).toHaveLength(1);
    expect(defs[0]).toContain("src/events/index.ts");
  });

  it("DebugFn is defined only in the barrel, exported (V2)", () => {
    const barrelSrc = readFileSync(BARREL_PATH, "utf8");
    expect(barrelSrc).toMatch(/export\s+type\s+DebugFn\s*=/);
    const defs: string[] = [];
    for (const file of srcFiles()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((ln) => {
          if (/type\s+DebugFn\s*=/.test(ln)) defs.push(path.relative(ROOT, file));
        });
    }
    expect(defs).toEqual(["src/events/index.ts"]);
  });
});

// ================================================================
// 2. Barrel runtime surface (F2 + scope line)
// ================================================================

describe("barrel runtime surface", () => {
  it("exports the four factories by name, each a function (F2)", () => {
    expect(typeof barrel.eventSessionStart).toBe("function");
    expect(typeof barrel.eventBeforeAgentStart).toBe("function");
    expect(typeof barrel.eventToolCall).toBe("function");
    expect(typeof barrel.eventAgentSettled).toBe("function");
  });

  it("runtime exports are exactly the four factories — no other additions (scope line)", async () => {
    const mod = await import("../../src/events/index");
    expect(Object.keys(mod).sort()).toEqual([
      "eventAgentSettled",
      "eventBeforeAgentStart",
      "eventSessionStart",
      "eventToolCall",
    ]);
  });

  it("EventCtx is importable with the exact ctx shape (V1 type surface)", () => {
    const ctx: EventCtx = {
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getEntries: () => [] },
      cwd: "/tmp/test",
    };
    expect(ctx.sessionManager.getEntries()).toEqual([]);
    expect(ctx.cwd).toBe("/tmp/test");
  });

  it("DebugFn is importable and callable (V2 type surface)", () => {
    const debug: DebugFn = (msg: string) => {
      expect(typeof msg).toBe("string");
    };
    debug("x");
    expect(typeof debug).toBe("function");
  });
});

// ================================================================
// 3. Extension entry point byte-identical (M3)
// ================================================================

describe("extension entry point (M3)", () => {
  it("root index.ts is byte-identical to the pre-change reference", () => {
    const live = readFileSync(ENTRY_PATH);
    expect(createHash("sha256").update(live).digest("hex")).toBe(ENTRY_SHA256);
  });

  it("registration block intact (diagnostic guard)", () => {
    const src = readFileSync(ENTRY_PATH, "utf8");
    expect(src).toContain('import * as Ev from "./src/events";');
    expect(src).toContain('pi.on("session_start", Ev.eventSessionStart(state, pi, debug));');
    expect(src).toContain('pi.on("before_agent_start", Ev.eventBeforeAgentStart(state, pi, debug));');
    expect(src).toContain('pi.on("tool_call", Ev.eventToolCall(state, pi, debug));');
    expect(src).toContain('pi.on("agent_settled", Ev.eventAgentSettled(state, pi, debug));');
  });
});

// ================================================================
// 4. Prose sweep — zero references to the removed file (F3)
// ================================================================

describe("prose sweep (F3)", () => {
  it("zero matches across src/, test/, and index.ts", () => {
    const targets = [
      ...listFiles(path.join(ROOT, "src")),
      ...listFiles(path.join(ROOT, "test")),
      ENTRY_PATH,
    ];
    const hits: string[] = [];
    for (const file of targets) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable/binary — skip
      }
      text.split("\n").forEach((ln, i) => {
        if (NEEDLE.test(ln)) hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

// ================================================================
// 5. Type-check (V3) — vitest does not type-check; this does.
// ================================================================

describe("type-check (V3)", () => {
  it("tsc --noEmit is clean", () => {
    const res = spawnSync(
      process.execPath,
      [path.join(ROOT, "node_modules/typescript/lib/tsc.js"), "--noEmit"],
      { cwd: ROOT, encoding: "utf8", timeout: 180_000 },
    );
    expect(res.status, `tsc failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
  }, 240_000);
});

// ================================================================
// 6. Factory behavior — no behavioral change (delegation + extraction)
// ================================================================

describe("session_start factory — delegation contract", () => {
  it("is a factory: (state, pi, debug) → (event, ctx) → Promise", () => {
    const handler = barrel.eventSessionStart(
      { current: makeState() },
      createMockExtensionAPI(),
      vi.fn(),
    );
    expect(typeof handler).toBe("function");
  });

  it("delegates exactly once with exactly {state, ctx, debug} — identity and shape", async () => {
    const spy = vi.spyOn(sessionStartModule, "handleSessionStart").mockImplementation(() => {});
    try {
      const state = { current: makeState() };
      const pi = createMockExtensionAPI();
      const debug = vi.fn();
      const ctx = makeCtx([]);
      const handler = barrel.eventSessionStart(state, pi, debug);
      await handler({ type: "session_start", reason: "reload" }, ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input).toEqual({ state, ctx, debug });
      expect(input.state).toBe(state);
      expect(input.ctx).toBe(ctx);
      expect(input.debug).toBe(debug);
      expect(Object.keys(input).sort()).toEqual(["ctx", "debug", "state"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("event argument is ignored — null/undefined events still delegate unchanged", async () => {
    const spy = vi.spyOn(sessionStartModule, "handleSessionStart").mockImplementation(() => {});
    try {
      const state = { current: makeState() };
      const debug = vi.fn();
      const ctx = makeCtx([]);
      const handler = barrel.eventSessionStart(state, createMockExtensionAPI(), debug);
      await handler(null, ctx);
      await handler(undefined, ctx);
      expect(spy).toHaveBeenCalledTimes(2);
      for (const [input] of spy.mock.calls) {
        expect(input.state).toBe(state);
        expect(input.ctx).toBe(ctx);
        expect(input.debug).toBe(debug);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves to undefined (void delegate — return shape unchanged)", async () => {
    const spy = vi.spyOn(sessionStartModule, "handleSessionStart").mockImplementation(() => {});
    try {
      const handler = barrel.eventSessionStart(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      expect(await handler({}, makeCtx([]))).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("before_agent_start factory — extraction + delegation contract", () => {
  it("extracts systemPrompt and delegates with exactly {state, pi, debug, systemPrompt}", async () => {
    const spy = vi.spyOn(beforeAgentModule, "handleBeforeAgent").mockImplementation(() => undefined);
    try {
      const state = { current: makeState({ phase: "A" }) };
      const pi = createMockExtensionAPI();
      const debug = vi.fn();
      const handler = barrel.eventBeforeAgentStart(state, pi, debug);
      await handler({ systemPrompt: "BASE PROMPT", extraField: "dropped" });
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input.systemPrompt).toBe("BASE PROMPT");
      expect(input.state).toBe(state);
      expect(input.pi).toBe(pi);
      expect(input.debug).toBe(debug);
      expect(Object.keys(input).sort()).toEqual(["debug", "pi", "state", "systemPrompt"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("empty event object → systemPrompt undefined (extraction does not throw)", async () => {
    const spy = vi.spyOn(beforeAgentModule, "handleBeforeAgent").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventBeforeAgentStart(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await handler({});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].systemPrompt).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("empty string systemPrompt passes through verbatim (single element)", async () => {
    const spy = vi.spyOn(beforeAgentModule, "handleBeforeAgent").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventBeforeAgentStart(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await handler({ systemPrompt: "" });
      expect(spy.mock.calls[0][0].systemPrompt).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves to exactly the delegate's return value (return shape unchanged)", async () => {
    const sentinel = { message: { customType: "loop-context", content: "S", display: false }, systemPrompt: "S" };
    const spy = vi.spyOn(beforeAgentModule, "handleBeforeAgent").mockImplementation(() => sentinel as any);
    try {
      const handler = barrel.eventBeforeAgentStart(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      expect(await handler({ systemPrompt: "p" })).toBe(sentinel);
    } finally {
      spy.mockRestore();
    }
  });

  it("null/undefined raw event → rejects with TypeError (verbatim extraction, no added guard)", async () => {
    const spy = vi.spyOn(beforeAgentModule, "handleBeforeAgent").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventBeforeAgentStart(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await expect(handler(null)).rejects.toThrow(TypeError);
      await expect(handler(undefined)).rejects.toThrow(TypeError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("tool_call factory — extraction + delegation contract", () => {
  it("extracts toolName + path and delegates with exactly {state, pi, debug, toolName, path, ctx}", async () => {
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => undefined);
    try {
      const state = { current: makeState({ phase: "B" }) };
      const pi = createMockExtensionAPI();
      const debug = vi.fn();
      const ctx = makeCtx([]);
      const handler = barrel.eventToolCall(state, pi, debug);
      await handler({ toolName: "write", input: { path: "/tmp/x.txt" } }, ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input.toolName).toBe("write");
      expect(input.path).toBe("/tmp/x.txt");
      expect(input.state).toBe(state);
      expect(input.pi).toBe(pi);
      expect(input.debug).toBe(debug);
      expect(input.ctx).toBe(ctx);
      expect(Object.keys(input).sort()).toEqual(["ctx", "debug", "path", "pi", "state", "toolName"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("pathless tool (no input key) → path undefined, extraction never throws (load-bearing)", async () => {
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventToolCall(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      const result = await handler({ toolName: "bash" }, makeCtx([]));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].path).toBeUndefined();
      expect(result).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("input present but empty → path undefined", async () => {
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventToolCall(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await handler({ toolName: "bash", input: {} }, makeCtx([]));
      expect(spy.mock.calls[0][0].path).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("input null → path undefined (?. guard)", async () => {
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventToolCall(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await handler({ toolName: "bash", input: null as any }, makeCtx([]));
      expect(spy.mock.calls[0][0].path).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("extra input keys are dropped — only path is extracted", async () => {
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventToolCall(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await handler({ toolName: "write", input: { path: "/x", other: "1" } }, makeCtx([]));
      const input = spy.mock.calls[0][0];
      expect(input.path).toBe("/x");
      expect(input).not.toHaveProperty("other");
    } finally {
      spy.mockRestore();
    }
  });

  it("empty toolName passes through verbatim (single element)", async () => {
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventToolCall(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await handler({ toolName: "", input: undefined }, makeCtx([]));
      expect(spy.mock.calls[0][0].toolName).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves to exactly the delegate's return value (block result passthrough)", async () => {
    const sentinel = { block: true, reason: "S" } as any;
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => sentinel);
    try {
      const handler = barrel.eventToolCall(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      expect(await handler({ toolName: "write", input: { path: "/x" } }, makeCtx([]))).toBe(sentinel);
    } finally {
      spy.mockRestore();
    }
  });

  it("null/undefined raw event → rejects with TypeError (verbatim extraction, no added guard)", async () => {
    const spy = vi.spyOn(toolCallModule, "handleToolCall").mockImplementation(() => undefined);
    try {
      const handler = barrel.eventToolCall(
        { current: makeState() },
        createMockExtensionAPI(),
        vi.fn(),
      );
      await expect(handler(null, makeCtx([]))).rejects.toThrow(TypeError);
      await expect(handler(undefined, makeCtx([]))).rejects.toThrow(TypeError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("agent_settled factory — delegation contract", () => {
  it("delegates with exactly {state, pi, debug, ctx} — the event never reaches the delegate", async () => {
    const spy = vi.spyOn(agentSettledModule, "handleAgentSettled").mockImplementation(async () => true);
    try {
      const state = { current: makeState({ phase: "B" }) };
      const pi = createMockExtensionAPI();
      const debug = vi.fn();
      const ctx = makeCtx([]);
      const handler = barrel.eventAgentSettled(state, pi, debug);
      await handler({ phase: "B", whatever: 1 }, ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      const input = spy.mock.calls[0][0];
      expect(input.state).toBe(state);
      expect(input.pi).toBe(pi);
      expect(input.debug).toBe(debug);
      expect(input.ctx).toBe(ctx);
      expect(Object.keys(input).sort()).toEqual(["ctx", "debug", "pi", "state"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("null/undefined events still delegate (event ignored)", async () => {
    const spy = vi.spyOn(agentSettledModule, "handleAgentSettled").mockImplementation(async () => true);
    try {
      const state = { current: makeState() };
      const ctx = makeCtx([]);
      const debug = vi.fn();
      const handler = barrel.eventAgentSettled(state, createMockExtensionAPI(), debug);
      await handler(null, ctx);
      await handler(undefined, ctx);
      expect(spy).toHaveBeenCalledTimes(2);
      for (const [input] of spy.mock.calls) {
        expect(input.state).toBe(state);
        expect(input.ctx).toBe(ctx);
        expect(input.debug).toBe(debug);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves to exactly the delegate's return value (boolean | undefined passthrough)", async () => {
    const spy = vi.spyOn(agentSettledModule, "handleAgentSettled");
    try {
      const state = { current: makeState() };
      const pi = createMockExtensionAPI();
      const debug = vi.fn();
      const ctx = makeCtx([]);
      const handler = barrel.eventAgentSettled(state, pi, debug);
      spy.mockImplementation(async () => true);
      expect(await handler({}, ctx)).toBe(true);
      spy.mockImplementation(async () => undefined);
      expect(await handler({}, ctx)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
