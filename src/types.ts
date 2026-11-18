// --- Types ---

export type Phase = "review" | "A" | "negotiate" | "B" | "C" | "done" | "escalated" | "idle";
export type LanguageKey = "go" | "java" | "typescript";
export type BuildTool = "maven" | "gradle" | "go" | "vitest" | "npm" | "pip" | "cargo";

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
  gateTimeoutSec: number;
  // Dispute lifecycle (bug-dispute-reload-evaporation): one status object
  // replaces the old 6 flat fields (disputeMode, awaitDisputeFix,
  // awaitDisputeReview, disputeDefended, awaitWriterConcedeFix, disputeFiler).
  dispute?: DisputeState;
  disputeCount: number;
  turnsThisPhase: number;
  lastProposal: string;
  lastPhase: Phase;
  justTransitioned: boolean;
  // fix-just-transitioned-settle-drop: distinguishes settle-path transitions
  // (prompt delivered by the settle effect — the next settle is a
  // prompt-delivery settle and must be CONSUMED) from tool-triggered
  // transitions (prompt delivered synchronously in the tool call — the next
  // settle is a work settle and must run the gate). Optional: pre-fix saved
  // entries lack the field; clearTransientFlags heals absent → false.
  justTransitionedBySettle?: boolean;
  negotiateReprompted: boolean;
  lastGateResult?: GateResult;
  // Negotiate round (spec 07): set by tools, consumed + cleared by the settle
  // handler; undefined and "" both mean "no feedback pending".
  negotiateProposed?: boolean;
  negotiateFeedback?: string;
  // fix-negotiated-resolution-dropped: the agreed resolution of a negotiate
  // dispute, captured when the Tester's review feedback names a test-file
  // change. Survives round advances (unlike negotiateFeedback). Cleared when
  // Phase B begins (resetForPhaseB). Absent → no open resolution.
  negotiateResolution?: string;
  // fix-scope-check-baseline: git dirty set at spec start — baseline for the
  // scope-check. Captured in cmdLoop after runPhase0Baseline. Cleared in
  // resetForPhaseB. Absent → scope-check uses all dirty files (backward compat).
  baselineDirtyFiles?: string[];
  // Phase 0
  specFindings?: Finding[];
  awaitingReview?: boolean;
  // Phase 0 auto-approve: when true (default), a clean review (no feedback,
  // no dispute) auto-advances to Phase A. Set false by --no-auto-approve.
  autoApprove?: boolean;
  // Git branch workflow (--branch, opt-in): set by /loop when --branch is
  // given; consumed by the done effect (merge back) and by /loop-continue /
  // /loop-restart (must NOT re-branch). `merged` flips true once the merge
  // into the mainline has landed.
  branch?: { name: string; base: string; merged: boolean };
  // fix-phase0-live-transcript-leaks: bounded-state primitives for Phase 0.
  // These fields are absent from the original LoopState and are added here
  // to enable bounded transcript management and checkpoints.
  checkpointManager?: import("./state/checkpoint").StateCheckpointManager;
  tokenBudget?: number;
  entriesBeforeCompact?: { id: string }[];
  tokensInContext?: number;
  transcriptTokenCount?: number;
  checkpointManagerInit?: (bm: import("./state/checkpoint").StateCheckpointManager) => void;
  _flush?: (state: LoopState) => string;
  _current?: LoopState;
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
  // Gate failures this dispute resolved (recorded at filing from
  // lastGateResult). The Phase B gate excludes these while the dispute is
  // resolved, so a disputed-and-approved failure can't pin the loop forever
  // (session 01a1c72a: a conceded scope-check dispute never let the loop
  // advance). Matched by test+subtest, and for the scope-check also by the
  // flagged file (output) so a NEW out-of-scope file after a concede is still
  // caught. Absent = nothing recorded (the gate behaves as before).
  resolvedFailures?: FailingTest[];
}

export interface GateResult {
  compile: boolean;
  compileError: string;
  allPassed: boolean;   // THE verdict: test process exited 0 (spec: bug-gate-signal-integrity)
  coverage: number;
  failures: FailingTest[]; // display-only
  newTestFiles?: number;   // Phase A: count of new/modified test files (ruleset-role-compliance R3)
}

// --- Golden project workspace (spec: golden-workspace-fix.md) ---

/**
 * Detects whether the loop is working on a golden project or a self-refactor.
 * Golden project specs are under test/golden/. Self-refactor specs are under
 * internal/ (no test/golden/ prefix).
 */
// --- Workspace path helpers + state summary (src/types.ts split, step 5) ---
// Implementation moved to src/workspace.ts and src/state-summary.ts;
// re-exported here so existing importers ("from "./types"") are unchanged.
export { isGoldenProject, getWorkspaceRoot, isWorkspacePath } from "./workspace";
export { stateSummary } from "./state-summary";

// --- Phase 0: Spec Review Types ---

export type FindingCategory =
  | "Ambiguous phrase"
  | "Edge case missing"
  | "Underspecified behavior"
  | "Example-prose conflict"
  | "Type contract gap"
  | "Missing section";

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
  severity?: "blocker" | "warning";
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

// --- Command context (shared by all command handlers) ---

export interface CommandContext {
  ui: {
    notify: (message: string, level?: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  sessionManager: {
    getEntries: () => unknown[];
  };
  cwd: string;
}

// --- Debug helpers ---

// (stateSummary moved to src/state-summary.ts; re-exported above.)

// --- State checkpointing (fix: phase0-live-transcript-leaks) ---

export interface StateCheckpointManagerInit {
  // A factory function that creates and initializes the checkpoint manager.
  // It should create the snapshot directory, load any existing snapshots,
  // and return a snapshot of the current state.
  init: (checkpointManager: import("./state/checkpoint").StateCheckpointManager) => void;
}
