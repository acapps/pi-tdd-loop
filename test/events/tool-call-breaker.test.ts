// Contract tests for the tool_call repeated-call breaker.
// Spec: internal/bug-negotiate-confirm-approval-loop.md §4 (Behavior §4,
// Acceptance Criteria "Breaker pin").
//
// Pinned contract:
//  - canonical key = toolName + JSON.stringify(event.input, sortedKeys) —
//    the WHOLE input object, recursively key-sorted (distinct counters for
//    two writes to the same path with different content).
//  - per-turn counter; cleared on turn_start AND agent_settled (pinned set).
//  - 5th identical call → { block: true, terminate: true, reason } +
//    loop-debug entry + verbatim user notice.
//  - blocked calls DO count (sticky: the 6th is also blocked).
//  - the REPEATED_CALL_LIMIT constant is 5.
//
// All tests use createMockExtensionAPI — no real process spawning.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRepeatedToolCallHandler,
  canonicalCallKey,
  resetCallCounters,
  REPEATED_CALL_LIMIT,
} from "../../src/events/tool-call/index";
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";

const NOTICE =
  "Loop breaker: the agent repeated the same tool call 5x. The call was blocked; if the repetition continues, interrupt the turn (ESC) and run /loop-continue.";

function makeEvent(overrides: Partial<{ toolName: string; input: unknown }> = {}): any {
  return {
    type: "tool_call",
    toolCallId: "tc-1",
    toolName: "bash",
    input: { command: "grep -rn foo src/" },
    ...overrides,
  };
}

function makeHandler() {
  const pi = createMockExtensionAPI();
  const debug = vi.fn();
  const handler = createRepeatedToolCallHandler(pi as any, debug);
  return { pi, debug, handler };
}

beforeEach(() => {
  resetCallCounters();
});

// --- Canonical key ---

describe("canonicalCallKey", () => {
  it("is toolName + JSON of the whole input object", () => {
    expect(canonicalCallKey("write", { path: "a.ts", content: "x" })).toBe(
      'write{"content":"x","path":"a.ts"}',
    );
  });

  it("key order is irrelevant (recursively sorted)", () => {
    const k1 = canonicalCallKey("write", { path: "a.ts", content: "x" });
    const k2 = canonicalCallKey("write", { content: "x", path: "a.ts" });
    expect(k1).toBe(k2);
  });

  it("nested objects are sorted too", () => {
    const k1 = canonicalCallKey("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
    const k2 = canonicalCallKey("edit", { edits: [{ newText: "y", oldText: "x" }], path: "a.ts" });
    expect(k1).toBe(k2);
  });

  it("different tool names never collide", () => {
    expect(canonicalCallKey("write", { path: "a.ts" })).not.toBe(canonicalCallKey("edit", { path: "a.ts" }));
  });

  it("undefined input serializes stably", () => {
    expect(canonicalCallKey("bash", undefined)).toBe(canonicalCallKey("bash", undefined));
  });
});

// --- Threshold constant ---

describe("REPEATED_CALL_LIMIT", () => {
  it("is the named constant 5", () => {
    expect(REPEATED_CALL_LIMIT).toBe(5);
  });
});

// --- Breaker behavior ---

describe("createRepeatedToolCallHandler", () => {
  it("4 identical calls → not blocked (undefined), no user message", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) {
      expect(handler(makeEvent())).toBeUndefined();
    }
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("5th identical call → { block: true, terminate: true, reason } + verbatim user message + debug entry", () => {
    const { handler, pi, debug } = makeHandler();
    let result: any;
    for (let i = 0; i < 5; i++) {
      result = handler(makeEvent());
    }
    expect(result).toEqual({ block: true, terminate: true, reason: NOTICE });

    // The user-visible notice (Acceptance Criteria — verbatim pin).
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toBe(NOTICE);
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: false });

    // The loop-debug entry.
    const debugEntries = pi.appendedEntries.filter((e: any) => e.customType === "loop-debug");
    expect(debugEntries).toHaveLength(1);
    expect(debugEntries[0].data.msg).toBe(
      "Loop breaker: 5x bash with identical args — blocking call",
    );
    expect(debug).toHaveBeenCalledWith(
      "Loop breaker: 5x bash with identical args — blocking call",
    );
  });

  it("6th identical call is ALSO blocked with the same result (sticky — blocked calls count)", () => {
    const { handler, pi } = makeHandler();
    let result: any;
    for (let i = 0; i < 6; i++) {
      result = handler(makeEvent());
    }
    expect(result).toEqual({ block: true, terminate: true, reason: NOTICE });
    // Two blocks → two notices (one per blocked call).
    expect(pi.sentMessages).toHaveLength(2);
    expect(pi.sentMessages[1].content).toBe(NOTICE);
  });

  it("different args → distinct counters: the 5th different call is not blocked", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) handler(makeEvent({ input: { command: "grep a" } }));
    // 5 calls in total, all distinct args → nothing blocked.
    handler(makeEvent({ input: { command: "grep b" } }));
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("two writes to the same path with different content → distinct counters (whole-input-object key)", () => {
    const { handler, pi } = makeHandler();
    const a = { toolName: "write", input: { path: "src/a.ts", content: "v1" } };
    const b = { toolName: "write", input: { path: "src/a.ts", content: "v2" } };
    // 4 of each — neither counter reaches the limit.
    for (let i = 0; i < 4; i++) {
      expect(handler(a as any)).toBeUndefined();
      expect(handler(b as any)).toBeUndefined();
    }
    expect(pi.sentMessages).toHaveLength(0);
    // The 5th of each now blocks independently.
    expect(handler(a as any)).toEqual({ block: true, terminate: true, reason: NOTICE });
    expect(handler(b as any)).toEqual({ block: true, terminate: true, reason: NOTICE });
    expect(pi.sentMessages).toHaveLength(2);
  });

  it("key-order-only differences are the SAME counter (sorted keys)", () => {
    const { handler, pi } = makeHandler();
    const e1 = makeEvent({ input: { path: "a.ts", content: "x" } });
    const e2 = makeEvent({ input: { content: "x", path: "a.ts" } });
    for (let i = 0; i < 3; i++) handler(e1);
    // e2 counts into the same counter even though it is the 6th call overall.
    expect(handler(e2)).toBeUndefined(); // count 4
    expect(handler(e2)).toEqual({ block: true, terminate: true, reason: NOTICE }); // count 5
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("resetCallCounters clears the per-turn counter (turn_start / agent_settled reset set)", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) handler(makeEvent());
    resetCallCounters(); // the pinned reset: fired on turn_start and agent_settled
    expect(handler(makeEvent())).toBeUndefined(); // fresh turn: count 1 again
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("batch-caveat note: terminate is set on every block from the 5th onward", () => {
    const { handler } = makeHandler();
    for (let i = 0; i < 7; i++) handler(makeEvent());
    // Every block from the 5th onward carries terminate (pinned in spec §4).
    const result = handler(makeEvent());
    expect(result?.terminate).toBe(true);
  });
});
