// Flat-state validator — internal/refactor-state-model-divergence.md
//
// One state model: the flat LoopState (src/types.ts). validateLoopState is the
// single live validator; it runs at the two points that matter:
//   1. commit (src/commit.ts) — validate before persist; on failure debug +
//      still persist (quirk Q1).
//   2. restore (src/events/session-start.ts) — validate the restored entry;
//      on failure quarantine.
// Returns false, never throws.

import type { LoopState, Phase, LanguageKey, BuildTool } from "./types";

export const PHASES: readonly Phase[] = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"];

const LANGUAGES: readonly LanguageKey[] = ["go", "java", "typescript"];
const BUILD_TOOLS: readonly BuildTool[] = ["maven", "gradle", "go"];

// lastPhase values from which escalated / done are reachable (live machine:
// escalateTo from A/negotiate/B/C; markDone from B/C; the origin check is
// pinned wider than strictly reachable — a stale done is quarantined, not
// healed).
const ORIGIN_GATED_ORIGINS: readonly Phase[] = ["A", "negotiate", "B", "C"];
// turnsThisPhase >= 1 only in these phases (idle and escalated exempt).
const TURNED_PHASES: readonly Phase[] = ["review", "A", "negotiate", "B", "C"];

// --- Shape contract (flat LoopState) ---

interface FieldSpec {
  type: "number" | "boolean" | "string";
  optional?: boolean;
}

const FIELD_SPECS: Record<string, FieldSpec> = {
  round: { type: "number" },
  turnsThisPhase: { type: "number" },
  maxA: { type: "number" },
  maxNegotiate: { type: "number" },
  maxB: { type: "number" },
  maxC: { type: "number" },
  maxDispute: { type: "number" },
  maxTurnsPerPhase: { type: "number" },
  coverageThreshold: { type: "number" },
  disputeCount: { type: "number" },
  disputeMode: { type: "boolean" },
  justTransitioned: { type: "boolean" },
  negotiateReprompted: { type: "boolean" },
  awaitDisputeFix: { type: "boolean" },
  awaitDisputeReview: { type: "boolean" },
  negotiateProposed: { type: "boolean", optional: true },
  negotiateFeedback: { type: "string", optional: true },
  specPath: { type: "string" },
  lastProposal: { type: "string" },
};

function isPlainObject(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

function inList(list: readonly string[], value: unknown): value is string {
  return typeof value === "string" && list.includes(value);
}

function checkEnum(
  errors: string[],
  label: string,
  value: unknown,
  list: readonly string[],
): void {
  if (!inList(list, value)) {
    errors.push(`invalid ${label}: ${String(value)}`);
  }
}

function checkField(
  errors: string[],
  data: Record<string, unknown>,
  field: string,
  spec: FieldSpec,
): void {
  const value = data[field];
  if (value === undefined) {
    if (!spec.optional) errors.push(`missing field: ${field}`);
    return;
  }
  if (typeof value !== spec.type) {
    errors.push(`field ${field} must be ${spec.type}`);
  }
}

/**
 * Collect all validation failures for a candidate LoopState.
 * Exposed for the commit debug line (`commit: state failed validation — ${errors}`).
 * Empty array means valid.
 */
export function validationErrors(data: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(data)) {
    return ["not an object"];
  }

  // --- Shape check ---
  checkEnum(errors, "phase", data.phase, PHASES as readonly string[]);
  checkEnum(errors, "language", data.language, LANGUAGES as readonly string[]);
  checkEnum(errors, "buildTool", data.buildTool, BUILD_TOOLS as readonly string[]);
  checkEnum(errors, "lastPhase", data.lastPhase, PHASES as readonly string[]);
  for (const [field, spec] of Object.entries(FIELD_SPECS)) {
    checkField(errors, data, field, spec);
  }

  // --- Invariant check (the live machine's actual invariants) ---
  const phase = data.phase as Phase;
  const round = typeof data.round === "number" ? data.round : NaN;
  const turns = typeof data.turnsThisPhase === "number" ? data.turnsThisPhase : NaN;
  const disputeCount = typeof data.disputeCount === "number" ? data.disputeCount : NaN;
  const maxDispute = typeof data.maxDispute === "number" ? data.maxDispute : NaN;

  // done is the terminal phase: row 1 of the decision table pins NO
  // constraint on round in done, and the turned-phase turns floor does not
  // apply to it (a post-done zeroing of its counters is a live-reachable
  // shape). Every other phase keeps the floors below. lastPhase has no
  // constraint beyond its type (Q2) except for the origin-gated phases.
  const isDone = phase === "done";
  const isOriginGated = phase === "escalated" || isDone;
  if (isOriginGated && !inList(ORIGIN_GATED_ORIGINS as readonly string[], data.lastPhase)) {
    errors.push(`${phase} must come from A, negotiate, B or C (got ${String(data.lastPhase)})`);
  }
  if (phase !== "idle" && !isDone && typeof data.round === "number" && data.round < 1) {
    errors.push(`round must be >= 1 in non-idle phases (got ${round})`);
  }
  checkTurnsFloor(errors, phase, isDone, data.turnsThisPhase, turns);
  if (!(Number.isNaN(disputeCount) || Number.isNaN(maxDispute)) && disputeCount > maxDispute) {
    errors.push(`disputeCount must be <= maxDispute (got ${disputeCount} > ${maxDispute})`);
  }

  // Optional nested field: lastGateResult must be an object when present.
  const gate = data.lastGateResult;
  if (gate !== undefined && gate !== null && typeof gate !== "object") {
    errors.push("field lastGateResult must be an object");
  }

  return errors;
}

// turnsThisPhase floors: >= 0 everywhere; >= 1 in the active phases
// (TURNED_PHASES) — done is exempt (see the comment above validationErrors).
function checkTurnsFloor(
  errors: string[],
  phase: Phase,
  isDone: boolean,
  turns: unknown,
  turnsValue: number,
): void {
  if (typeof turns !== "number") return;
  if (turns < 0) {
    errors.push(`turnsThisPhase must be >= 0 (got ${String(turns)})`);
    return;
  }
  if (!isDone && (TURNED_PHASES as readonly string[]).includes(phase) && turns < 1) {
    errors.push(`turnsThisPhase must be >= 1 in phase ${phase} (got ${turnsValue})`);
  }
}

/**
 * Type guard: true iff `data` is a valid flat LoopState (shape + invariants).
 * Returns false, never throws.
 */
export function validateLoopState(data: unknown): data is LoopState {
  return validationErrors(data).length === 0;
}
