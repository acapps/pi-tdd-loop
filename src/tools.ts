// --- Negotiation tools ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, Phase } from "./types";
import * as T from "./transitions";
import * as GP from "./generic-prompts";
import { getLanguageConfig } from "./languages";
import { commit } from "./commit";

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

/**
 * fix-negotiate-confirm-approval-loop §1: a Writer proposal is a
 * confirmation iff it is lexically "agree" (any case, trimmed) or starts
 * with one of the closed tail forms — "agree:" or "agree —" (em dash) or
 * "agree -" (ASCII dash). Word-boundary: "agreement reached" is NOT a match.
 */
export function isAgreeProposal(lastProposal: string): boolean {
  return startsWithAgreeToken(lastProposal.trim().toLowerCase());
}

/** The closed prefix set: the bare token plus the three pinned tail forms. */
const AGREE_PREFIXES = ["agree:", "agree —", "agree -"];

function startsWithAgreeToken(normalized: string): boolean {
  if (normalized === "agree") return true;
  return AGREE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// --- State persistence helpers ---

/** Snapshot the current state into the session log (single commit point). */
function persistState(state: StateRef, pi: ExtensionAPI, debug: Debug): void {
  commit(state.current, pi, debug);
}

/** Shared negotiate → Phase B transition: reset transient flags, then apply the effect. */
function transitionToPhaseB(state: StateRef, pi: ExtensionAPI, ctx: ToolCtx, debug: Debug): void {
  state.current.phase = "B";
  state.current.lastPhase = "negotiate";
  state.current.round = 1;
  state.current.turnsThisPhase = 1;
  state.current.justTransitioned = true;
  state.current.dispute = { status: "none" };
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
    // S2: the RECORDED filer (set at filing) — the old re-derivation from
    // disputeMode was wrong for a writer-filed dispute at filing time.
    filer: state.current.dispute?.filer ?? "writer",
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

function logEscalation(state: StateRef, pi: ExtensionAPI, ctx: ToolCtx, debug: Debug): void {
  state.current.phase = "escalated";
  state.current.dispute = { status: "none" };
  persistState(state, pi, debug);
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
  persistState(state, pi, debug);
  ctx.ui.setStatus("loop", "status" in effect ? effect.status : "Phase B — round 1");
}

// --- Phase × Tool policy (bug-phase-0-approval-dead-end) ---
//
// The (phase × tool) matrix is a closed, exhaustive policy at the type level:
// a new Phase without a policy row is a compile error.

type ProposePolicy = "phase0" | "negotiate" | "dispute" | "reject";
type ReviewPolicy = "phase0" | "negotiate" | "dispute" | "reject";

const PROPOSE_POLICY: Record<Phase, ProposePolicy> = {
  review: "phase0", negotiate: "negotiate", B: "dispute",
  A: "reject", C: "reject", done: "reject", escalated: "reject", idle: "reject",
};
const REVIEW_POLICY: Record<Phase, ReviewPolicy> = {
  review: "phase0", negotiate: "negotiate", B: "dispute",
  A: "reject", C: "reject", done: "reject", escalated: "reject", idle: "reject",
};

const PROPOSE_REJECT_TEXT = "negotiate_propose is not available in this phase.";
const REVIEW_REJECT_TEXT = "negotiate_review is not available in this phase.";

// --- Phase 0 handlers (bug-phase-0-approval-dead-end) ---

/**
 * Phase 0 approve: the same transition as cmdApprove (src/commands.ts).
 * "Same transition, two entry points" — the agent's negotiate_propose("approve")
 * and the human's /loop-approve perform identical field writes.
 */
function executePhase0Approve(
  state: StateRef,
  pi: ExtensionAPI,
  ctx: ToolCtx,
  debug: Debug,
): ToolResult {
  debug("Phase 0 approve → Phase A, round 1");
  state.current.phase = "A";
  state.current.round = 1;
  state.current.awaitingReview = false;
  state.current.turnsThisPhase = 1;

  const lang = getLanguageConfig(state.current.language);
  ctx.ui.notify("Spec review approved. Phase A: Tester writes contract.", "info");
  ctx.ui.setStatus("loop", "Phase A — round 1");
  persistState(state, pi, debug);

  pi.sendUserMessage(
    lang.prompts.promptTesterPhaseA(state.current.specPath, state.current.buildTool),
    { triggerTurn: true },
  );
  return { content: [{ text: "Proposal recorded. Moving to Phase A." }] };
}

/**
 * Phase 0 feedback: record the plan as review feedback. Does NOT auto-reloop
 * Phase 0 — a human decides via /loop-approve or /loop-continue.
 */
function executePhase0Feedback(
  state: StateRef,
  pi: ExtensionAPI,
  ctx: ToolCtx,
  debug: Debug,
  plan: string,
): ToolResult {
  debug(`Phase 0 feedback: ${plan.slice(0, 60)}`);
  state.current.lastProposal = plan;
  persistState(state, pi, debug);
  ctx.ui.notify("Phase 0: feedback recorded. The review continues — refine the spec or re-run /loop.", "info");
  return { content: [{ text: "Feedback recorded. The review continues." }] };
}

/**
 * Reject: the tool is not available in this phase. No state mutation of any
 * kind — in particular lastProposal is NOT written (the poisoning fix).
 */
function executeReject(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  toolName: string,
  text: string,
): ToolResult {
  debug(`${toolName} rejected in phase ${state.current.phase}`);
  pi.appendEntry("loop-refusal", {
    phase: state.current.phase,
    tool: toolName,
    reason: "not-available-in-phase",
  });
  return { content: [{ text }] };
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
    description: "Propose an implementation approach, dispute a test, or concede with 'agree'.",
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

  switch (PROPOSE_POLICY[phase]) {
    case "negotiate":
      state.current.lastProposal = plan;
      return handleNegotiatePropose(state, pi, debug, ctx, plan);
    case "dispute":
      state.current.lastProposal = plan;
      return handleBDisputePropose(state, pi, debug, ctx, plan);
    case "phase0":
      if (plan === "approve") {
        return executePhase0Approve(state, pi, ctx, debug);
      }
      return executePhase0Feedback(state, pi, ctx, debug, plan);
    case "reject":
      return executeReject(state, pi, debug, "negotiate_propose", PROPOSE_REJECT_TEXT);
  }
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

/**
 * writer-dispute-concede: a Phase B Writer proposal is a concession iff it is
 * lexically "agree" (any case, trimmed). Exact match — "agreed" or "I agree"
 * still file a dispute. Pinned separately from isApproval so a future
 * isApproval widening does not silently change dispute semantics.
 */
function isConcession(plan: string): boolean {
  return plan.trim().toLowerCase() === "agree";
}

function executeWriterConcedeDispute(
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

function handleBDisputePropose(
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
  debug(`Dispute filed: ${plan.slice(0, 60)}`);

  logDisputeEntry(state, pi, debug, plan);
  return triggerDisputeReview(state, pi, debug);
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
  persistState(state, pi, debug);
  return buildProposeResult();
}

function triggerDisputeReview(state: StateRef, pi: ExtensionAPI, debug: Debug): ToolResult {
  // The review turn is scheduled at the next settle (status "filed" →
  // "in-review", dispute.ts). The status survives a reload — the old
  // awaitDisputeReview flag evaporated with clearTransientFlags.
  persistState(state, pi, debug);
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

  switch (REVIEW_POLICY[phase]) {
    case "negotiate":
      return handleNegotiateReview(state, pi, debug, ctx, decision);
    case "dispute":
      return handleBDisputeReview(state, pi, debug, ctx, decision);
    case "phase0":
      if (isApproval(decision)) {
        return executePhase0Approve(state, pi, ctx, debug);
      }
      return executePhase0Feedback(state, pi, ctx, debug, decision);
    case "reject":
      return executeReject(state, pi, debug, "negotiate_review", REVIEW_REJECT_TEXT);
  }
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
    // bug-negotiate-drift row 2: an approve of a real contract proposal on a
    // Tester turn (even round) is a claim about the file — the Tester
    // re-reviews the contract file read-only before the advance. 'agree'
    // (row 3) asserts the file already matches and skips straight to B.
    if (state.current.round % 2 === 0 && !isAgreeProposal(state.current.lastProposal)) {
      return executeNegotiateReReview(state, pi, debug);
    }
    return executeNegotiateApprove(state, pi, debug, ctx);
  }
  return executeNegotiateFeedback(state, pi, debug, decision);
}

function executeNegotiateReReview(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
): ToolResult {
  debug("Approved → contract re-review (Tester verifies file)");
  const lang = getLanguageConfig(state.current.language);
  state.current.round++;
  state.current.negotiateProposed = false;
  state.current.negotiateFeedback = "";
  state.current.justTransitioned = true;
  persistState(state, pi, debug);
  pi.sendUserMessage(GP.promptNegotiateContractReReview(lang.testFilePattern), { triggerTurn: true });
  return { content: [{ text: "Proposal accepted. Re-reviewing the contract file before Phase B." }] };
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

  // S1: the budget is consumed at resolution. The filer is the RECORDED
  // value from filing — never re-derived (disputeMode no longer exists).
  state.current.disputeCount++;
  const filer = state.current.dispute?.filer ?? "writer";

  if (isApproval(decision)) {
    // Table 2: row 1 (Writer filed) → Tester fixes the test; row 3 (Tester
    // filed) → Writer fixes the flagged file(s).
    if (state.current.disputeCount >= state.current.maxDispute) {
      logEscalation(state, pi, ctx, debug);
      return buildReviewResult(state.current.phase as Phase, "approve");
    }
    state.current.dispute = { ...state.current.dispute, status: "conceded", decision: "concede" };
    persistState(state, pi, debug);
    if (filer === "tester") {
      logDisputeConcession(state, pi);
    }
    return buildReviewResult(state.current.phase as Phase, "approve");
  }

  if (state.current.disputeCount >= state.current.maxDispute) {
    logEscalation(state, pi, ctx, debug);
    return buildReviewResult(state.current.phase as Phase, decision);
  }
  state.current.dispute = { ...state.current.dispute, status: "defended", decision };
  persistState(state, pi, debug);
  return buildReviewResult(state.current.phase as Phase, decision);
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
  persistState(state, pi, debug);
  return buildReviewResult(state.current.phase as Phase, decision);
}
