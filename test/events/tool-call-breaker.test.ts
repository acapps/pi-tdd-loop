// Contract tests for the tool_call repeated-call breaker.
// Spec: internal/bug-negotiate-confirm-approval-loop.md §4 (counter
// contract, notice, reset set) + internal/bug-loop-breaker-repetition-with-mutation.md
// (skeleton key: SKELETON_FIELDS + commandSkeleton; the whole-object key
// let a one-byte argument mutation reset the counter — the observed
// ~100-iteration grep/cat/write ping-pong).
//
// Pinned contract:
//  - key = toolName + ":" + JSON.stringify(selected, sortedKeys), where
//    `selected` is the SKELETON_FIELDS identity fields (bash `command`
//    skeletonized); custom/unknown tools fall back to the whole
//    canonicalized input object (byte-exact, pre-skeleton algorithm).
//  - per-turn counter; cleared on turn_start AND agent_settled (pinned set).
//  - 5th call for a key → { block: true, terminate: true, reason } +
//    loop-debug entry + verbatim user notice.
//  - blocked calls DO count (sticky: the 6th is also blocked).
//  - the REPEATED_CALL_LIMIT constant is 5.
//
// All tests use createMockExtensionAPI — no real process spawning.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRepeatedToolCallHandler,
  canonicalCallKey,
  commandSkeleton,
  SKELETON_FIELDS,
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

// --- commandSkeleton ---

describe("commandSkeleton", () => {
  it("strips a quoted heredoc body, keeps the marker line", () => {
    expect(commandSkeleton("cat <<'EOF'\nprobe v1\nEOF")).toBe("cat <<'EOF'");
  });

  it("different heredoc bodies → same skeleton", () => {
    expect(commandSkeleton("cat <<'EOF'\nprobe v1\nEOF")).toBe(
      commandSkeleton("cat <<'EOF'\nprobe v2\nEOF"),
    );
  });

  it("strips a bare (unquoted) heredoc body", () => {
    expect(commandSkeleton("cat <<EOF\nbody line\nEOF\necho done")).toBe("cat <<EOF echo done");
  });

  it("collapses whitespace runs and trims", () => {
    expect(commandSkeleton("grep -rn foo src/ ")).toBe("grep -rn foo src/");
    expect(commandSkeleton("grep\t-rn\nfoo  src/")).toBe("grep -rn foo src/");
  });

  it("leaves a command with no heredoc unchanged (modulo whitespace)", () => {
    expect(commandSkeleton("npx vitest run test/a.test.ts")).toBe("npx vitest run test/a.test.ts");
  });

  it("a different search root is a different skeleton", () => {
    expect(commandSkeleton("grep -rn foo src/")).not.toBe(commandSkeleton("grep -rn foo src"));
  });
});

// --- SKELETON_FIELDS shape ---

describe("SKELETON_FIELDS", () => {
  it("pins the 7 built-in rows with exactly the spec'd field lists", () => {
    expect(SKELETON_FIELDS["bash"]).toEqual(["command"]);
    expect(SKELETON_FIELDS["read"]).toEqual(["path"]);
    expect(SKELETON_FIELDS["write"]).toEqual(["path"]);
    expect(SKELETON_FIELDS["edit"]).toEqual(["path"]);
    expect(SKELETON_FIELDS["grep"]).toEqual(["pattern", "path", "glob"]);
    expect(SKELETON_FIELDS["find"]).toEqual(["pattern", "path"]);
    expect(SKELETON_FIELDS["ls"]).toEqual(["path"]);
  });

  it("has no row for unknown tools (fallback applies)", () => {
    expect(SKELETON_FIELDS["negotiate_propose"]).toBeUndefined();
  });
});

// --- canonicalCallKey (skeleton) ---

