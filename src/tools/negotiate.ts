// Stub — the Writer replaces this with the real tool definitions +
// negotiate-phase handlers (internal/refactor-tools-split.md).

import type { StateRef, ToolCtx, Debug } from "./types";

export function negotiatePropose(
  state: StateRef,
  pi: unknown,
  debug: Debug,
): {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    callId: string,
    args: { plan: string },
    meta: unknown,
    ctx: unknown,
    toolCtx: ToolCtx,
  ) => Promise<{ content: { text: string }[] }>;
} {
  void state;
  void pi;
  void debug;
  throw new Error("not implemented");
}

export function negotiateReview(
  state: StateRef,
  pi: unknown,
  debug: Debug,
): {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    callId: string,
    args: { decision: string },
    meta: unknown,
    ctx: unknown,
    toolCtx: ToolCtx,
  ) => Promise<{ content: { text: string }[] }>;
} {
  void state;
  void pi;
  void debug;
  throw new Error("not implemented");
}
