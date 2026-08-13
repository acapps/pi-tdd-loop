// --- Transition logic (pure functions) ---

import type { LoopState, Phase, GateResult } from "./types";

// --- Types ---

type TransitionEffect =
  | { type: "noop" }
  | { type: "retry"; phase: Phase; round: number; status: string; notify?: string; level?: string; prompt?: RetryPrompt }
  | { type: "advance"; phase: Phase; status: string; notify: string; prompt?: AdvancePrompt }
  | { type: "done"; status: string; notify: string }
  | { type: "escalated"; status: string; notify: string }
  | { type: "reprompt"; notify: string; level: string; prompt: string };

type RetryPrompt =
  | "tester_compile_retry"
  | "writer_phase_b_retry"
  | "cleaner_retry"
  | "writer_dispute_fix_incomplete"
  | "tester_dispute_fix_compile_fail";

type AdvancePrompt =
  | "writer_negotiate"
  | "cleaner_phase_c"
  | string;

// --- Public API ---

export function computeTransition(
  state: LoopState,
  gate: GateResult | null,
): { state: LoopState; effect: TransitionEffect } {
  if (gate === null) return handleNoGate(state);
  if (isTesterCompileFail(state, gate)) {
    return handleTesterCompileFail(state, gate);
  }
  if (isWriterDisputeFixIncomplete(state)) {
    return handleDisputeFixIncomplete(state, gate);
  }
  if (state.phase === "A" && gate.compile) {
    return { state: advanceToNegotiate(state), effect: advanceEffect("negotiate", "writer_negotiate") };
  }
  if (state.phase === "B") {
    return handlePhaseBTransition(state, gate);
  }
  if (state.phase === "C") {
    return handlePhaseCTransition(state, gate);
  }
  return { state, effect: { type: "noop" } };
}

export function computeNegotiateTransition(
  state: LoopState,
): { state: LoopState; effect: TransitionEffect } {
  if (state.negotiateReprompted) {
    return autoAdvanceToPhaseB(state);
  }
  if (state.round % 2 === 1) {
    return repromptWriter(state);
  }
  return repromptTester(state);
}

function autoAdvanceToPhaseB(state: LoopState): { state: LoopState; effect: TransitionEffect } {
  return {
    state: { ...advanceToPhaseB(state), negotiateReprompted: false },
    effect: {
      type: "advance",
      phase: "B" as Phase,
      status: "Phase B — round 1",
      notify: "Advancing to Phase B without explicit proposal.",
      prompt: "cleaner_phase_c",
    },
  };
}

function repromptWriter(state: LoopState): { state: LoopState; effect: TransitionEffect } {
  return {
    state: { ...state, negotiateReprompted: true },
    effect: {
      type: "reprompt",
      notify: "Writer must use negotiate_propose tool.",
      level: "warning",
      prompt: "negotiate_reprompt_writer",
    },
  };
}

function repromptTester(state: LoopState): { state: LoopState; effect: TransitionEffect } {
  return {
    state,
    effect: {
      type: "reprompt",
      notify: "Tester must use negotiate_review tool.",
      level: "warning",
      prompt: "negotiate_reprompt_tester",
    },
  };
}

// --- No-gate handler ---

function handleNoGate(state: LoopState): { state: LoopState; effect: TransitionEffect } {
  if (state.phase === "negotiate") {
    return computeNegotiateTransition(state);
  }
  return { state, effect: { type: "noop" } };
}

// --- Phase A ---

function isTesterCompileFail(state: LoopState, gate: GateResult): boolean {
  return state.phase === "A" && !gate.compile;
}

function handleTesterCompileFail(
  state: LoopState,
  gate: GateResult,
): { state: LoopState; effect: TransitionEffect } {
  if (state.round < state.maxA) {
    return {
      state: incrementRound(state),
      effect: retryEffect(state, "tester_compile_retry"),
    };
  }
  return {
    state: escalateTo(state, "A"),
    effect: escalatedEffect("A"),
  };
}

// --- Phase B ---

function isWriterDisputeFixIncomplete(state: LoopState): boolean {
  return state.phase === "B" && state.disputeMode;
}

function handleDisputeFixIncomplete(
  state: LoopState,
  gate: GateResult,
): { state: LoopState; effect: TransitionEffect } {
  if (!gate.compile) {
    return {
      state: clearDisputeMode(state),
      effect: {
        type: "retry",
        phase: state.phase as Phase,
        round: state.round + 1,
        status: `Phase ${state.phase} — round ${state.round + 1}`,
        notify: "compile failed after dispute fix.",
        level: "warning",
        prompt: "tester_dispute_fix_compile_fail",
      },
    };
  }
  if (!gate.tests) {
    return {
      state: clearDisputeMode(state),
      effect: retryEffect(state, "writer_dispute_fix_incomplete"),
    };
  }
  return { state: advanceToPhaseC(state), effect: advanceEffect("C", "cleaner_phase_c") };
}

