// --- Negotiation tools ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, Phase } from "./types";
import * as T from "./transitions";
import * as GP from "./generic-prompts";
import { getLanguageConfig } from "./languages";

// --- Types ---

interface ToolCtx {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  mode: string;
  hasUI: boolean;
}

// --- Helpers ---

function buildProposeResult(phase: Phase, inNegotiate: boolean): { content: { text: string }[] } {
  if (inNegotiate) {
    return { content: [{ text: "Proposal recorded. Awaiting review." }] };
  }
  return { content: [{ text: "Proposal recorded. Awaiting review." }] };
}

function buildReviewResult(
  phase: Phase,
  action: string,
): { content: { text: string }[] } {
  if (action === "approve" || action === "approved") {
    return { content: [{ text: "Approved." }] };
  }
  return { content: [{ text: "Feedback recorded." }] };
}

function isNegotiatePhase(phase: string): boolean {
  return phase === "negotiate";
}

function isPhaseB(phase: string): boolean {
  return phase === "B";
}

// --- negotiate_propose ---

export function negotiatePropose(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
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
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  plan: string,
): { content: { text: string }[] } {
  const phase = state.current.phase as Phase;
  debug(`negotiate_propose: plan=${plan.slice(0, 80)}... phase=${phase}`);

  state.current.lastProposal = plan;

  if (isNegotiatePhase(phase)) {
    return handleNegotiatePropose(state, pi, debug, ctx, plan);
  }
  if (isPhaseB(phase)) {
    return handleBDisputePropose(state, pi, debug, ctx, plan);
  }
  return buildProposeResult(phase, false);
}

function handleNegotiatePropose(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  plan: string,
): { content: { text: string }[] } {
  debug(`Writer proposes`);
  logNegotiateEntry(state, pi, debug, "propose", plan);

  if (plan === "agree") {
    return executeNegotiateAgree(state, pi, debug, ctx);
  }
  return executeNegotiateProposal(state, pi, debug, ctx);
}

function handleBDisputePropose(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  plan: string,
): { content: { text: string }[] } {
  state.current.disputeCount++;
  debug(`Dispute #${state.current.disputeCount}: ${plan.slice(0, 60)}`);

  if (state.current.disputeCount >= state.current.maxDispute) {
    logEscalation(state, pi, ctx);
    return buildProposeResult(state.current.phase as Phase, false);
  }

  logDisputeEntry(state, pi, debug, plan);
  return triggerDisputeReview(state, pi, ctx);
}

function executeNegotiateAgree(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
): { content: { text: string }[] } {
  debug("Approved → Phase B");
  state.current.phase = "B" as Phase;
  state.current.round = 1;
  state.current.turnsThisPhase = 1;
  state.current.justTransitioned = true;
  state.current.negotiateReprompted = false;
  state.current.lastPhase = "negotiate" as Phase;
  applyTransitionEffect(state, pi, ctx, debug, {
    type: "advance",
    phase: "B" as Phase,
    status: "Phase B — round 1",
    notify: "Approved — moving to Phase B.",
  });
  return { content: [{ text: "Proposal recorded. Moving to Phase B." }] };
}

function executeNegotiateProposal(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
): { content: { text: string }[] } {
  debug("negotiate_propose: proposal recorded");
  return triggerTesterReview(state, pi, ctx);
}

function triggerTesterReview(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: ToolCtx,
): { content: { text: string }[] } {
  const lang = getLanguageConfig(state.current.language);
  const proposal = state.current.lastProposal;
  const prompt = GP.promptNegotiateProposalForReview(proposal);
  sendContextMessage(pi, prompt);
  return buildProposeResult(state.current.phase as Phase, true);
}

function triggerDisputeReview(
  state: { current: LoopState },
  pi: ExtensionAPI,
  _ctx: ToolCtx,
): { content: { text: string }[] } {
  state.current.awaitDisputeReview = true;
  pi.appendEntry("loop-state", { ...state.current });
  return {
    content: [{ text: "Dispute filed. STOP producing tool calls. The Tester will review and respond." }],
  };
}

// --- negotiate_review ---

