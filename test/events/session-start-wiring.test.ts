// Contract: internal/01-wire-session-start.md
//
// `handleSessionStart` (src/events/session-start.ts) is already implemented and
// covered by test/events/session-start.test.ts. This spec is wiring-only: the
// `eventSessionStart` factory in the registration barrel (src/events/index.ts)
// must DELEGATE to it, the duplicate helpers must be removed from the barrel,
// and the extension entry point registration is unchanged. No new source module
// is stubbed in Phase A — stubbing the barrel would destroy the registration
// surface the other 780+ tests depend on.
//
// Contract pinned here:
//   1. Delegation — eventSessionStart calls handleSessionStart with exactly
//      {state, ctx, debug} and keeps no restore logic of its own.
//   2. Behavior   — state restoration on reload is unchanged (regression guard).
//      Defensive edge cases (undefined/null entries, missing sessionManager)
//      pin the module's already-implemented no-throw behavior, which becomes
//      the extension's behavior once delegation lands (the old monolith threw).
//   3. Cleanup    — duplicate helpers removed from the barrel; public event
//      factory exports unchanged.
//   4. Seam       — the extension factory (index.ts) still registers
//      session_start through eventSessionStart and restores end-to-end.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as sessionStartModule from "../../src/events/session-start";
import * as Events from "../../src/events";
import { eventSessionStart } from "../../src/events";
import type { LoopState } from "../../src/types";
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";
import extensionFactory from "../../index";

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

