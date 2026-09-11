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
  negotiateReprompted: boolean;
  lastGateResult?: GateResult;
  // Negotiate round (spec 07): set by tools, consumed + cleared by the settle
  // handler; undefined and "" both mean "no feedback pending".
  negotiateProposed?: boolean;
  negotiateFeedback?: string;
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
  allPassed: boolean;   // THE verdict: test process exited 0 (spec: bug-gate-signal-integrity)
  coverage: number;
  failures: FailingTest[]; // display-only
}

// --- Golden project workspace (spec: golden-workspace-fix.md) ---

/**
 * Detects whether the loop is working on a golden project or a self-refactor.
 * Golden project specs are under test/golden/. Self-refactor specs are under
 * internal/ (no test/golden/ prefix).
 */
export function isGoldenProject(specPath: string): boolean {
  return specPath.startsWith("test/golden/");
}

/**
 * For golden projects: returns the project directory (parent of spec.md).
 * For self-refactors: returns "." (cwd, no constraint).
 */
export function getWorkspaceRoot(specPath: string): string {
  if (!isGoldenProject(specPath)) return ".";
  const parts = specPath.split("/");
  parts.pop(); // remove "spec.md"
  return parts.join("/");
}

/**
 * Returns true when `path` is within `workspaceRoot`.
 * A path is within the workspace if it starts with the workspace root
 * (as a directory prefix). The workspace root itself is not a valid
 * write target (you write files *under* it).
 */
export function isWorkspacePath(path: string, workspaceRoot: string): boolean {
  if (workspaceRoot === ".") return true; // self-refactor: no constraint
  const normalized = path.startsWith("/") ? path : "/" + path;
  const root = workspaceRoot.startsWith("/") ? workspaceRoot : "/" + workspaceRoot;
  return normalized.startsWith(root + "/");
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
