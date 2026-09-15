// Stub — the Writer replaces this with the real Phase 0 handlers
// (internal/refactor-tools-split.md): executePhase0Approve,
// executePhase0Feedback, executeReject.

import type { StateRef, ToolCtx, Debug, ToolResult } from "./types";

export function executePhase0Approve(
  state: StateRef,
  pi: unknown,
  ctx: ToolCtx,
  debug: Debug,
): ToolResult {
  void state;
  void pi;
  void ctx;
  void debug;
  throw new Error("not implemented");
}

export function executePhase0Feedback(
  state: StateRef,
  pi: unknown,
  ctx: ToolCtx,
  debug: Debug,
  plan: string,
): ToolResult {
  void state;
  void pi;
  void ctx;
  void debug;
  void plan;
  throw new Error("not implemented");
}

export function executeReject(
  state: StateRef,
  pi: unknown,
  debug: Debug,
  toolName: string,
  text: string,
): ToolResult {
  void state;
  void pi;
  void debug;
  void toolName;
  void text;
  throw new Error("not implemented");
}
