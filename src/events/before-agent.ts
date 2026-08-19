// --- before_agent_start handler ---
// Role-specific prompt injection.
//
// Scope convention (spec R1): the entry receives the wrapper
// `{ state: { current }, ... }` and unwraps to the bare `LoopState` before
// dispatch. All helpers take the bare `LoopState` — in helper scope,
// `state.round` / `state.awaitDisputeFix` refer to the current round/flag.
// The wrapper exists only at the entry boundary.

import type { LoopState } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugFn } from "./index";
import { getLanguageConfig } from "../languages";

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

  // Entry order (S1, pinned): 1) idle short-circuit BEFORE any lang
  // resolution — idle + corrupted language returns undefined without
  // throwing; 2) lang resolution — may throw on corrupted state for every
  // other phase (terminal phases included); 3) phase dispatch.
  if (s.phase === "idle") return undefined;
  const lang = getLanguageConfig(s.language);
  return buildPhasePrompt(s, pi, lang, debug, systemPrompt);
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
      `TESTER. Write contract: ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs.\nStop when done.`,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase A (Tester). Write ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs.`,
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
  if (state.awaitDisputeFix) {
    return buildDisputeFixPrompt(state, pi, debug, systemPrompt);
  }
  debug(`Writer round ${state.round}`);
  return {
    message: buildContextMessage(
      `WRITER. Write ${lang.sourceFilePattern} to pass ${lang.testFilePattern}.\n` +
      `Preserve stub signatures. Dispute wrong tests via negotiate_propose.\n` +
      "When done, stop producing tool calls.",
    ),
    systemPrompt: `${systemPrompt}\n\nPhase B (Writer), round ${state.round}. Write ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.`,
  };
}

function buildDisputeFixPrompt(
  state: LoopState,
  pi: ExtensionAPI,
  debug: DebugFn,
  systemPrompt: string,
): BeforeAgentHandlerOutput {
  // Exact order (R3): debug → clear flag → persist snapshot AFTER the clear.
  // A session reload mid-dispute-fix must see the cleared flag.
  debug("Tester fixing test");
  state.awaitDisputeFix = false;
  pi.appendEntry("loop-state", { ...state });
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
  return {
    message: buildContextMessage(
      "CLEANER. Refactor for readability:\n" +
      "- Return early. Extract helpers. Clear names.\n" +
      `You may only write ${lang.sourceFilePattern}. Do not modify ${lang.testFilePattern}. All tests must pass.`,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase C (Cleaner), round ${state.round}. Refactor ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.`,
  };
}
