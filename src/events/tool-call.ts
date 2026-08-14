// --- tool_call handler ---
// Path enforcement: block writes to disallowed paths per phase.

import type { LoopState } from "../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "./index";

// --- Types ---

export interface ToolCallHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  toolName: string;
  path: string;
  ctx: EventCtx;
}

export interface ToolCallBlockResult {
  block: true;
  reason: string;
}

export interface ToolCallHandler {
  (input: ToolCallHandlerInput): ToolCallBlockResult | undefined;
}

// --- Public API ---

export function handleToolCall(
  input: ToolCallHandlerInput,
): ToolCallBlockResult | undefined {
  const { state, pi, debug, toolName, path, ctx } = input;
  void state;
  void pi;
  void debug;
  void toolName;
  void path;
  void ctx;
  return undefined;
}
