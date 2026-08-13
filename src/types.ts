// --- Types ---

export type Phase = "A" | "negotiate" | "B" | "C" | "done" | "escalated" | "idle";
export type LanguageKey = "go" | "java" | "typescript";
export type BuildTool = "maven" | "gradle" | "go";

export interface LoopState {
  phase: Phase;
  round: number;
  specPath: string;
  language: LanguageKey;
  buildTool: BuildTool;
  maxA: number;
  maxNegotiate: number;
  maxB: number;
  maxC: number;
  maxDispute: number;
  maxTurnsPerPhase: number;
  coverageThreshold: number;
  disputeMode: boolean;
  disputeCount: number;
  turnsThisPhase: number;
  lastProposal: string;
  lastPhase: Phase;
  justTransitioned: boolean;
  negotiateReprompted: boolean;
  awaitDisputeFix: boolean;
  awaitDisputeReview: boolean;
  lastGateResult?: GateResult;
}

export interface LoopMetrics {
  totalGates: number;
  gateRuns: number;
  roundsByPhase: Record<string, number>;
  disputesRaised: number;
  filesBlocked: number;
  finalPhase: string;
  testFails: number;
  compileFails: number;
  coverage: number;
}

export interface FailingTest {
  test: string;
  subtest: string;
  output: string;
}

export interface GateResult {
  compile: boolean;
  compileError: string;
  tests: boolean;
  allPassed: boolean;
  coverage: number;
  failures: FailingTest[];
}
