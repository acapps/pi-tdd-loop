// --- agent_settled dispatcher ---
// Routes to phase-specific handler based on current state.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";

// --- Types ---

export interface AgentSettledDispatcherInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  ctx: EventCtx;
}

export interface AgentSettledDispatcher {
  (input: AgentSettledDispatcherInput): boolean | undefined;
}

// --- Public API ---

export function handleAgentSettled(
  input: AgentSettledDispatcherInput,
): boolean | undefined {
  const { state, pi, debug, ctx } = input;
  void state;
  void pi;
  void debug;
  void ctx;
  return undefined;
}
