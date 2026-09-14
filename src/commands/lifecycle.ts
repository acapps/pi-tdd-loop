// /loop-cancel, /loop-approve, /loop-stop — internal/refactor-commands-split.md
//
// cmdCancel, cmdApprove, cmdStop.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState } from "../types";
import type { DebugFn } from "../events";
import { commit } from "../commit";
import { startPhaseA } from "../phase-a";
import { isIdleOrDone } from "../state-helpers";


export function cmdCancel(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Cancel the loop and return to idle",
    handler: async (_args: string, ctx: CommandContext) => {
      state.current.phase = "idle";
      state.current.dispute = { status: "none" };
      state.current.round = 0;
      debug("Command: /loop-cancel → idle");
      ctx.ui.notify("Loop cancelled.", "info");
      ctx.ui.setStatus("loop", "idle");
      commit(state.current, pi, debug);
    },
  };
}

export function cmdApprove(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Approve Phase 0 review and proceed to Phase A",
    handler: async (_args: string, ctx: CommandContext) => {
      if (state.current.phase !== "review") {
        ctx.ui.notify("Not in Phase 0 review. Run /loop <spec-path> to start.", "warning");
        return;
      }

      startPhaseA(state, pi, ctx, debug);
    },
  };
}

export function cmdStop(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Stop the loop, preserving state for /loop-continue",
    handler: async (_args: string, ctx: CommandContext) => {
      if (isIdleOrDone(state.current.phase)) {
        ctx.ui.notify("Loop is not running.", "warning");
        return;
      }
      const prevPhase = state.current.phase;
      const round = state.current.round;
      state.current.phase = "escalated";
      state.current.lastPhase = prevPhase;
      commit(state.current, pi, debug);
      ctx.ui.notify(
        `Loop stopped at Phase ${prevPhase}, round ${round}. Run /loop-continue to resume.`,
        "info",
      );
      ctx.ui.setStatus("loop", `Stopped — Phase ${prevPhase} round ${round}`);
      debug(`Command: /loop-stop → phase ${prevPhase} → escalated`);
    },
  };
}
