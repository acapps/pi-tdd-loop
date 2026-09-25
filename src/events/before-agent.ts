// --- before_agent_start handler ---
// Role-specific prompt injection.
//
// Scope convention (spec R1): the entry receives the wrapper
// `{ state: { current }, ... }` and unwraps to the bare `LoopState` before
// dispatch. All helpers take the bare `LoopState` — in helper scope,
// `state.round` / `state.dispute` refer to the current round/dispute status.
// The wrapper exists only at the entry boundary.
//
// Resume path (fix-session-restart): a reload mid-phase (saved
// `justTransitioned === true`) gets a short resume prompt instead of the
// full phase-entry prompt — the work is already on disk. The flag survives
// restore (session-start no longer zeros it) and is consumed at the next
// settle (agent-settled/index.ts).

import type { LoopState } from "../types";
import { getWorkspaceRoot } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugFn } from "./index";
import { getLanguageConfig } from "../languages";
import { commit } from "../commit";

// --- Types ---

export interface BeforeAgentHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  systemPrompt: string;
}

export interface BeforeAgentHandlerOutput {
  message: Record<string, unknown>;
  systemPrompt: string;
}

export interface BeforeAgentHandler {
  (input: BeforeAgentHandlerInput): BeforeAgentHandlerOutput | undefined;
}

type LangConfig = ReturnType<typeof getLanguageConfig>;

// --- Public API ---

export function handleBeforeAgent(
  input: BeforeAgentHandlerInput,
): BeforeAgentHandlerOutput | undefined {
  const { state, pi, debug, systemPrompt } = input;
  const s = state.current;

  // Entry order (pinned): 1) idle short-circuit BEFORE anything else —
  // idle + corrupted language returns undefined without throwing, and
  // idle never inspects justTransitioned; 2) resume branch —
  // `justTransitioned === true` (any non-idle phase) returns the resume
  // prompt BEFORE lang resolution, so a corrupted language does not throw
  // on a mid-phase reload (the resume branch never touches lang);
  // 3) lang resolution — may throw on corrupted state for every other
  // non-idle phase (terminal phases included); 4) phase dispatch.
  if (s.phase === "idle") return undefined;
  if (s.justTransitioned === true) return buildResumePrompt(s, debug, systemPrompt);
  const lang = getLanguageConfig(s.language);
  return buildPhasePrompt(s, pi, lang, debug, systemPrompt);
}

// --- Resume prompt (fix-session-restart) ---
// Language-agnostic: no lang config, no file-pattern interpolation. Built
// by buildContextMessage (same envelope as every other prompt). No side
// effects — no commit, no state mutation, no ctx.ui; the settle handler's
// existing clear+commit is the single consumption point.

// Verbatim role lines (spec: internal/fix-session-restart.md). The resume
// branch is only reached for the 5 non-idle, non-terminal phases (idle
// short-circuits; done/escalated save with justTransitioned false), so the
// default is unreachable — it exists to satisfy exhaustiveness.
const RESUME_ROLE_LINES: Record<LoopState["phase"], string> = {
  review: "Role: Reviewer (Phase 0). Use negotiate_propose or negotiate_review.",
  A: "Role: Tester. Continue writing the contract tests.",
  negotiate: "Role: Negotiator. Use negotiate_propose / negotiate_review.",
  B: "Role: Writer. Continue implementing to pass the tests.",
  C: "Role: Cleaner. Continue refactoring. All tests must pass.",
  done: "",
  escalated: "",
  idle: "",
};

function buildResumePrompt(
  state: LoopState,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  debug(`before_agent_start: resume prompt (Phase ${state.phase} round ${state.round})`);
  return {
    message: buildContextMessage(resumeContent(state)),
    systemPrompt: `${systemPrompt}\n\nSession reloaded mid-phase. Continue the current phase — do not restart it.`,
  };
}

