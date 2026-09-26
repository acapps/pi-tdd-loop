// --- tool_call repeated-call breaker (new module, spec: internal/bug-negotiate-confirm-approval-loop.md §4) ---
//
// A per-turn circuit breaker for repeated tool calls inside one turn.
// Separate module from the existing src/events/tool-call.ts (path
// enforcement, spec 02) — that file is untouched; the two handlers answer
// different questions (repetition vs path permission) and have different
// input shapes. Do not consolidate.
//
// Key (spec: internal/bug-loop-breaker-repetition-with-mutation.md):
//  - the key is the SKELETON of the call — toolName + the identity fields
//    of the input (SKELETON_FIELDS), each normalized — NOT the whole input
//    object. The whole-object key let a one-byte argument mutation reset
//    the counter (observed: ~100-iteration grep/cat/write ping-pong in the
//    bug-confirm-approval implementation run). Payload fields (file
//    content, heredoc bodies, offset/limit wobble) are excluded.
//  - bash commands are skeletonized (commandSkeleton): heredoc bodies
//    removed, whitespace collapsed.
//  - custom/unknown tools fall back to the whole canonicalized input
//    object (the pre-skeleton algorithm) — conservative byte-exact key.
//
// Contract (pinned):
//  - the counter map is per-turn; cleared on turn_start AND on
//    agent_settled (the pinned reset set).
//  - at the 5th call for a key (REPEATED_CALL_LIMIT) the handler returns
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

// --- Skeleton key ---

/**
 * Per-tool identity fields for the key (spec: Behavior §1). First
 * match-wins on tool name; a tool not in the map (custom tool) falls back
 * to the whole canonicalized input object. Fields not listed are payload
 * (excluded from the key): retry noise the agent varies to probe, not a
 * different logical call.
 */
export const SKELETON_FIELDS: Record<string, readonly string[]> = {
  bash: ["command"],
  read: ["path"],
  write: ["path"],
  edit: ["path"],
  grep: ["pattern", "path", "glob"],
  find: ["pattern", "path"],
  ls: ["path"],
};

/**
 * Bash command skeleton (spec: Behavior §2):
 *  1. strip heredoc bodies — every line from a line that starts (after
 *     leading whitespace) with `<<` or `<<-` through its terminating
 *     delimiter line; the marker line is kept with its delimiter word;
 *  2. collapse every run of whitespace to a single space; trim.
 * No shell parsing: quoted strings, $(...) subshells, and backticks are
 * opaque text subject to whitespace collapse only (pinned limitation).
 */
