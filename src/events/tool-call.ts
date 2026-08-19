// --- tool_call handler ---
// Path enforcement: block writes to disallowed paths per phase.
//
// Decision table (internal/02-implement-tool-call-handler.md), evaluated in
// order, first match wins. Mirrors the former eventToolCall in src/events/index.ts
// verbatim, including the F1-F5 review fixes:
//   F1: rule 6's !disputeMode exclusion (dispute-fix turn may write test files)
//   F2: rule 2 is debug-only — it emits no loop-refusal entry
//   F3: missing path (undefined/null) never throws; only rules 2 and 4 can block

import type { LoopState } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DebugFn, EventCtx } from "./index";
import { getLanguageConfig, type LanguageConfig } from "../languages";

// --- Types ---

export interface ToolCallHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  toolName: string;
  path?: string; // F3: extraction yields undefined/null for pathless tools (e.g. bash); never throws
  ctx: EventCtx;
}

export interface ToolCallBlockResult {
  block: true;
  reason: string;
}

export interface ToolCallHandler {
  (input: ToolCallHandlerInput): ToolCallBlockResult | undefined;
}

// Resolved input shared by the per-rule checks below. `path` is nullable at
// runtime (F3): extraction yields undefined, and null arrives from raw events.
interface EnforcementInput {
  state: LoopState;
  lang: LanguageConfig;
  pi: ExtensionAPI;
  debug: DebugFn;
  toolName: string;
  path: string | null | undefined;
  cwd: string;
}

// Rule 2's full verbatim reason string (F4 — not truncated).
const DISPUTE_REVIEW_REASON =
  "Dispute filed. Waiting for dispute review. STOP producing tool calls.";

// --- Shared predicates ---

function isWriteAction(toolName: string): boolean {
  return toolName === "write" || toolName === "edit";
}

function isProjectPath(path: string | null | undefined, cwd: string): boolean {
  if (path == null) return false; // F3: missing path — the monolith threw a TypeError here
  const full = path.startsWith("/") ? path : cwd + "/" + path;
  return full.startsWith(cwd + "/");
}

// --- Rule checks (each returns a block decision, or undefined to continue) ---

// Rule 2 — awaiting dispute review: block every tool call.
// F2: debug only — no loop-refusal entry.
function blockDisputeReview(input: EnforcementInput): ToolCallBlockResult | undefined {
  const { state, debug, toolName } = input;
  if (!state.awaitDisputeReview) return undefined;
  debug(`Blocked: ${toolName} (awaiting dispute review)`);
  return { block: true, reason: DISPUTE_REVIEW_REASON };
}

// Rule 3 — dispute mode: block non-test paths (any tool, any phase).
// The entry hardcodes tool "write" (monolith behavior), even for edit.
function blockDisputeWrite(input: EnforcementInput): ToolCallBlockResult | undefined {
  const { state, lang, pi, debug, path } = input;
  if (!state.disputeMode || !path || lang.isTestFile(path)) return undefined;
  debug(`Blocked: ${path} (dispute mode, not test file)`);
  pi.appendEntry("loop-refusal", { phase: "B-dispute", path, tool: "write" });
  return { block: true, reason: lang.refusalMessage.phaseC };
}

// Rule 4 — negotiate: discussion only, block write actions (path-independent).
function blockNegotiateWrite(input: EnforcementInput): ToolCallBlockResult | undefined {
  const { state, lang, pi, debug, toolName } = input;
  if (state.phase !== "negotiate" || !isWriteAction(toolName)) return undefined;
  debug(`Blocked: ${toolName} (negotiate phase, discussion only)`);
  pi.appendEntry("loop-refusal", { phase: "negotiate", tool: toolName });
  return { block: true, reason: lang.refusalMessage.negotiate };
}

// Rule 5 — phase A: test files and stubs only.
// "" is a project path matching no allowlist pattern, so it is blocked.
function blockPhaseAWrite(input: EnforcementInput): ToolCallBlockResult | undefined {
  const { state, lang, pi, debug, toolName, path, cwd } = input;
  if (state.phase !== "A" || !isWriteAction(toolName)) return undefined;
  if (!isProjectPath(path, cwd) || path == null || lang.isPhaseAAllowed(path)) return undefined;
  debug(`Blocked: ${toolName} ${path} (phase A, not allowed)`);
  pi.appendEntry("loop-refusal", { phase: "A", path, tool: toolName });
  return { block: true, reason: lang.refusalMessage.phaseA };
}

// Rule 6 — phases B/C: no test-file modifications.
// F1: skipped during the dispute-fix turn (disputeMode) so the Tester can fix
// *_test.go; rule 3 still blocks non-test writes in that turn.
function blockPhaseBCWrite(input: EnforcementInput): ToolCallBlockResult | undefined {
  const { state, lang, pi, debug, toolName, path, cwd } = input;
  const inPhaseBC = state.phase === "B" || state.phase === "C";
  if (!inPhaseBC || state.disputeMode || !isWriteAction(toolName)) return undefined;
  if (!isProjectPath(path, cwd) || path == null || !lang.isTestFile(path)) return undefined;
  debug(`Blocked: ${toolName} ${path} (phase ${state.phase}, is test file)`);
  pi.appendEntry("loop-refusal", { phase: state.phase, path, tool: toolName });
  return { block: true, reason: lang.refusalMessage.phaseC };
}

// --- Public API ---

export function handleToolCall(
  input: ToolCallHandlerInput,
): ToolCallBlockResult | undefined {
  const current = input.state.current;

  // Rule 1: escalated — relaxed enforcement, allow everything.
  if (current.phase === "escalated") return undefined;

  const ctx: EnforcementInput = {
    state: current,
    lang: getLanguageConfig(current.language),
    pi: input.pi,
    debug: input.debug,
    toolName: input.toolName,
    path: input.path,
    cwd: input.ctx.cwd,
  };

  // Rules 2-6 in evaluation order; first match wins. Rule 7: otherwise allow.
  return (
    blockDisputeReview(ctx) ??
    blockDisputeWrite(ctx) ??
    blockNegotiateWrite(ctx) ??
    blockPhaseAWrite(ctx) ??
    blockPhaseBCWrite(ctx)
  );
}
