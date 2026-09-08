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
  // Dispute lifecycle (bug-dispute-reload-evaporation): one status object
  // replaces the old 6 flat fields (disputeMode, awaitDisputeFix,
  // awaitDisputeReview, disputeDefended, awaitWriterConcedeFix, disputeFiler).
  dispute?: DisputeState;
  disputeCount: number;
  turnsThisPhase: number;
  lastProposal: string;
  lastPhase: Phase;
  justTransitioned: boolean;
  negotiateReprompted: boolean;
  lastGateResult?: GateResult;
  // Negotiate round (spec 07): set by tools, consumed + cleared by the settle
  // handler; undefined and "" both mean "no feedback pending".
  negotiateProposed?: boolean;
  negotiateFeedback?: string;
  // Phase 0
  specFindings?: Finding[];
  awaitingReview?: boolean;
  // Git branch workflow (--branch, opt-in): set by /loop when --branch is
  // given; consumed by the done effect (merge back) and by /loop-continue /
  // /loop-restart (must NOT re-branch). `merged` flips true once the merge
  // into the mainline has landed.
  branch?: { name: string; base: string; merged: boolean };
}

export interface FailingTest {
  test: string;
  subtest: string;
  output: string;
}

// Dispute lifecycle (bug-dispute-reload-evaporation.md). The status is the
// only mechanism: a reload never destroys a pending dispute — filed /
// in-review / conceded / defended survive restore and redeliver on the next
// settle; closed / none are no-ops.
export type DisputeStatus = "none" | "filed" | "in-review" | "conceded" | "defended" | "closed";

export interface DisputeState {
  status: DisputeStatus;
  // Set at filing (was: re-derived from disputeMode).
  filer?: "writer" | "tester";
  // The proposal text that filed it (was: lastProposal, shared).
  claim?: string;
  // The review decision (was: disputeDefended).
  decision?: string;
  // Round at filing — for the redelivery prompt.
  filedRound?: number;
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

export interface SpecAnalysis {
  findings: Finding[];
  reasons: string[];
}

export interface ClarificationAddendum {
  findings: Finding[];
  clarifications: Clarification[];
  appliedInterpretations: string[];
}
