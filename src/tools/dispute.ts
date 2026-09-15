// Stub — the Writer replaces this with the real dispute handlers
// (internal/refactor-tools-split.md): handleBDisputePropose,
// handleBDisputeReview, executeWriterConcedeDispute, isConcession,
// logDisputeEntry, logDisputeConcession.

import type { StateRef, ToolCtx, Debug, ToolResult } from "./types";

export function isConcession(plan: string): boolean {
  void plan;
  throw new Error("not implemented");
}

export function handleBDisputePropose(
  state: StateRef,
  pi: unknown,
  debug: Debug,
  ctx: ToolCtx,
  plan: string,
): ToolResult {
  void state;
  void pi;
  void debug;
  void ctx;
  void plan;
  throw new Error("not implemented");
}

export function handleBDisputeReview(
  state: StateRef,
  pi: unknown,
  debug: Debug,
  ctx: ToolCtx,
  decision: string,
): ToolResult {
  void state;
  void pi;
  void debug;
  void ctx;
  void decision;
  throw new Error("not implemented");
}

export function executeWriterConcedeDispute(
  state: StateRef,
  pi: unknown,
  debug: Debug,
): ToolResult {
  void state;
  void pi;
  void debug;
  throw new Error("not implemented");
}
