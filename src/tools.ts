// --- Negotiation tools ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, Phase } from "./types";
import * as T from "./transitions";

// --- Types ---

interface ToolCtx {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  mode: string;
  hasUI: boolean;
}

type ToolResult = { content: { text: string }[] };

type Debug = (msg: string) => void;

interface StateRef {
  current: LoopState;
}

// --- Result builders ---

function buildProposeResult(): ToolResult {
  return { content: [{ text: "Proposal recorded. Awaiting review." }] };
}

function buildReviewResult(phase: Phase, action: string): ToolResult {
  if (isApproval(action)) {
    return { content: [{ text: "Approved." }] };
  }
  return { content: [{ text: "Feedback recorded." }] };
}

// --- Phase checks ---

function isNegotiatePhase(phase: string): phase is "negotiate" {
  return phase === "negotiate";
}

function isPhaseB(phase: string): phase is "B" {
  return phase === "B";
}

function isApproval(decision: string): boolean {
  return decision === "approve" || decision === "approved";
}

// --- State persistence helpers ---

/** Snapshot the current state into the session log. */
function persistState(state: StateRef, pi: ExtensionAPI): void {
  pi.appendEntry("loop-state", { ...state.current });
}

/** Shared negotiate → Phase B transition: reset transient flags, then apply the effect. */
function transitionToPhaseB(state: StateRef, pi: ExtensionAPI, ctx: ToolCtx, debug: Debug): void {
  state.current.phase = "B";
  state.current.lastPhase = "negotiate";
  state.current.round = 1;
  state.current.turnsThisPhase = 1;
  state.current.justTransitioned = true;
  state.current.awaitDisputeFix = false;
  state.current.awaitDisputeReview = false;
  state.current.negotiateReprompted = false;
  state.current.negotiateProposed = false;
  state.current.negotiateFeedback = "";
  applyTransitionEffect(state, pi, ctx, debug, {
    type: "advance",
    phase: "B",
    status: "Phase B — round 1",
    notify: "Approved — moving to Phase B.",
  });
}

// --- Entry logging ---

function logNegotiateEntry(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  action: string,
  text: string,
): void {
  debug(`negotiate: ${action} — ${text.slice(0, 60)}`);
  pi.appendEntry("loop-negotiate", {
    phase: state.current.phase,
    round: state.current.round,
    action,
    text: text.slice(0, 500),
  });
}

function logDisputeEntry(state: StateRef, pi: ExtensionAPI, debug: Debug, text: string): void {
  debug(`dispute: ${text.slice(0, 60)}`);
  pi.appendEntry("loop-dispute", {
    phase: state.current.phase,
    round: state.current.round,
    disputeCount: state.current.disputeCount,
    filer: state.current.disputeMode ? "tester" : "writer",
    claim: text.slice(0, 500),
    text: text.slice(0, 500),
  });
}

function logDisputeConcession(state: StateRef, pi: ExtensionAPI): void {
  pi.appendEntry("loop-dispute", {
    phase: state.current.phase,
    round: state.current.round,
    action: "concede",
  });
}

function logEscalation(state: StateRef, pi: ExtensionAPI, ctx: ToolCtx): void {
  state.current.phase = "escalated";
  state.current.awaitDisputeFix = false;
  state.current.awaitDisputeReview = false;
  persistState(state, pi);
  ctx.ui.notify("Dispute limit reached. Escalating to human.", "warning");
  ctx.ui.setStatus("loop", "escalated (dispute limit)");
}

function applyTransitionEffect(
  state: StateRef,
  pi: ExtensionAPI,
  ctx: ToolCtx,
  debug: Debug,
  effect: ReturnType<typeof T.computeNegotiateTransition>["effect"],
): void {
  debug(`applying transition: ${effect.type}`);
  persistState(state, pi);
  ctx.ui.setStatus("loop", "status" in effect ? effect.status : "Phase B — round 1");
}

// --- negotiate_propose ---

export function negotiatePropose(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
) {
  return {
    name: "negotiate_propose",
    label: "Propose Implementation",
    description: "Propose an implementation approach or dispute a test.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description: "Implementation approach or 'agree' to accept tests as-is, or a dispute claim.",
        },
      },
      required: ["plan"],
    },
    execute: async (_callId: string, args: { plan: string }, _meta: unknown, _ctx: unknown, toolCtx: ToolCtx) => {
      return handlePropose(state, pi, debug, toolCtx, args.plan);
    },
  };
}

function handlePropose(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  plan: string,
): ToolResult {
  const phase = state.current.phase as Phase;
  debug(`negotiate_propose: plan=${plan.slice(0, 80)}... phase=${phase}`);

  state.current.lastProposal = plan;

  if (isNegotiatePhase(phase)) {
    return handleNegotiatePropose(state, pi, debug, ctx, plan);
  }
  if (isPhaseB(phase)) {
    return handleBDisputePropose(state, pi, debug, ctx, plan);
  }
  return buildProposeResult();
}

function handleNegotiatePropose(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  plan: string,
): ToolResult {
  debug(`Writer proposes`);
  logNegotiateEntry(state, pi, debug, "propose", plan);

  if (plan === "agree") {
    return executeNegotiateAgree(state, pi, debug, ctx);
  }
  return executeNegotiateProposal(state, pi, debug);
}

