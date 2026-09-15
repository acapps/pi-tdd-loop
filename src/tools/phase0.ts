// --- Phase 0 handlers (bug-phase-0-approval-dead-end) ---
// Depends on: types.ts, state-io.ts, phase-a.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startPhaseA } from "../phase-a";
import { persistState } from "./state-io";
import type { StateRef, ToolCtx, ToolResult, Debug } from "./types";

/**
 * Phase 0 approve: the same transition as cmdApprove (src/commands/lifecycle.ts).
 * "Same transition, two entry points" — the agent's negotiate_propose("approve")
 * and the human's /loop-approve both call startPhaseA.
 */
export function executePhase0Approve(
  state: StateRef,
  pi: ExtensionAPI,
  ctx: ToolCtx,
  debug: Debug,
): ToolResult {
  startPhaseA(state, pi, ctx, debug);
  return { content: [{ text: "Proposal recorded. Moving to Phase A." }] };
}

/**
 * Phase 0 feedback: record the plan as review feedback. Does NOT auto-reloop
 * Phase 0 — a human decides via /loop-approve or /loop-continue.
 */
export function executePhase0Feedback(
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
export function executeReject(
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