function resumeContent(state: LoopState): string {
  return (
    `RELOAD. You are mid-phase: Phase ${state.phase}, round ${state.round}.\n` +
    "Your previous turn's work is already on disk — continue from where you stopped.\n" +
    "Do not re-read the spec, re-derive the contract, or rewrite files from scratch.\n" +
    `${RESUME_ROLE_LINES[state.phase]}\n` +
    "Stop when done."
  );
}

// --- Dispatch ---

function buildPhasePrompt(
  state: LoopState,
  pi: ExtensionAPI,
  lang: LangConfig,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput | undefined {
  switch (state.phase) {
    case "review":
      return buildReviewPrompt(systemPrompt);
    case "A":
      return buildTesterPrompt(lang, systemPrompt);
    case "negotiate":
      return buildNegotiatePrompt(state, debug, systemPrompt);
    case "B":
      return buildWriterPrompt(state, pi, lang, debug, systemPrompt);
    case "C":
      return buildCleanerPrompt(lang, state, systemPrompt);
    // Terminal phases inject nothing (F3: explicit rows, not fall-through).
    case "done":
    case "escalated":
      return undefined;
    // R5: defensive default — session state restored from JSONL is unvalidated.
    default:
      return undefined;
  }
}

// --- Prompt builders (bare-LoopState scope; strings are behavior — verbatim) ---

function buildContextMessage(content: string): Record<string, unknown> {
  return { customType: "loop-context", content, display: false };
}

function buildReviewPrompt(systemPrompt: string): BeforeAgentHandlerOutput {
  return {
    message: buildContextMessage(
      `REVIEWER (Phase 0). Review the spec for ambiguities and missing edge cases.\n` +
      `Use negotiate_propose with plan='approve' to proceed, or provide feedback.\n` +
      `No file writes.`,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase 0 (Reviewer). Review the spec. Use negotiate_propose. No file writes.`,
  };
}

function buildTesterPrompt(
  lang: LangConfig,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  return {
    message: buildContextMessage(
      `TESTER. Write contract: ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs.\n` +
        `Tests must be fast and hermetic: no real process spawning (no go/mvn/npx/tsc via exec* or spawn), no npx, no temp-dir project scaffolding — mock the process boundary (vi.mock("node:child_process")) and assert on exit-code/output interpretation. Real toolchain runs belong in test/e2e/ only.\n` +
        `Stop when done.`,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase A (Tester). Write ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs. Tests must not spawn real processes or use npx — mock node:child_process and keep the default suite in seconds.`,
  };
}

function buildNegotiatePrompt(
  state: LoopState,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  if (state.round % 2 === 1) return buildNegotiateWriterPrompt(state, debug, systemPrompt);
  return buildNegotiateTesterPrompt(state, debug, systemPrompt);
}

function buildNegotiateWriterPrompt(
  state: LoopState,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  debug(`Negotiate round ${state.round} (Writer)`);
  return {
    message: buildContextMessage(
      `WRITER (negotiate). Use negotiate_propose. No file writes.\nplan='agree' if tests match spec. plan='your approach' otherwise.`,
    ),
    systemPrompt: `${systemPrompt}\n\nNegotiation. Use negotiate_propose tool. No file writes.`,
  };
}

function buildNegotiateTesterPrompt(
  state: LoopState,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  debug(`Negotiate round ${state.round} (Tester)`);
  return {
    message: buildContextMessage(
      `TESTER (negotiate). Use negotiate_review. No file writes.\n'approve' if accept. feedback otherwise.`,
    ),
    systemPrompt: `${systemPrompt}\n\nNegotiation. Use negotiate_review tool. No file writes.`,
  };
}

function buildWriterPrompt(
  state: LoopState,
  pi: ExtensionAPI,
  lang: LangConfig,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  if (state.dispute?.status === "conceded" && state.dispute?.filer === "writer") {
    return buildDisputeFixPrompt(state, pi, debug, systemPrompt);
  }
  if (state.dispute?.status === "in-review" && state.dispute?.filer === "writer") {
    return buildDisputeReviewPrompt(lang, systemPrompt);
  }
  if (state.dispute?.status === "conceded" && state.dispute?.filer === "tester") {
    return buildWriterConcedeFixPrompt(lang, systemPrompt);
  }
  debug(`Writer round ${state.round}`);
  return buildWriterNormalPrompt(lang, state, systemPrompt);
}

// Normal Phase B turn (no active dispute sub-flow): the Writer implements.
// Strings are verbatim behavior — owned by the Phase B test suite.
function buildWriterNormalPrompt(
  lang: LangConfig,
  state: LoopState,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  return {
    message: buildContextMessage(
      `WRITER. Write ${lang.sourceFilePattern} to pass ${lang.testFilePattern}.\n` +
      `Preserve stub signatures. If a test is wrong or unpassable by construction, stop and call negotiate_propose with the dispute — do not keep editing source to satisfy it.\n` +
      "When done, stop producing tool calls.",
    ),
    systemPrompt: `${systemPrompt}\n\nPhase B (Writer), round ${state.round}. Write ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.`,
  };
}

// Spec: internal/bug-role-context-mismatch.md — the Tester's dispute-review
// turn (Writer filed, Tester reviews). Pure read: no commit, no status
// mutation — the status is advanced by the settle handler, not here.
function buildDisputeReviewPrompt(
  lang: LangConfig,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  return {
    message: buildContextMessage(
      "TESTER (dispute review). The Writer disputed a test. Review the claim against the spec and the code.\n" +
      "Use negotiate_review: decision='approve' to concede (you will fix the test), or a rebuttal to defend it.\n" +
      "Do not write files.",
    ),
    systemPrompt: `${systemPrompt}\n\nPhase B (dispute review, Tester). Review the Writer's dispute. Use negotiate_review. Do not write files.`,
  };
}

// Spec: internal/bug-role-context-mismatch.md — the Writer's concede-fix
// turn (Tester filed, Writer conceded, fixes the flagged files). Pure read,
// same contract as buildDisputeReviewPrompt.
function buildWriterConcedeFixPrompt(
  lang: LangConfig,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  return {
    message: buildContextMessage(
      `WRITER (dispute fix). You accepted the Tester's report. Fix the flagged ${lang.sourceFilePattern} to resolve it.\n` +
      "Write source files only. When done, stop producing tool calls.",
    ),
    systemPrompt: `${systemPrompt}\n\nPhase B (dispute fix, Writer). You may write ${lang.sourceFilePattern}. Do not modify ${lang.testFilePattern}.`,
  };
}

function buildDisputeFixPrompt(
  state: LoopState,
  pi: ExtensionAPI,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  // Exact order (R3): debug → clear status → persist snapshot AFTER the
  // clear. A session reload mid-dispute-fix must see the closed status.
  debug("Tester fixing test");
  state.dispute = { ...state.dispute, status: "closed" };
  commit(state, pi, debug);
  return {
    message: buildContextMessage(
      "You are the TESTER (dispute fix). You conceded that the Writer's dispute was valid.\n" +
      "Fix the test(s) to match the spec.\n" +
      "After fixing, stop producing tool calls.",
    ),
    systemPrompt: `${systemPrompt}\n\nYou are in Phase B dispute fix (Tester). You may write test files.`,
  };
}

function buildCleanerPrompt(
  lang: LangConfig,
  state: LoopState,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  // fix-just-transitioned-settle-drop S3+TS6: the normal Phase C entry prompt
  // is the language config's promptCleanerPhaseC (the same prompt the settle
  // advance effect delivers) — before_agent_start must not re-derive a
  // shorter variant, or the entry prompt diverges across the two delivery
  // points. Round stays in the systemPrompt only.
  const ws = getWorkspaceRoot(state.specPath);
  const prompt = lang.prompts.promptCleanerPhaseC(ws);
  return {
    message: buildContextMessage(
      `CLEANER. Refactor for readability:\n` +
      "- Return early. Extract helpers. Clear names.\n" +
      `You may only write ${lang.sourceFilePattern}. Do not modify ${lang.testFilePattern}. All tests must pass.\n\n` +
      prompt,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase C (Cleaner), round ${state.round}. Refactor ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.`,
  };
}
