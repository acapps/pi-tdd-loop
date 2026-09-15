// --- Shared types + result builders + phase checks + concession helpers ---
// Leaf module: imports only src/types. No sibling src/tools/* imports.

import type { LoopState, Phase } from "../types";

export interface ToolCtx {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  mode: string;
  hasUI: boolean;
}

export type ToolResult = { content: { text: string }[] };

export type Debug = (msg: string) => void;

export interface StateRef {
  current: LoopState;
}

// --- Result builders ---

export function buildProposeResult(): ToolResult {
  return { content: [{ text: "Proposal recorded. Awaiting review." }] };
}

export function buildReviewResult(phase: Phase, action: string): ToolResult {
  if (isApproval(action)) {
    return { content: [{ text: "Approved." }] };
  }
  return { content: [{ text: "Feedback recorded." }] };
}

// --- Phase checks ---

export function isNegotiatePhase(phase: string): phase is "negotiate" {
  return phase === "negotiate";
}

export function isPhaseB(phase: string): phase is "B" {
  return phase === "B";
}

export function isApproval(decision: string): boolean {
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