function makeCtx(entries: unknown[] = []): any {
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

function loopStateEntry(data: Partial<LoopState>): { type: string; customType: string; data: LoopState } {
  return { type: "custom", customType: "loop-state", data: makeState(data) };
}

function makeInput(entries: unknown[], stateOverrides: Partial<LoopState> = {}) {
  const state = { current: makeState(stateOverrides) };
  const ctx = makeCtx(entries);
  const debug = vi.fn();
  const handler = eventSessionStart(state, createMockExtensionAPI(), debug);
  return { state, ctx, debug, handler };
}

// ================================================================
// 1. Delegation — eventSessionStart → handleSessionStart
// ================================================================

describe("eventSessionStart → handleSessionStart (delegation)", () => {
  it("is an exported factory: (state, pi, debug) → async (event, ctx) handler", () => {
    expect(typeof eventSessionStart).toBe("function");
    const handler = eventSessionStart(
      { current: makeState() },
      createMockExtensionAPI(),
      vi.fn(),
    );
    expect(typeof handler).toBe("function");
  });

  it("calls handleSessionStart exactly once with {state, ctx, debug}", async () => {
    const spy = vi
      .spyOn(sessionStartModule, "handleSessionStart")
      .mockImplementation(() => {});
    try {
      const { state, ctx, debug, handler } = makeInput([]);
      await handler({ type: "session_start", reason: "reload" }, ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ state, ctx, debug });
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps no restore logic of its own (no-op module ⇒ no restore side effects)", async () => {
    const spy = vi
      .spyOn(sessionStartModule, "handleSessionStart")
      .mockImplementation(() => {});
    try {
      const entry = loopStateEntry({ phase: "B", round: 3 });
      const { state, ctx, handler } = makeInput([entry], { phase: "A", round: 1 });
      await handler({}, ctx);
      // If the monolith still ran its own restoreState, state would be mutated.
      expect(state.current.phase).toBe("A");
      expect(state.current.round).toBe(1);
      expect(state.current).not.toBe(entry.data);
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("mutations made by handleSessionStart are visible through the state wrapper", async () => {
    const entry = loopStateEntry({ phase: "B", round: 3 });
    const { state, ctx, handler } = makeInput([entry]);
    await handler({}, ctx);
    // The handler must expose the delegate's assignment: state.current === entry.data
    expect(state.current).toBe(entry.data);
    expect(state.current.phase).toBe("B");
  });

  it("handler resolves to undefined (return shape unchanged)", async () => {
    const { handler } = makeInput([]);
    expect(await handler({}, makeCtx([]))).toBeUndefined();
  });

  it("does not persist anything via the pi API (session_start had no appendEntry before)", async () => {
    const pi = createMockExtensionAPI();
    const handler = eventSessionStart(
      { current: makeState() },
      pi,
      vi.fn(),
    );
    await handler({}, makeCtx([loopStateEntry({ phase: "B", round: 2 })]));
    expect(pi.appendedEntries).toHaveLength(0);
    expect(pi.sentMessages).toHaveLength(0);
  });
});

// ================================================================
// 2. State restoration on reload — no behavioral change (regression guard)
// ================================================================

describe("state restoration on reload (no behavioral change)", () => {
  it("restores phase/round/specPath from the last loop-state entry and sets status", async () => {
    const entry = loopStateEntry({
      phase: "B",
      round: 3,
      specPath: "internal/01-wire-session-start.md",
    });
    const { state, ctx, handler } = makeInput([entry]);
    await handler({}, ctx);
    expect(state.current.phase).toBe("B");
    expect(state.current.round).toBe(3);
    expect(state.current.specPath).toBe("internal/01-wire-session-start.md");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 3");
  });

  it("clears transient flags and preserves persistent fields", async () => {
    const entry = loopStateEntry({
      phase: "C",
      round: 2,
      disputeMode: true,
      justTransitioned: true,
      negotiateReprompted: true,
      awaitDisputeFix: true,
      awaitDisputeReview: true,
      disputeCount: 2,
      lastProposal: "keep this",
      lastPhase: "B",
    });
    const { state, handler } = makeInput([entry]);
    await handler({}, makeCtx([entry]));
    expect(state.current.disputeMode).toBe(false);
    expect(state.current.justTransitioned).toBe(false);
    expect(state.current.negotiateReprompted).toBe(false);
    expect(state.current.awaitDisputeFix).toBe(false);
    expect(state.current.awaitDisputeReview).toBe(false);
    // Persistent fields survive
    expect(state.current.disputeCount).toBe(2);
    expect(state.current.lastProposal).toBe("keep this");
    expect(state.current.lastPhase).toBe("B");
  });

  it("uses the LAST loop-state entry when multiple entries exist", async () => {
    const first = loopStateEntry({ phase: "A", round: 1 });
    const middle = loopStateEntry({ phase: "C", round: 2 });
    const last = loopStateEntry({ phase: "B", round: 5 });
    const entries = [
      first,
      { type: "custom", customType: "loop-debug", data: { msg: "x" } },
      middle,
      { type: "user" },
      last,
    ];
    const { state, ctx, handler } = makeInput(entries);
    await handler({}, ctx);
    expect(state.current).toBe(last.data);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 5");
  });

  it("single-element entries: one loop-state entry restores", async () => {
    const entry = loopStateEntry({ phase: "negotiate", round: 1 });
    const { state, ctx, handler } = makeInput([entry]);
    await handler({}, ctx);
    expect(state.current.phase).toBe("negotiate");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase negotiate — round 1");
  });

  it("empty entries: state untouched, no status update, no throw, debug called", async () => {
    const { state, ctx, debug, handler } = makeInput([], { phase: "A", round: 1 });
    const before = state.current;
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(state.current).toBe(before);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("session_start"));
  });

  it("entries without any loop-state entry: state untouched, no status update", async () => {
    const entries = [
      { type: "custom", customType: "loop-debug", data: { msg: "hi" } },
      { type: "user", text: "hello" },
      { type: "custom", customType: "other" },
    ];
    const { state, ctx, handler } = makeInput(entries, { phase: "B", round: 2 });
    const before = state.current;
    await handler({}, ctx);
    expect(state.current).toBe(before);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("loop-state entry with undefined data: no restore, state untouched", async () => {
    const entries = [{ type: "custom", customType: "loop-state", data: undefined }];
    const { state, ctx, handler } = makeInput(entries, { phase: "A" });
    const before = state.current;
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(state.current).toBe(before);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("getEntries() returning undefined: no throw, state untouched", async () => {
    const ctx = makeCtx([]);
    ctx.sessionManager.getEntries = () => undefined;
    const { state, handler } = makeInput([]);
    const before = state.current;
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(state.current).toBe(before);
  });

  it("getEntries() returning null: no throw, state untouched", async () => {
    const ctx = makeCtx([]);
    ctx.sessionManager.getEntries = () => null;
    const { state, handler } = makeInput([]);
    const before = state.current;
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(state.current).toBe(before);
  });

  it("sessionManager missing entirely: no throw, state untouched", async () => {
    const { state, handler } = makeInput([]);
    const ctx: any = { ui: { notify: vi.fn(), setStatus: vi.fn() }, cwd: "/tmp/test" };
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(state.current.phase).toBe("idle");
  });

  it("null cwd: restoration still works", async () => {
    const entry = loopStateEntry({ phase: "B", round: 3 });
    const ctx = makeCtx([entry]);
    ctx.cwd = null;
    const { state, handler } = makeInput([entry]);
    await expect(handler({}, ctx)).resolves.toBeUndefined();
    expect(state.current.phase).toBe("B");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 3");
  });

  it("debug log is prefixed with session_start on the no-state path", async () => {
    const { debug, handler } = makeInput([]);
    await handler({}, makeCtx([]));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("session_start"));
  });
});

// ================================================================
// 3. Monolith cleanup — spec change item 2
// ================================================================

describe("monolith cleanup (duplicate helpers removed)", () => {
  function readEventsSource(): string {
    return readFileSync(new URL("../../src/events/index.ts", import.meta.url), "utf8");
  }

  it("imports handleSessionStart from ./session-start", () => {
    expect(readEventsSource()).toMatch(
      /from\s+['"]\.\/session-start(\.js)?['"]/,
    );
  });

  it("no longer defines restoreState / findLastLoopState / clearTransientFlags", () => {
    const src = readEventsSource();
    for (const name of ["restoreState", "findLastLoopState", "clearTransientFlags"]) {
      expect(src, `${name} should be removed from src/events/index.ts`).not.toMatch(
        new RegExp(`(function\\s+|const\\s+)${name}\\b`),
      );
    }
  });

  it("still exports eventSessionStart (registration surface unchanged)", () => {
    expect(typeof Events.eventSessionStart).toBe("function");
  });

  it("still exports the other event factories", () => {
    expect(typeof Events.eventBeforeAgentStart).toBe("function");
    expect(typeof Events.eventToolCall).toBe("function");
    expect(typeof Events.eventAgentSettled).toBe("function");
  });
});

// ================================================================
// 4. Entry point seam — index.ts registration unchanged
// ================================================================

describe("extension entry point (index.ts) — session_start seam", () => {
  it("factory registers session_start through eventSessionStart and restores end-to-end", async () => {
    const api = createMockExtensionAPI();
    extensionFactory(api);

    const handlers = api.eventHandlers.get("session_start") ?? [];
    expect(handlers.length).toBeGreaterThan(0);

    const ui = { notify: vi.fn(), setStatus: vi.fn() };
    const entries = [
      {
        type: "custom",
        customType: "loop-state",
        data: {
          phase: "B",
          round: 3,
          specPath: "spec.md",
          language: "go",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          maxTurnsPerPhase: 5,
          coverageThreshold: 90,
          disputeMode: true, // should be cleared
          disputeCount: 1,
          turnsThisPhase: 0,
          lastProposal: "some plan",
          lastPhase: "A",
          justTransitioned: true, // should be cleared
          negotiateReprompted: false,
          awaitDisputeFix: false,
          awaitDisputeReview: false,
        },
      },
    ];
    const ctx = {
      ui,
      sessionManager: { getEntries: () => entries },
      cwd: "/tmp/test-project",
    };

    await handlers[0]({ type: "session_start", reason: "reload" }, ctx);

    // Restored + status reflects the restored state
    expect(ui.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 3");
  });

  it("factory registers no more than one session_start handler", () => {
    const api = createMockExtensionAPI();
    extensionFactory(api);
    expect(api.eventHandlers.get("session_start")?.length).toBe(1);
  });
});