export function negotiateReview(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
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
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  decision: string,
): { content: { text: string }[] } {
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
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  decision: string,
): { content: { text: string }[] } {
  debug(`Reviewer: ${isApproval(decision) ? "approve" : "feedback"}`);
  logNegotiateEntry(state, pi, debug, "review", decision);

  if (isApproval(decision)) {
    return executeNegotiateApprove(state, pi, debug, ctx);
  }
  return executeNegotiateFeedback(state, pi, debug, ctx, decision);
}

function handleBDisputeReview(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  decision: string,
): { content: { text: string }[] } {
  debug(`Dispute review: ${isApproval(decision) ? "conceded" : "defended"}`);
  logDisputeEntry(state, pi, debug, decision);

  if (isApproval(decision)) {
    return executeBDisputeConcede(state, pi, debug, ctx);
  }
  return executeBDisputeDefend(state, pi, debug, ctx, decision);
}

function executeNegotiateApprove(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
): { content: { text: string }[] } {
  debug("Approved → Phase B");
  state.current.phase = "B" as Phase;
  state.current.round = 1;
  state.current.turnsThisPhase = 1;
  state.current.justTransitioned = true;
  state.current.negotiateReprompted = false;
  state.current.lastPhase = "negotiate" as Phase;
  applyTransitionEffect(state, pi, ctx, debug, {
    type: "advance",
    phase: "B" as Phase,
    status: "Phase B — round 1",
    notify: "Approved — moving to Phase B.",
  });
  return buildReviewResult(state.current.phase as Phase, "approve");
}

function executeNegotiateFeedback(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  decision: string,
): { content: { text: string }[] } {
  debug("negotiate_review: feedback");
  const lang = getLanguageConfig(state.current.language);
  const prompt = GP.promptNegotiateFeedback(decision);
  sendContextMessage(pi, prompt);
  return buildReviewResult(state.current.phase as Phase, decision);
}

function executeBDisputeConcede(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
): { content: { text: string }[] } {
  debug("Tester conceded — will fix test");
  state.current.disputeMode = true;
  state.current.awaitDisputeFix = true;
  pi.appendEntry("loop-state", { ...state.current });
  logDisputeConcession(state, pi, ctx);
  return buildReviewResult(state.current.phase as Phase, "approve");
}

function executeBDisputeDefend(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: ToolCtx,
  decision: string,
): { content: { text: string }[] } {
  debug("negotiate_review: defend dispute");
  state.current.round++;
  const lang = getLanguageConfig(state.current.language);
  const prompt = GP.promptWriterDisputeDefended(decision);
  sendContextMessage(pi, prompt);
  return buildReviewResult(state.current.phase as Phase, decision);
}

// --- Shared helpers ---

function isApproval(decision: string): boolean {
  return decision === "approve" || decision === "approved";
}

function logNegotiateEntry(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
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

function logDisputeEntry(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  text: string,
): void {
  debug(`dispute: ${text.slice(0, 60)}`);
  pi.appendEntry("loop-dispute", {
    phase: state.current.phase,
    round: state.current.round,
    disputeCount: state.current.disputeCount,
    claim: text.slice(0, 500),
    text: text.slice(0, 500),
  });
}

function logDisputeConcession(
  state: { current: LoopState },
  pi: ExtensionAPI,
  _ctx: ToolCtx,
): void {
  pi.appendEntry("loop-dispute", {
    phase: state.current.phase,
    round: state.current.round,
    action: "concede",
  });
}

function logEscalation(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: ToolCtx,
): void {
  state.current.phase = "escalated";
  pi.appendEntry("loop-state", { ...state.current });
  ctx.ui.notify("Dispute limit reached. Escalating to human.", "warning");
  ctx.ui.setStatus("loop", "escalated (dispute limit)");
}

function applyTransitionEffect(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: ToolCtx,
  debug: (msg: string) => void,
  effect: ReturnType<typeof T.computeNegotiateTransition>["effect"],
): void {
  debug(`applying transition: ${effect.type}`);
  pi.appendEntry("loop-state", { ...state.current });
  ctx.ui.setStatus("loop", (effect as Record<string, string>).status || "Phase B — round 1");
}

function sendContextMessage(pi: ExtensionAPI, content: string): void {
  pi.sendUserMessage(content, { triggerTurn: true });
}
