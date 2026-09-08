// --- session_start handler ---
// State restoration on reload.

import type { LoopState, DisputeState } from "../types";
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

// One-directional migration (bug-dispute-reload-evaporation): pre-fix
// loop-state entries carry the 6 flat dispute fields and no `dispute`
// object. Synthesize the status from them; the old names appear NOWHERE
// else in src/ (pinned exception — AC3). After migration the entry is the
// new shape; the old fields are dropped.
function migrateDispute(data: Record<string, unknown>): Record<string, unknown> {
  if (data.dispute !== undefined) return data; // post-migration shape
  const disputeMode = data.disputeMode === true;
  const awaitDisputeReview = data.awaitDisputeReview === true;
  const awaitDisputeFix = data.awaitDisputeFix === true;
  const disputeDefended = typeof data.disputeDefended === "string" ? data.disputeDefended : undefined;
  const awaitWriterConcedeFix = data.awaitWriterConcedeFix === true;
  const disputeFiler = data.disputeFiler === "tester" || data.disputeFiler === "writer" ? data.disputeFiler : undefined;
  const lastProposal = typeof data.lastProposal === "string" ? data.lastProposal : "";

  let dispute: DisputeState;
  if (awaitDisputeReview || (disputeMode && !awaitDisputeFix)) {
    // A filed / in-review dispute: the review leg is pending.
    dispute = { status: "in-review", filer: disputeFiler ?? (disputeMode ? "tester" : "writer"), claim: lastProposal };
  } else if (awaitDisputeFix) {
    // Row 5 pending: the conceding Tester's fix turn.
    dispute = { status: "conceded", filer: disputeFiler ?? "writer", claim: lastProposal, decision: "concede" };
  } else if (awaitWriterConcedeFix) {
    // Row 4 pending: the conceding Writer's fix turn.
    dispute = { status: "conceded", filer: "tester", claim: lastProposal, decision: "concede" };
  } else if (disputeDefended !== undefined) {
    // Row 7 pending: the defend decision to deliver.
    dispute = { status: "defended", filer: disputeFiler ?? "writer", claim: lastProposal, decision: disputeDefended };
  } else {
    dispute = { status: "none" };
  }

  const out: Record<string, unknown> = { ...data, dispute };
  // Drop the retired flat fields — post-migration entries are the new shape.
  for (const key of ["disputeMode", "awaitDisputeFix", "awaitDisputeReview", "disputeDefended", "awaitWriterConcedeFix", "disputeFiler"]) {
    delete out[key];
  }
  return out;
}

function clearTransientFlags(s: LoopState): void {
  s.justTransitioned = false;
  s.negotiateReprompted = false;
  // Heal pre-spec-07 entries: missing markers become defined (false / "") so
  // the `=== true` / `!== ""` checks see a definite value after restore.
  s.negotiateProposed = false;
  s.negotiateFeedback = "";
  // NOTE: `dispute` is deliberately NOT touched (the fix): filed / in-review /
  // conceded / defended survive restore and redeliver on the next settle.
  // A legacy entry with no dispute object (validator-accepted pre-migration
  // shape) heals to "none" — the old flags were already consumed by the
  // migration, so "none" is the faithful status.
  if (!s.dispute) {
    s.dispute = { status: "none" };
  }
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
  const raw = entry.data as Record<string, unknown>;
  if (!validateLoopState(raw)) {
    quarantine(ctx, debug);
    return;
  }

  // One-directional migration: pre-fix entries (flat dispute fields, no
  // `dispute` object) become the new shape before load.
  state.current = migrateDispute(raw) as unknown as LoopState;
  clearTransientFlags(state.current);
  debug(`session_start: restored → ${stateSummary(state.current)}`);
  ctx.ui.setStatus("loop", `Phase ${state.current.phase} — round ${state.current.round}`);
}