describe("canonicalCallKey", () => {
  it("is toolName + ':' + JSON of the selected skeleton fields (write: path only)", () => {
    expect(canonicalCallKey("write", { path: "a.ts", content: "x" })).toBe(
      'write:{"path":"a.ts"}',
    );
  });

  it("key order is irrelevant (recursively sorted)", () => {
    const k1 = canonicalCallKey("grep", { pattern: "foo", path: "src/", limit: 10 });
    const k2 = canonicalCallKey("grep", { limit: 10, path: "src/", pattern: "foo" });
    expect(k1).toBe(k2);
  });

  it("payload fields are excluded: grep limit wobble is the same key", () => {
    expect(canonicalCallKey("grep", { pattern: "foo", path: "src/" })).toBe(
      canonicalCallKey("grep", { pattern: "foo", path: "src/", limit: 50 }),
    );
  });

  it("selected fields with undefined values are dropped before stringify", () => {
    expect(canonicalCallKey("grep", { pattern: "foo", path: undefined })).toBe(
      canonicalCallKey("grep", { pattern: "foo" }),
    );
  });

  it("bash command is skeletonized in the key", () => {
    expect(canonicalCallKey("bash", { command: "cat <<'EOF'\nv1\nEOF" })).toBe(
      canonicalCallKey("bash", { command: "cat <<'EOF'\nv2\nEOF" }),
    );
  });

  it("different tool names never collide", () => {
    expect(canonicalCallKey("write", { path: "a.ts" })).not.toBe(canonicalCallKey("edit", { path: "a.ts" }));
  });

  it("fallback (custom tool): whole canonicalized input object, byte-exact", () => {
    expect(canonicalCallKey("negotiate_propose", { plan: "x" })).toBe(
      'negotiate_propose:{"plan":"x"}',
    );
  });

  it("fallback: nested objects are sorted too", () => {
    const k1 = canonicalCallKey("custom", { b: { y: 1, x: 2 }, a: 1 });
    const k2 = canonicalCallKey("custom", { a: 1, b: { x: 2, y: 1 } });
    expect(k1).toBe(k2);
  });

  it("undefined input serializes stably (fallback)", () => {
    expect(canonicalCallKey("custom", undefined)).toBe(canonicalCallKey("custom", undefined));
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
    expect(pi.sentMessages[0].options).toEqual({});

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

  it("different logical calls → distinct counters: the 5th different call is not blocked", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) handler(makeEvent({ input: { command: "grep a" } }));
    // 5 calls in total, all distinct logical calls → nothing blocked.
    handler(makeEvent({ input: { command: "grep b" } }));
    expect(pi.sentMessages).toHaveLength(0);
  });

  // Intended shift (bug-loop-breaker-repetition-with-mutation, Behavior §6):
  // the prior spec's "two writes to the same path with different content →
  // distinct counters" is INVERTED — same path, mutated content is the
  // observed probe-loop evasion shape and now counts into one counter.
  it("two writes to the same path with different content → SAME counter (skeleton key; the flipped prior pin)", () => {
    const { handler, pi } = makeHandler();
    const a = { toolName: "write", input: { path: "src/a.ts", content: "v1" } };
    const b = { toolName: "write", input: { path: "src/a.ts", content: "v2" } };
    // 4 alternating writes (mutated content) → one counter at 8.
    for (let i = 0; i < 4; i++) {
      const ra = handler(a as any);
      const rb = handler(b as any);
      // Counter reaches the limit on the 5th write: from the 5th onward
      // every write to the path is blocked (sticky — blocked calls count).
      expect(ra).toEqual(i < 2 ? undefined : { block: true, terminate: true, reason: NOTICE });
      expect(rb).toEqual(i < 2 ? undefined : { block: true, terminate: true, reason: NOTICE });
    }
    expect(pi.sentMessages).toHaveLength(4);
    // The 9th write to the path (regardless of content) is still blocked.
    expect(handler(a as any)).toEqual({ block: true, terminate: true, reason: NOTICE });
    expect(pi.sentMessages).toHaveLength(5);
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

// --- Evasion regression (bug-loop-breaker-repetition-with-mutation) ---

describe("repetition-with-mutation (the bug)", () => {
  it("5 bash calls, same command, mutated heredoc body each → 5th blocked", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) {
      const ev = makeEvent({ input: { command: `cat <<'EOF'\nprobe v${i}\nEOF` } });
      expect(handler(ev)).toBeUndefined();
    }
    const fifth = makeEvent({ input: { command: "cat <<'EOF'\nprobe v4\nEOF" } });
    expect(handler(fifth)).toEqual({ block: true, terminate: true, reason: NOTICE });
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("5 read calls, same path, different offset each → 5th blocked", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) {
      expect(handler(makeEvent({ toolName: "read", input: { path: "big.log", offset: i * 100 } }))).toBeUndefined();
    }
    expect(handler(makeEvent({ toolName: "read", input: { path: "big.log", offset: 400 } }))).toEqual(
      { block: true, terminate: true, reason: NOTICE },
    );
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("5 grep calls, same pattern+path, different limit each → 5th blocked", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) {
      expect(handler(makeEvent({ toolName: "grep", input: { pattern: "foo", path: "src/", limit: i + 1 } }))).toBeUndefined();
    }
    expect(handler(makeEvent({ toolName: "grep", input: { pattern: "foo", path: "src/", limit: 5 } }))).toEqual(
      { block: true, terminate: true, reason: NOTICE },
    );
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("5 grep calls with 5 different patterns → nothing blocked (distinct logical calls)", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 5; i++) {
      handler(makeEvent({ toolName: "grep", input: { pattern: `p${i}`, path: "src/" } }));
    }
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("5 write calls to 5 different paths → nothing blocked (distinct logical calls)", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 5; i++) {
      handler(makeEvent({ toolName: "write", input: { path: `src/f${i}.ts`, content: "x" } }));
    }
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("fallback: 5 custom-tool calls with byte-identical input → 5th blocked (byte-exact key preserved)", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 4; i++) {
      expect(handler(makeEvent({ toolName: "negotiate_propose", input: { plan: "x" } }))).toBeUndefined();
    }
    expect(handler(makeEvent({ toolName: "negotiate_propose", input: { plan: "x" } }))).toEqual(
      { block: true, terminate: true, reason: NOTICE },
    );
    expect(pi.sentMessages).toHaveLength(1);
  });

  it("fallback: 5 custom-tool calls with one field mutated each → nothing blocked (fallback stays byte-exact)", () => {
    const { handler, pi } = makeHandler();
    for (let i = 0; i < 5; i++) {
      handler(makeEvent({ toolName: "negotiate_propose", input: { plan: `x${i}` } }));
    }
    expect(pi.sentMessages).toHaveLength(0);
  });
});
