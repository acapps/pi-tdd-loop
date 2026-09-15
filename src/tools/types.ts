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
 * fix-negotiate-confirm-approval-loop §1 + session 01a0a668: a Writer
 * proposal is a confirmation iff the first word is "agree" (case-
 * insensitive, trimmed). Trailing text is explanation, not a condition:
 * "agree\n\nTests match..." is an agreement.
 *
 * Leniency: the Writer is an LLM — it's verbose by nature. It may say
 * "agree", "agreed", "I agree", "Yes, I agree", "agree — tests match",
 * "agree. Implementation plan: ...". All of these are agreements.
 *
 * The regex matches "agree" as the first word (after optional leading
 * words like "i", "yes", "ok", "sure", "yep") followed by any non-word
 * character or end-of-string. "agreed" is handled by the optional "d"
 * suffix. "agree with conditions" is NOT an agreement (the "with"
 * starts a new word after a space — the regex matches "agree" at the
 * start, but the trailing " with..." is a condition, not explanation).
 *
 * Actually, let's keep it simple: the first word (after optional
 * leading fillers) is "agree" or "agreed". Everything after is
 * explanation. The Writer is confirming, not proposing.
 */
export function isAgreeProposal(lastProposal: string): boolean {
  let trimmed = lastProposal.trim().toLowerCase();
  // Strip leading fillers repeatedly: "i agree", "yes, i agree", "ok, sure, agree"
  const filler = /^(i|yes|ok|okay|sure|yep|yeah)[,\s]+/;
  let prev;
  do {
    prev = trimmed;
    trimmed = trimmed.replace(filler, "");
  } while (trimmed !== prev);
  // First word is "agree" or "agreed" (word boundary after)
  return /^(agree|agreed)(?!\w)/.test(trimmed);
}
