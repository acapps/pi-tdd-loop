// --- Phase × Tool policy (bug-phase-0-approval-dead-end) ---
//
// The (phase × tool) matrix is a closed, exhaustive policy at the type level:
// a new Phase without a policy row is a compile error. Leaf module: imports
// only src/types.

import type { Phase } from "../types";

export type ProposePolicy = "phase0" | "negotiate" | "dispute" | "reject";
export type ReviewPolicy = "phase0" | "negotiate" | "dispute" | "reject";

export const PROPOSE_POLICY: Record<Phase, ProposePolicy> = {
  review: "phase0", negotiate: "negotiate", B: "dispute",
  A: "reject", C: "reject", done: "reject", escalated: "reject", idle: "reject",
};
export const REVIEW_POLICY: Record<Phase, ReviewPolicy> = {
  review: "phase0", negotiate: "negotiate", B: "dispute",
  A: "reject", C: "reject", done: "reject", escalated: "reject", idle: "reject",
};

export const PROPOSE_REJECT_TEXT = "negotiate_propose is not available in this phase.";
export const REVIEW_REJECT_TEXT = "negotiate_review is not available in this phase.";

// --- Tool parameter schemas (the public contract the agent sees) ---

export const PROPOSE_PARAMETERS = {
  type: "object",
  properties: {
    plan: {
      type: "string",
      description:
        "Implementation approach or 'agree' to accept tests as-is, or a dispute claim.",
    },
  },
  required: ["plan"],
} as const;

export const REVIEW_PARAMETERS = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      description: "'approve' to accept, or feedback text.",
    },
  },
  required: ["decision"],
} as const;
