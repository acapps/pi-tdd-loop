// --- tool_call repeated-call breaker (new module, spec: internal/bug-negotiate-confirm-approval-loop.md §4) ---
//
// A per-turn circuit breaker for identical tool calls inside one turn.
// Separate module from the existing src/events/tool-call.ts (path
// enforcement, spec 02) — that file is untouched; the two handlers answer
// different questions (repetition vs path permission) and have different
// input shapes. Do not consolidate.
//
// Contract (pinned):
//  - canonical key = toolName + JSON.stringify(event.input, sortedKeys) —
//    the WHOLE input object, recursively key-sorted (one flat key, one
//    counter per key; narrowing to a single field would merge distinct
//    writes to the same path into one counter).
//  - the counter map is per-turn; cleared on turn_start AND on
//    agent_settled (the pinned reset set).
//  - at the 5th identical call (REPEATED_CALL_LIMIT) the handler returns
//    { block: true, terminate: true, reason } and additionally appends a
//    loop-debug entry and sends the verbatim user notice.
//  - blocked calls DO count toward the limit (sticky: call 6 is also
//    blocked with the same result).
//  - `terminate` only takes effect when every finalized tool result in the
//    batch sets it — with a single repeating call that is the whole batch.

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// The named threshold constant (spec §4).
export const REPEATED_CALL_LIMIT = 5;

// Verbatim user-visible notice (spec §4 / Acceptance Criteria — pinned).
const BREAKER_NOTICE =
  "Loop breaker: the agent repeated the same tool call 5x. The call was blocked; if the repetition continues, interrupt the turn (ESC) and run /loop-continue.";

// --- Canonical key ---

/**
 * Recursively sort object keys so JSON.stringify of the same logical input
 * is byte-stable regardless of key insertion order. Non-objects pass
 * through untouched.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * The flat counter key: toolName + JSON.stringify(input, sortedKeys).
 * `event.input` is the canonical form — the complete input object.
 */
export function canonicalCallKey(toolName: string, input: unknown): string {
  return toolName + JSON.stringify(canonicalize(input));
}

// --- Counter state (per-turn) ---

const counters = new Map<string, number>();

/**
 * Clear the per-turn counter map. Wired to BOTH `turn_start` and
 * `agent_settled` in index.ts (the pinned reset set).
 */
export function resetCallCounters(): void {
  counters.clear();
}

// --- Handler factory ---

export interface RepeatedToolCallHandler {
  (event: ToolCallEvent): ToolCallEventResult | undefined;
}

/**
 * Build the tool_call breaker handler. The handler owns the counter map
 * (module state); resetCallCounters() is the reset entry point.
 */
export function createRepeatedToolCallHandler(
  pi: ExtensionAPI,
  debug: (msg: string) => void,
): RepeatedToolCallHandler {
  return (event: ToolCallEvent): ToolCallEventResult | undefined => {
    const count = bumpCounter(event);
    if (count < REPEATED_CALL_LIMIT) return undefined;
    return blockRepeatedCall(pi, debug, event, count);
  };
}

/** Increment the per-turn counter for this call. Blocked calls DO count
 * (the increment runs unconditionally) — call 6, 7, ... stay blocked. */
function bumpCounter(event: ToolCallEvent): number {
  const key = canonicalCallKey(event.toolName, event.input);
  const count = (counters.get(key) ?? 0) + 1;
  counters.set(key, count);
  return count;
}

/** The 5th (and every later) identical call: block + terminate the batch,
 * record a loop-debug entry, and send the verbatim user notice. */
function blockRepeatedCall(
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  event: ToolCallEvent,
  count: number,
): ToolCallEventResult {
  const msg = `Loop breaker: ${count}x ${event.toolName} with identical args — blocking call`;
  debug(msg);
  pi.appendEntry("loop-debug", { ts: Date.now(), msg });
  pi.sendUserMessage(BREAKER_NOTICE, { triggerTurn: false });
  return { block: true, terminate: true, reason: BREAKER_NOTICE };
}
