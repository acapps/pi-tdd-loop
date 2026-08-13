// --- Golden E2E Scenario Definitions ---

import type { GateScenario } from "./types";

// Happy path: all phases pass on first attempt
export const scenarioHappyPath: GateScenario = {
  name: "happy-path",
  phaseA: ["pass"],
  negotiate: "agree",
  phaseB: ["pass"],
  phaseC: ["pass"],
  expectedPhase: "done",
  expectedRounds: { A: 1, negotiate: 1, B: 1, C: 1 },
};

// B retry: Phase B fails once, then passes
export const scenarioBRetry: GateScenario = {
  name: "b-retry",
  phaseA: ["pass"],
  negotiate: "agree",
  phaseB: ["fail", "pass"],
  phaseC: ["pass"],
  expectedPhase: "done",
  expectedRounds: { A: 1, negotiate: 1, B: 2, C: 1 },
};

// Dispute conceded: Writer disputes, Tester concedes, then passes
export const scenarioDisputeConceded: GateScenario = {
  name: "dispute-conceded",
  phaseA: ["pass"],
  negotiate: "agree",
  phaseB: ["dispute", "pass"],
  phaseC: ["pass"],
  expectedPhase: "done",
  expectedRounds: { A: 1, negotiate: 1, B: 2, C: 1 },
};

// Escalation: Phase B exhausts all retries
export const scenarioEscalation: GateScenario = {
  name: "escalation",
  phaseA: ["pass"],
  negotiate: "agree",
  phaseB: ["fail", "fail", "fail", "fail", "fail"],
  phaseC: [],
  expectedPhase: "escalated",
  expectedRounds: { A: 1, negotiate: 1, B: 5 },
};

// Phase C refactor fail: B passes, C fails then recovers
export const scenarioPhaseCFail: GateScenario = {
  name: "phase-c-fail",
  phaseA: ["pass"],
  negotiate: "agree",
  phaseB: ["pass"],
  phaseC: ["fail", "pass"],
  expectedPhase: "done",
  expectedRounds: { A: 1, negotiate: 1, B: 1, C: 2 },
};

// A retry: Phase A fails once, then passes
export const scenarioARetry: GateScenario = {
  name: "a-retry",
  phaseA: ["fail", "pass"],
  negotiate: "agree",
  phaseB: ["pass"],
  phaseC: ["pass"],
  expectedPhase: "done",
  expectedRounds: { A: 2, negotiate: 1, B: 1, C: 1 },
};

// A escalation: Phase A exhausts all retries
export const scenarioAEscalation: GateScenario = {
  name: "a-escalation",
  phaseA: ["fail", "fail", "fail"],
  negotiate: "agree",
  phaseB: [],
  phaseC: [],
  expectedPhase: "escalated",
  expectedRounds: { A: 3 },
};

// C mark-done on exhaustion: C fails at maxC, loop marks done
export const scenarioCExhaustion: GateScenario = {
  name: "c-exhaustion",
  phaseA: ["pass"],
  negotiate: "agree",
  phaseB: ["pass"],
  phaseC: ["fail", "fail", "fail"],
  expectedPhase: "done",
  expectedRounds: { A: 1, negotiate: 1, B: 1, C: 3 },
};

// Negotiate feedback: negotiate phase requires feedback before agreement
export const scenarioNegotiateFeedback: GateScenario = {
  name: "negotiate-feedback",
  phaseA: ["pass"],
  negotiate: "feedback",
  phaseB: ["pass"],
  phaseC: ["pass"],
  expectedPhase: "done",
  expectedRounds: { A: 1, negotiate: 2, B: 1, C: 1 },
};

// Export all scenarios as a keyed object
export const scenarios: Record<string, GateScenario> = {
  "happy-path": scenarioHappyPath,
  "b-retry": scenarioBRetry,
  "dispute-conceded": scenarioDisputeConceded,
  "escalation": scenarioEscalation,
  "phase-c-fail": scenarioPhaseCFail,
  "a-retry": scenarioARetry,
  "a-escalation": scenarioAEscalation,
  "c-exhaustion": scenarioCExhaustion,
  "negotiate-feedback": scenarioNegotiateFeedback,
};