function handlePhaseBTransition(
  state: LoopState,
  gate: GateResult,
): { state: LoopState; effect: TransitionEffect } {
  if (!gate.compile) {
    if (state.round >= state.maxB) {
      return { state: escalateTo(state, "B"), effect: escalatedEffect("B") };
    }
    return { state: incrementRound(state), effect: retryEffect(state, "writer_phase_b_retry") };
  }
  if (!gate.allPassed) {
    if (state.round >= state.maxB) {
      return { state: escalateTo(state, "B"), effect: escalatedEffect("B") };
    }
    return { state: incrementRound(state), effect: retryEffect(state, "writer_phase_b_retry") };
  }
  return { state: advanceToPhaseC(state), effect: advanceEffect("C", "cleaner_phase_c") };
}

// --- Phase C ---

function handlePhaseCTransition(
  state: LoopState,
  gate: GateResult,
): { state: LoopState; effect: TransitionEffect } {
  if (!gate.tests) {
    if (state.round < state.maxC) {
      return { state: incrementRound(state), effect: retryEffect(state, "cleaner_retry") };
    }
    return {
      state: markDone(state),
      effect: doneEffect("done (cleaner failed)", "Phase C failed, keeping original code. Loop complete."),
    };
  }
  return { state: markDone(state), effect: doneEffect("done", "All phases complete.") };
}

// --- State builders ---

function incrementRound(state: LoopState): LoopState {
  return { ...state, round: state.round + 1 };
}

function advanceToNegotiate(state: LoopState): LoopState {
  return {
    ...state,
    phase: "negotiate" as Phase,
    round: 1,
    turnsThisPhase: 1,
  };
}

function advanceToPhaseB(state: LoopState): LoopState {
  return {
    ...state,
    phase: "B" as Phase,
    round: 1,
    turnsThisPhase: 1,
    justTransitioned: true,
    lastPhase: state.phase,
  };
}

function advanceToPhaseC(state: LoopState): LoopState {
  return {
    ...state,
    phase: "C" as Phase,
    round: 1,
    turnsThisPhase: 1,
    disputeMode: false,
  };
}

function escalateTo(state: LoopState, fromPhase: string): LoopState {
  return {
    ...state,
    phase: "escalated" as Phase,
    lastPhase: state.phase as Phase,
    turnsThisPhase: 1,
  };
}

function markDone(state: LoopState): LoopState {
  return { ...state, phase: "done" as Phase, turnsThisPhase: 1 };
}

function clearDisputeMode(state: LoopState): LoopState {
  return { ...state, disputeMode: false, round: state.round + 1 };
}

// --- Effect builders ---

function retryEffect(
  state: LoopState,
  prompt: RetryPrompt,
): TransitionEffect {
  const phase = state.phase as Phase;
  const round = state.round + 1;
  return {
    type: "retry",
    phase,
    round,
    status: `Phase ${phase} — round ${round}`,
    notify: `Gate failed. Retry ${round}/${getPhaseMax(state, phase)}.`,
    level: "warning",
    prompt,
  };
}

function advanceEffect(phase: Phase, prompt: AdvancePrompt): TransitionEffect {
  return {
    type: "advance",
    phase,
    status: `Phase ${phase} — round 1`,
    notify: `Phase passed. Advancing to Phase ${phase}.`,
    prompt,
  };
}

function doneEffect(status: string, notify: string): TransitionEffect {
  return { type: "done", status, notify };
}

function escalatedEffect(phase: string): TransitionEffect {
  return {
    type: "escalated",
    status: `escalated (Phase ${phase} exhausted)`,
    notify: `Phase ${phase} exhausted. Escalating to human.`,
  };
}

function repromptEffect(role: string, promptKey: string): TransitionEffect {
  return {
    type: "reprompt",
    notify: `${role} hasn't used a negotiation tool.`,
    level: "warning",
    prompt: promptKey,
  };
}

// --- Phase-specific exports (for tests) ---

export function computePhaseATransition(
  state: LoopState,
  gate: GateResult | null,
): { state: LoopState; effect: TransitionEffect } {
  return computeTransition(state, gate);
}

export function computePhaseBTransition(
  state: LoopState,
  gate: GateResult | null,
): { state: LoopState; effect: TransitionEffect } {
  return computeTransition(state, gate);
}

export function computePhaseCTransition(
  state: LoopState,
  gate: GateResult | null,
): { state: LoopState; effect: TransitionEffect } {
  return computeTransition(state, gate);
}

export function computeDisputeFixTransition(
  state: LoopState,
  gate: GateResult | null,
): { state: LoopState; effect: TransitionEffect } {
  return computeTransition(state, gate);
}

function getPhaseMax(state: LoopState, phase: string): number {
  switch (phase) {
    case "A": return state.maxA;
    case "negotiate": return state.maxNegotiate;
    case "B": return state.maxB;
    case "C": return state.maxC;
    default: return 0;
  }
}
