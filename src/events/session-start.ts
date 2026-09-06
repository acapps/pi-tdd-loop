// --- session_start handler ---
// State restoration on reload.

import type { LoopState } from "../types";
import type { EventCtx } from "./index";
import { validateLoopState } from "../state-validation";

// --- Types ---

export interface SessionStartHandlerInput {
  state: { current: LoopState };
  ctx: EventCtx;
  debug: (msg: string) => void;
}

export interface SessionStartHandler {
  (input: SessionStartHandlerInput): void;
}

// --- Constants ---

const NO_PREVIOUS_STATE = "session_start: no previous state found";
const CORRUPT_STATUS = "state corrupted — run /loop to restart";
const CORRUPT_DEBUG = "session_start: restored entry failed validation — quarantining";

// --- Helpers ---

function stateSummary(s: LoopState): string {
  return `Phase ${s.phase} round ${s.round}`;
}

function quarantine(ctx: EventCtx, debug: (msg: string) => void): void {
  debug(CORRUPT_DEBUG);
  ctx.ui.setStatus("loop", CORRUPT_STATUS);
}

function isLoopStateEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return e.type === "custom" && e.customType === "loop-state";
}

function findLastLoopState(entries: unknown[]): { data?: unknown } | undefined {
  return entries.filter(isLoopStateEntry).pop() as { data?: unknown } | undefined;
}

function clearTransientFlags(s: LoopState): void {
  s.disputeMode = false;
  s.justTransitioned = false;
  s.negotiateReprompted = false;
  // Heal pre-spec-07 entries: missing markers become defined (false / "") so
  // the `=== true` / `!== ""` checks see a definite value after restore.
  s.negotiateProposed = false;
  s.negotiateFeedback = "";
  s.awaitDisputeFix = false;
  s.awaitDisputeReview = false;
  s.disputeDefended = undefined;
  s.awaitWriterConcedeFix = false;
  s.disputeFiler = undefined;
}

// --- Public API ---

export function handleSessionStart(input: SessionStartHandlerInput): void {
  // The spec-01 handler contract takes {state, ctx, debug}. Earlier legacy
  // callers passed a bare ctx (debug on ctx.debug) — accept both shapes.
  const { state, ctx, debug } = input;
  debug("session_start: restoring state...");

  if (!ctx?.sessionManager?.getEntries) {
    debug(NO_PREVIOUS_STATE);
    return;
  }

  const entries = ctx.sessionManager.getEntries();
  if (!Array.isArray(entries)) {
    debug(NO_PREVIOUS_STATE);
    return;
  }

  const entry = findLastLoopState(entries);
  // A loop-state entry whose data is null/undefined is the corruption case,
  // not the "no previous state" case: quarantine it.
  if (!entry) {
    debug(NO_PREVIOUS_STATE);
    return;
  }
  if (!entry.data) {
    quarantine(ctx, debug);
    return;
  }

  // Call site 2 (refactor-state-model-divergence.md): validate the restored
  // entry; on failure quarantine — do NOT load the broken state.
  if (!validateLoopState(entry.data)) {
    quarantine(ctx, debug);
    return;
  }

  state.current = entry.data as LoopState;
  clearTransientFlags(state.current);
  debug(`session_start: restored → ${stateSummary(state.current)}`);
  ctx.ui.setStatus("loop", `Phase ${state.current.phase} — round ${state.current.round}`);
}
