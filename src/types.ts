// --- Types ---

export type Phase = "review" | "A" | "negotiate" | "B" | "C" | "done" | "escalated" | "idle";
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
  // Phase 0
  specFindings?: Finding[];
  awaitingReview?: boolean;
  skipPhase0?: boolean;
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

// --- Phase 0: Spec Review Types ---

export type FindingCategory =
  | "Ambiguous phrase"
  | "Edge case missing"
  | "Underspecified behavior"
  | "Example-prose conflict"
  | "Type contract gap";

export interface Interpretation {
  label: string;
  description: string;
  testCases: string[];
}

export interface Finding {
  id: number;
  category: FindingCategory;
  title: string;
  ambiguity: string;
  interpretations: Interpretation[];
  recommendation: string;
}

export interface Clarification {
  findingId: number;
  status: "approved" | "rejected" | "modified";
  chosenInterpretation?: string;
  notes?: string;
}

export interface PhaseZeroThresholds {
  minFunctions: number;
  checkErrorMentions: boolean;
  checkIoMentions: boolean;
  checkConcurrencyMentions: boolean;
}

export const DEFAULT_PHASE_ZERO_THRESHOLDS: PhaseZeroThresholds = {
  minFunctions: 3,
  checkErrorMentions: true,
  checkIoMentions: true,
  checkConcurrencyMentions: true,
};

export interface SpecAnalysis {
  findings: Finding[];
  shouldActivatePhase0: boolean;
  reasons: string[];
}

export interface ClarificationAddendum {
  findings: Finding[];
  clarifications: Clarification[];
  appliedInterpretations: string[];
}