export function commandSkeleton(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let skipUntil: string | null = null;
  for (const line of lines) {
    if (skipUntil !== null) {
      if (line.trim() === skipUntil) skipUntil = null;
      continue;
    }
    const marker = line.match(/^\s*\S*\s*<<-?\s*(\S+)/);
    if (marker) {
      kept.push(line);
      skipUntil = marker[1].replace(/["'`]/g, "");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\s+/g, " ").trim();
}

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
 * The flat counter key: toolName + ":" + JSON.stringify(selected, sortedKeys).
 * `selected` is the skeleton — the SKELETON_FIELDS identity fields present
 * in `input` (undefined values dropped, bash `command` skeletonized). For
 * tools not in SKELETON_FIELDS, `selected` is the whole canonicalized
 * input object (the pre-skeleton algorithm, byte-for-byte).
 */
export function canonicalCallKey(toolName: string, input: unknown): string {
  const fields = SKELETON_FIELDS[toolName];
  let selected: unknown;
  if (fields) {
    const record =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const value = record[field];
      if (value === undefined) continue;
      out[field] = field === "command" && typeof value === "string" ? commandSkeleton(value) : value;
    }
    selected = out;
  } else {
    selected = canonicalize(input);
  }
  return toolName + ":" + JSON.stringify(canonicalize(selected));
}

// --- Counter state (per-turn) ---

const counters = new Map<string, number>();

// --- Reconnaissance detector (session 01a0d9a9: 59-cycle read loop) ---
//
// The exact-match breaker above catches 5x identical calls. But the agent
// can vary its commands slightly (different sed ranges, different grep
// patterns) to evade it. The reconnaissance detector tracks the *category*
// of calls: if the agent makes RECON_READ_LIMIT read-only calls (read,
// grep, bash commands that are pure reads) without any write/edit calls,
// it blocks further read-only calls and tells the agent to act.

const RECON_READ_LIMIT = 15;

const RECON_NOTICE =
  "Reconnaissance breaker: you have made 15+ read-only calls without writing anything. Stop reading. Act on what you have: call negotiate_propose (negotiate phase), write your tests (Phase A), or write your implementation (Phase B). If you are stuck, say why in your next message.";

// Per-turn reconnaissance state.
let reconReadCount = 0;

/** Reset reconnaissance counters. Called alongside resetCallCounters(). */
export function resetReconCounters(): void {
  reconReadCount = 0;
}

/** Classify a tool call as read-only (reconnaissance) or write (action).
 * Read-only: read, grep, find, ls, and bash commands that are pure reads.
 * Write: write, edit, and bash commands with write actions. */
function isReadOnlyCall(toolName: string, input: unknown): boolean {
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    return true;
  }
  if (toolName === "write" || toolName === "edit") return false;
  if (toolName === "bash") {
    const record =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const cmd = typeof record.command === "string" ? record.command : "";
    // Write actions in bash: git commit/push/add, file writes, test runs
    const writePatterns =
      /^(git\s+(commit|push|add|checkout|reset|merge|rebase)|npx\s|node\s|npm\s|yarn\s|pnpm\s|make\s|go\s|mvn\s|cargo\s|echo\s)/;
    if (writePatterns.test(cmd)) return false;
    // Multi-command: if any part is a write, it's not read-only
    const parts = cmd.split(";").map((p) => p.trim());
    if (parts.some((p) => writePatterns.test(p))) return false;
    // Pure read: sed, grep, rg, cat, ls, wc, head, tail, git status/log/diff/show, find
    const readPatterns =
      /^(sed\s|grep\s|rg\s|cat\s|ls\s|wc\s|head\s|tail\s|git\s+(status|log|diff|show|branch|stash|remote)|find\s)/;
    if (parts.every((p) => readPatterns.test(p) || p === "")) return true;
    return false;
  }
  // Unknown tools: not read-only (conservative)
  return false;
}

/** Increment the reconnaissance read counter. Any non-read-only call resets
 * the counter (the agent acted, so it's no longer in a read loop). Returns
 * the current count. */
function bumpReconCounter(toolName: string, input: unknown): number {
  if (isReadOnlyCall(toolName, input)) {
    reconReadCount++;
  } else {
    reconReadCount = 0;
  }
  return reconReadCount;
}

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
    // Check reconnaissance limit first (catches varied read-only calls).
    const reconCount = bumpReconCounter(event.toolName, event.input);
    if (reconCount >= RECON_READ_LIMIT) {
      const msg = `Reconnaissance breaker: ${reconCount} read-only calls without a write — blocking`;
      debug(msg);
      pi.appendEntry("loop-debug", { ts: Date.now(), msg });
      try {
        pi.sendMessage(
          { customType: "loop-breaker", content: RECON_NOTICE, display: true },
          { triggerTurn: false },
        );
      } catch {
        // best-effort
      }
      return { block: true, terminate: true, reason: RECON_NOTICE };
    }

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
  try {
    pi.sendMessage(
      { customType: "loop-breaker", content: BREAKER_NOTICE, display: true },
      { triggerTurn: false },
    );
  } catch {
    // pi may be stale in print mode after session replacement; the block
    // + terminate above still stops the call. The notice is best-effort.
  }
  return { block: true, terminate: true, reason: BREAKER_NOTICE };
}
