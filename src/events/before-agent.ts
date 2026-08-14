// --- before_agent_start handler ---
// Role-specific prompt injection.

import type { LoopState } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// --- Public API ---

export function handleBeforeAgent(
  input: BeforeAgentHandlerInput,
): BeforeAgentHandlerOutput | undefined {
  const { state, pi, debug, systemPrompt } = input;
  void pi;
  void debug;
  void systemPrompt;

  if (state.current.phase === "idle") return undefined;
  // Phase handler: review, A, negotiate, B, C
  // Returns prompt injection per phase
  return undefined;
}
