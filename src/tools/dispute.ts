// --- Phase B dispute handlers + dispute entry logging ---
// Depends on: types.ts, state-io.ts, metrics.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLiveMetrics, accumulateDispute } from "../metrics";
import { persistState, logEscalation } from "./state-io";
import type { StateRef, ToolCtx, ToolResult, Debug } from "./types";
import { isApproval, buildReviewResult } from "./types";

/** Entry logging: a dispute filing / resolution entry. */
export function logDisputeEntry(state: StateRef, pi: ExtensionAPI, debug: Debug, text: string): void {
  debug(`dispute: ${text.slice(0, 60)}`);
  pi.appendEntry("loop-dispute", {
    phase: state.current.phase,
    round: state.current.round,
    disputeCount: state.current.disputeCount,
    // S2: the RECORDED filer (set at filing) — the old re-derivation from
    // disputeMode was wrong for a writer-filed dispute at filing time.
    filer: state.current.dispute?.filer ?? "writer",
    claim: text.slice(0, 500),
    text: text.slice(0, 500),
  });
}

/** Entry logging: a writer concession of a tester-filed dispute. */
export function logDisputeConcession(state: StateRef, pi: ExtensionAPI): void {
  pi.appendEntry("loop-dispute", {
    phase: state.current.phase,
    round: state.current.round,
    action: "concede",
  });
}

/**
 * writer-dispute-concede: a Phase B Writer proposal is a concession iff it is
 * lexically "agree" (any case, trimmed). Exact match — "agreed" or "I agree"
 * still file a dispute. Pinned separately from isApproval so a future
 * isApproval widening does not silently change dispute semantics.
 */
function isConcession(plan: string): boolean {
  return plan.trim().toLowerCase() === "agree";
}

export function executeWriterConcedeDispute(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
): ToolResult {
  debug("Writer conceded — dispute closed");
  state.current.dispute = { status: "closed" };
  state.current.negotiateFeedback = "";
  persistState(state, pi, debug);
  return {
    content: [{ text: "Dispute closed. The tests stand. Continue Phase B; the gate runs when your turn ends." }],
  };
}

export function handleBDisputePropose(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  plan: string,
): ToolResult {
  // writer-dispute-concede: a concession is checked BEFORE any dispute
  // mutation or budget consumption — it closes the dispute in-turn.
  if (isConcession(plan)) {
    return executeWriterConcedeDispute(state, pi, debug);
  }

  // S1: the budget is consumed at RESOLUTION (handleBDisputeReview), not at
  // filing — a filed-but-lost dispute no longer burns budget.
  const filer = state.current.dispute?.filer ?? "writer";
  state.current.dispute = {
    status: "filed",
    filer,
    claim: plan,
    filedRound: state.current.round,
  };
  const metrics = getLiveMetrics();
  if (metrics) accumulateDispute(metrics, "raised");
  debug(`Dispute filed: ${plan.slice(0, 60)}`);

  logDisputeEntry(state, pi, debug, plan);
  return triggerDisputeReview(state, pi, debug);
}

export function triggerDisputeReview(state: StateRef, pi: ExtensionAPI, debug: Debug): ToolResult {
  // The review turn is scheduled at the next settle (status "filed" →
  // "in-review", dispute.ts). The status survives a reload — the old
  // awaitDisputeReview flag evaporated with clearTransientFlags.
  persistState(state, pi, debug);
  return {
    content: [{ text: "Dispute filed. STOP producing tool calls. The review is requested when your turn ends." }],
  };
}

export function handleBDisputeReview(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  decision: string,
): ToolResult {
  debug(`Dispute review: ${isApproval(decision) ? "conceded" : "defended"}`);
  logDisputeEntry(state, pi, debug, decision);

  // S1: the budget is consumed at resolution. The filer is the RECORDED
  // value from filing — never re-derived (disputeMode no longer exists).
  state.current.disputeCount++;
  const filer = state.current.dispute?.filer ?? "writer";
  const m = getLiveMetrics();

  if (isApproval(decision)) {
    if (m) accumulateDispute(m, "conceded");
    // Table 2: row 1 (Writer filed) → Tester fixes the test; row 3 (Tester
    // filed) → Writer fixes the flagged file(s).
    if (state.current.disputeCount >= state.current.maxDispute) {
      logEscalation(state, pi, ctx, debug);
      return buildReviewResult(state.current.phase, "approve");
    }
    state.current.dispute = { ...state.current.dispute, status: "conceded", decision: "concede" };
    persistState(state, pi, debug);
    if (filer === "tester") {
      logDisputeConcession(state, pi);
    }
    return buildReviewResult(state.current.phase, "approve");
  }

  if (state.current.disputeCount >= state.current.maxDispute) {
    logEscalation(state, pi, ctx, debug);
    return buildReviewResult(state.current.phase, decision);
  }
  if (m) accumulateDispute(m, "defended");
  state.current.dispute = { ...state.current.dispute, status: "defended", decision };
  persistState(state, pi, debug);
  return buildReviewResult(state.current.phase, decision);
}