function handleBDisputePropose(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  plan: string,
): ToolResult {
  state.current.disputeCount++;
  debug(`Dispute #${state.current.disputeCount}: ${plan.slice(0, 60)}`);

  if (state.current.disputeCount >= state.current.maxDispute) {
    logEscalation(state, pi, ctx);
    return buildProposeResult();
  }

  logDisputeEntry(state, pi, debug, plan);
  return triggerDisputeReview(state, pi);
}

function executeNegotiateAgree(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
): ToolResult {
  debug("Approved → Phase B");
  transitionToPhaseB(state, pi, ctx, debug);
  return { content: [{ text: "Proposal recorded. Moving to Phase B." }] };
}

function executeNegotiateProposal(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
): ToolResult {
  debug("negotiate_propose: proposal recorded");
  state.current.negotiateProposed = true;
  persistState(state, pi);
  return buildProposeResult();
}

function triggerDisputeReview(state: StateRef, pi: ExtensionAPI): ToolResult {
  state.current.awaitDisputeReview = true;
  persistState(state, pi);
  return {
    content: [{ text: "Dispute filed. STOP producing tool calls. The review is requested when your turn ends." }],
  };
}

// --- negotiate_review ---

export function negotiateReview(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
) {
  return {
    name: "negotiate_review",
    label: "Review Proposal",
    description: "Approve a proposal or provide feedback.",
    parameters: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          description: "'approve' to accept, or feedback text.",
        },
      },
      required: ["decision"],
    },
    execute: async (_callId: string, args: { decision: string }, _meta: unknown, _ctx: unknown, toolCtx: ToolCtx) => {
      return handleReview(state, pi, debug, toolCtx, args.decision);
    },
  };
}

function handleReview(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  decision: string,
): ToolResult {
  const phase = state.current.phase as Phase;
  debug(`negotiate_review: decision=${decision.slice(0, 80)}... phase=${phase}`);

  if (isNegotiatePhase(phase)) {
    return handleNegotiateReview(state, pi, debug, ctx, decision);
  }
  if (isPhaseB(phase)) {
    return handleBDisputeReview(state, pi, debug, ctx, decision);
  }
  return buildReviewResult(phase, decision);
}

function handleNegotiateReview(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  decision: string,
): ToolResult {
  debug(`Reviewer: ${isApproval(decision) ? "approve" : "feedback"}`);
  logNegotiateEntry(state, pi, debug, "review", decision);

  if (isApproval(decision)) {
    return executeNegotiateApprove(state, pi, debug, ctx);
  }
  return executeNegotiateFeedback(state, pi, debug, decision);
}

function handleBDisputeReview(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  decision: string,
): ToolResult {
  debug(`Dispute review: ${isApproval(decision) ? "conceded" : "defended"}`);
  logDisputeEntry(state, pi, debug, decision);

  // Recorded at decision time, before any cell mutates disputeMode (spec 09,
  // Filer routing; Table 3 row 1 routes by this recorded value).
  state.current.disputeFiler = state.current.disputeMode ? "tester" : "writer";

  if (isApproval(decision)) {
    // Table 2: row 1 (Writer filed) → Tester fixes the test; row 3 (Tester
    // filed) → Writer fixes the flagged file(s).
    return state.current.disputeMode
      ? executeWriterConcede(state, pi, debug)
      : executeBDisputeConcede(state, pi, debug);
  }
  return executeBDisputeDefend(state, pi, debug, decision);
}

function executeNegotiateApprove(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
): ToolResult {
  debug("Approved → Phase B");
  transitionToPhaseB(state, pi, ctx, debug);
  return buildReviewResult(state.current.phase as Phase, "approve");
}

function executeNegotiateFeedback(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  decision: string,
): ToolResult {
  debug("negotiate_review: feedback");
  state.current.negotiateFeedback = decision;
  persistState(state, pi);
  return buildReviewResult(state.current.phase as Phase, decision);
}

function executeBDisputeConcede(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
): ToolResult {
  debug("Tester conceded — will fix test");
  state.current.disputeMode = true;
  state.current.awaitDisputeFix = true;
  persistState(state, pi);
  logDisputeConcession(state, pi);
  return buildReviewResult(state.current.phase as Phase, "approve");
}

function executeBDisputeDefend(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  decision: string,
): ToolResult {
  debug("negotiate_review: defend dispute");
  state.current.round++;
  // Load-bearing in Table 2 row 4 (Tester filed): closes the fix window this
  // cell inherited; a no-op in row 2 (already false).
  state.current.disputeMode = false;
  state.current.disputeDefended = decision; // delivered at the next settle (Table 3 row 1)
  persistState(state, pi);
  return buildReviewResult(state.current.phase as Phase, decision);
}

function executeWriterConcede(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
): ToolResult {
  debug("Writer conceded — will fix flagged files");
  // Exit the fix window so rule 3 no longer blocks the Writer's source writes.
  state.current.disputeMode = false;
  state.current.awaitWriterConcedeFix = true; // delivered at the next settle (Table 3 row 2)
  persistState(state, pi);
  return buildReviewResult(state.current.phase as Phase, "approve");
}
