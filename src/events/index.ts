// --- Events registration surface ---
// The single registration surface for the extension: the four `event*`
// factories registered via pi.on(...), the sole EventCtx definition, the
// exported DebugFn type, and the phase-handler type re-exports. The entry
// point imports only from this module.

import type { LoopState } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleSessionStart } from "./session-start";
import { handleBeforeAgent } from "./before-agent";
import { handleToolCall } from "./tool-call";
import { handleAgentSettled } from "./agent-settled";

// --- Shared context type ---

export interface EventCtx {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  sessionManager: {
    getEntries: () => unknown[];
  };
  cwd: string;
}

// --- Debug type ---

export type DebugFn = (msg: string) => void;

// --- Registration factories ---

// --- session_start ---

export function eventSessionStart(
  state: { current: LoopState },
  _pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (_event: unknown, ctx: EventCtx) => {
    handleSessionStart({ state, ctx, debug });
  };
}

// --- before_agent_start ---

export function eventBeforeAgentStart(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (event: unknown) => {
    // F5: raw-event extraction stays in the delegator; prompt building (incl.
    // the idle short-circuit) lives in handleBeforeAgent (src/events/before-agent.ts).
    const evt = event as { systemPrompt: string };
    return handleBeforeAgent({ state, pi, debug, systemPrompt: evt.systemPrompt });
  };
}

// --- tool_call (path enforcement) ---

export function eventToolCall(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (event: unknown, ctx: EventCtx) => {
    // F5: raw-event extraction stays in the delegator; path enforcement
    // lives in handleToolCall (src/events/tool-call.ts). `path` may be
    // undefined for pathless tools (e.g. bash) — the handler never throws.
    const evt = event as { toolName: string; input?: Record<string, string> };
    return handleToolCall({ state, pi, debug, toolName: evt.toolName, path: evt.input?.path, ctx });
  };
}

// --- agent_settled (phase transitions) ---

export function eventAgentSettled(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (_event: unknown, ctx: EventCtx) => {
    return handleAgentSettled({ state, pi, debug, ctx });
  };
}

// --- Type re-exports ---

export type { SessionStartHandler } from "./session-start";
export type { BeforeAgentHandler } from "./before-agent";
export type { ToolCallHandler } from "./tool-call";
export type { AgentSettledDispatcher } from "./agent-settled/index";
export type { GateHandlerInput, GateHandlerOutput } from "./agent-settled/gate-transition";
export type { EffectInput, EffectResult } from "./agent-settled/effect-applicator";
export type { ReviewHandlerInput, ReviewHandlerOutput } from "./agent-settled/review";
export type { NegotiateHandlerInput, NegotiateHandlerOutput } from "./agent-settled/negotiate";
export type { DisputeHandlerInput, DisputeHandlerOutput } from "./agent-settled/dispute";
