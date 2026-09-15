// --- negotiate_propose / negotiate_review tool definitions + handlers ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as GP from "../generic-prompts";
import { getLanguageConfig } from "../languages";
import { sendPrompt } from "../prompt";
import { persistState, logNegotiateEntry, transitionToPhaseB } from "./state-io";
import { isApproval, isAgreeProposal, buildProposeResult, buildReviewResult } from "./types";
import type { StateRef, ToolCtx, ToolResult, Debug } from "./types";
import { handleBDisputePropose, handleBDisputeReview } from "./dispute";
import { executePhase0Approve, executePhase0Feedback, executeReject } from "./phase0";
import {
  PROPOSE_POLICY, REVIEW_POLICY, PROPOSE_REJECT_TEXT, REVIEW_REJECT_TEXT,
  PROPOSE_PARAMETERS, REVIEW_PARAMETERS,
} from "./policy";

export function negotiatePropose(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
) {
  return {
    name: "negotiate_propose",
    label: "Propose Implementation",
    description: "Propose an implementation approach, dispute a test, or concede with 'agree'.",
    parameters: PROPOSE_PARAMETERS,
    execute: async (_callId: string, args: { plan: string }, _meta: unknown, _ctx: unknown, toolCtx: ToolCtx) =>
      handlePropose(state, pi, debug, toolCtx, args.plan),
  };
}

function handlePropose(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  plan: string,
): ToolResult {
  const phase = state.current.phase;
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
    parameters: REVIEW_PARAMETERS,
    execute: async (_callId: string, args: { decision: string }, _meta: unknown, _ctx: unknown, toolCtx: ToolCtx) =>
      handleReview(state, pi, debug, toolCtx, args.decision),
  };
}

function handleReview(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
  decision: string,
): ToolResult {
  const phase = state.current.phase;
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
    // Tester turn (even round) is a claim about the file — the Tester re-reviews
    // the contract file read-only before the advance. 'agree' (row 3) asserts
    // the file already matches and skips straight to B.
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
  sendPrompt(pi, GP.promptNegotiateContractReReview(lang.testFilePattern), state.current, debug);
  return { content: [{ text: "Proposal accepted. Re-reviewing the contract file before Phase B." }] };
}

function executeNegotiateApprove(
  state: StateRef,
  pi: ExtensionAPI,
  debug: Debug,
  ctx: ToolCtx,
): ToolResult {
  debug("Approved → Phase B");
  transitionToPhaseB(state, pi, ctx, debug);
  return buildReviewResult(state.current.phase, "approve");
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
  return buildReviewResult(state.current.phase, decision);
}
