// --- tool_call repeated-call breaker (composition barrel) ---
//
// A per-turn circuit breaker for repeated tool calls inside one turn.
// This module COMPOSES three independent detectors, each in its own file:
//
//   - breaker.ts   — repeated identical calls (5x same skeleton)
//   - recon.ts     — 15+ read-only calls without a write (reconnaissance)
//   - write-loop.ts — 10+ writes to the same file (hammering one approach)
//
// The two are separate from src/events/tool-call.ts (path enforcement,
// spec 02) — that file is untouched; the two handlers answer different
// questions (repetition vs path permission) and have different input
// shapes. Do not consolidate.
//
// Contract (pinned):
//  - the counter maps are per-turn; cleared on turn_start AND on
//    agent_settled (the pinned reset set). resetCallCounters() and
//    resetReconCounters() are the reset entry points (both wired to
//    turn_start and agent_settled in index.ts).
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
import {
  REPEATED_CALL_LIMIT,
  bumpCounter,
  blockRepeatedCall,
  resetCallCounters as resetCallCountersFromBreaker,
  type RepeatedToolCallHandler,
} from "./breaker";
import {
  RECON_READ_LIMIT,
  RECON_NOTICE,
  bumpReconCounter,
  resetReconCounters as resetReconCountersFromRecon,
} from "./recon";
import {
  WRITE_LOOP_LIMIT,
  WRITE_LOOP_NOTICE,
  bumpWriteLoopCounter,
  clearWriteLoopCounters,
} from "./write-loop";

// --- Public re-exports (module path "src/events/tool-call/index" unchanged) ---
//
// Every original public name is re-exported so importers (index.ts, and the
// test suite importing from "src/events/tool-call/index") resolve identically.
// The two reset entry points are defined below (they orchestrate the
// per-detector resets); the detector-internal resets are imported above
// under aliases and are not re-exported.

export {
  REPEATED_CALL_LIMIT,
  SKELETON_FIELDS,
  commandSkeleton,
  canonicalCallKey,
  bumpCounter,
  blockRepeatedCall,
  type RepeatedToolCallHandler,
} from "./breaker";
export {
  RECON_READ_LIMIT,
  RECON_NOTICE,
  bumpReconCounter,
} from "./recon";
export {
  WRITE_LOOP_LIMIT,
  WRITE_LOOP_NOTICE,
  bumpWriteLoopCounter,
} from "./write-loop";

// --- Marker for the composed breaker handler ---
//
// Tests identify the registered breaker handler by this marker (set on the
// returned closure), not by source-sniffing: the composed handler lives in
// this module and delegates to the detectors, so its serialized source no
// longer contains the detector call sites. A marker is robust against the
// detector split and against renames of the detector internals.
export const LOOP_BREAKER = Symbol("loop-breaker");

// --- Handler factory (composition) ---

/**
 * Build the tool_call breaker handler. The handler composes all three
 * detectors (recon → write-loop → repeated-call, in that order) and owns
 * no counter state itself — each detector owns its own. resetCallCounters()
 * and resetReconCounters() are the reset entry points.
 */
export function createRepeatedToolCallHandler(
  pi: ExtensionAPI,
  debug: (msg: string) => void,
): RepeatedToolCallHandler {
  const handler: RepeatedToolCallHandler = (
    event: ToolCallEvent,
  ): ToolCallEventResult | undefined => {
    // Check reconnaissance limit first (catches varied read-only calls).
    const reconCount = bumpReconCounter(event.toolName, event.input);
    if (reconCount > 0 && reconCount % 5 === 0) {
      debug(`Recon counter: ${reconCount} read-only calls (limit ${RECON_READ_LIMIT})`);
    }
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

    // Check write-loop limit (catches hammering the same file with varied writes).
    const writeCount = bumpWriteLoopCounter(event.toolName, event.input);
    if (writeCount !== null && writeCount > 0 && writeCount % 5 === 0) {
      debug(`Write-loop counter: ${writeCount} writes to same file (limit ${WRITE_LOOP_LIMIT})`);
    }
    if (writeCount !== null && writeCount >= WRITE_LOOP_LIMIT) {
      const msg = `Write-loop breaker: ${writeCount} writes to same file — blocking`;
      debug(msg);
      pi.appendEntry("loop-debug", { ts: Date.now(), msg });
      try {
        pi.sendMessage(
          { customType: "loop-breaker", content: WRITE_LOOP_NOTICE, display: true },
          { triggerTurn: false },
        );
      } catch {
        // best-effort
      }
      return { block: true, terminate: true, reason: WRITE_LOOP_NOTICE };
    }

    const count = bumpCounter(event);
    if (count < REPEATED_CALL_LIMIT) return undefined;
    return blockRepeatedCall(pi, debug, event, count);
  };

  (handler as unknown as Record<symbol, unknown>)[LOOP_BREAKER] = true;
  return handler;
}

/**
 * Clear the per-turn counter maps. Wired to BOTH `turn_start` and
 * `agent_settled` in index.ts (the pinned reset set). resetCallCounters()
 * clears the repeated-call counter; resetReconCounters() clears the recon
 * counter AND the write-loop counter (the pinned reset set).
 */
export function resetCallCounters(): void {
  resetCallCountersFromBreaker();
}

export function resetReconCounters(): void {
  resetReconCountersFromRecon();
  clearWriteLoopCounters();
}
