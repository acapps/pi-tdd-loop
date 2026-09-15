// Stub — the Writer replaces this with the real shared types + result builders.
// Expected contents (internal/refactor-tools-split.md): StateRef, ToolCtx,
// ToolResult, Debug, buildProposeResult, buildReviewResult,
// isNegotiatePhase, isPhaseB, isApproval.

export type Debug = (msg: string) => void;

export interface ToolCtx {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  mode: string;
  hasUI: boolean;
}

export interface ToolResult {
  content: { text: string }[];
}

export interface StateRef {
  current: import("../types").LoopState;
}

export function buildProposeResult(): ToolResult {
  throw new Error("not implemented");
}

export function buildReviewResult(phase: string, action: string): ToolResult {
  void phase;
  void action;
  throw new Error("not implemented");
}

export function isNegotiatePhase(phase: string): boolean {
  void phase;
  throw new Error("not implemented");
}

export function isPhaseB(phase: string): boolean {
  void phase;
  throw new Error("not implemented");
}

export function isApproval(decision: string): boolean {
  void decision;
  throw new Error("not implemented");
}
