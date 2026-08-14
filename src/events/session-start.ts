// --- session_start handler ---
// State restoration on reload.

import type { LoopState } from "../types";
import type { EventCtx } from "./index";

// --- Types ---

export interface SessionStartHandlerInput {
  state: { current: LoopState };
  ctx: EventCtx;
  debug: (msg: string) => void;
}

export interface SessionStartHandler {
  (input: SessionStartHandlerInput): void;
}

// --- Helpers ---

function stateSummary(s: LoopState): string {
  return `Phase ${s.phase} round ${s.round}`;
}

function findLastLoopState(entries: unknown[]): { data: LoopState } | undefined {
  return entries
    .filter(
      (e) =>
        (e as Record<string, unknown>).type === "custom" &&
        (e as Record<string, unknown>).customType === "loop-state",
    )
    .pop() as { data: LoopState } | undefined;
}

function clearTransientFlags(s: LoopState): void {
  s.disputeMode = false;
  s.justTransitioned = false;
  s.negotiateReprompted = false;
  s.awaitDisputeFix = false;
  s.awaitDisputeReview = false;
}

// --- Public API ---

export function handleSessionStart(input: SessionStartHandlerInput): void {
  const { state, ctx, debug } = input;
  debug("session_start: restoring state...");

  if (!ctx?.sessionManager?.getEntries) {
    debug("session_start: no previous state found");
    return;
  }

  const entries = ctx.sessionManager.getEntries();
  if (!Array.isArray(entries)) {
    debug("session_start: no previous state found");
    return;
  }

  const entry = findLastLoopState(entries);
  if (!entry?.data) {
    debug("session_start: no previous state found");
    return;
  }

  state.current = entry.data as LoopState;
  clearTransientFlags(state.current);
  debug(`session_start: restored → ${stateSummary(state.current)}`);
  ctx.ui.setStatus(
    "loop",
    `Phase ${state.current.phase} — round ${state.current.round}`,
  );
}
