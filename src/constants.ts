// --- Shared constants ---
// Eliminates magic strings scattered across transitions, events, tools, and prompts.

// --- Phase names (typed via Phase in types.ts, listed here for iteration) ---

export const PHASES = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"] as const;

// --- Prompt type keys ---
// Used by transitions.ts to select retry/advance prompts.
// Events.ts uses these same keys to build the right prompt.

export const RETRY_PROMPTS = {
  TESTER_COMPILE_RETRY: "tester_compile_retry",
  WRITER_PHASE_B_RETRY: "writer_phase_b_retry",
  CLEANER_RETRY: "cleaner_retry",
  WRITER_DISPUTE_FIX_INCOMPLETE: "writer_dispute_fix_incomplete",
  TESTER_DISPUTE_FIX_COMPILE_FAIL: "tester_dispute_fix_compile_fail",
} as const;

export type RetryPromptType = typeof RETRY_PROMPTS[keyof typeof RETRY_PROMPTS];

export const ADVANCE_PROMPTS = {
  WRITER_NEGOTIATE: "writer_negotiate",
  CLEANER_PHASE_C: "cleaner_phase_c",
} as const;

export type AdvancePromptType = typeof ADVANCE_PROMPTS[keyof typeof ADVANCE_PROMPTS];

// --- Negotion reprompt keys ---

export const REPROMPT_KEYS = {
  WRITER: "negotiate_reprompt_writer",
  TESTER: "negotiate_reprompt_tester",
} as const;
