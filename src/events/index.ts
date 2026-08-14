// --- Events module index ---
// Re-exports and shared types for the events architecture.

import type { LoopState } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// --- Re-export phase handlers (implemented in separate modules) ---

export type { SessionStartHandler } from "./session-start";
export type { BeforeAgentHandler } from "./before-agent";
export type { ToolCallHandler } from "./tool-call";
export type { AgentSettledDispatcher } from "./agent-settled/index";

// --- Re-export agent-settled sub-module types ---

export type { GateHandlerInput, GateHandlerOutput } from "./agent-settled/gate-transition";
export type { EffectInput, EffectResult } from "./agent-settled/effect-applicator";
export type { ReviewHandlerInput, ReviewHandlerOutput } from "./agent-settled/review";
export type { NegotiateHandlerInput, NegotiateHandlerOutput } from "./agent-settled/negotiate";
export type { DisputeHandlerInput, DisputeHandlerOutput } from "./agent-settled/dispute";
