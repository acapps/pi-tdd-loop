// /loop-patch — internal/refactor-commands-split.md
//
// cmdPatch + helpers: parsePatchArgs, resolvePatchTargetPhase.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState, Phase } from "../types";
import type { DebugFn } from "../events";
import { commit } from "../commit";
import { sendPrompt } from "../prompt";
import { resolveExistingSpec } from "../spec-path";
import { normalizeSpecPath } from "../selectors";
import { resetPhaseState, isIdleOrDone } from "../state-helpers";
import { parseTokens } from "../args";

interface PatchArgs {
  specPath: string;
  fromPhase?: Phase;
  invalidFrom?: string;
}

export function parsePatchArgs(args: string, currentSpecPath: string): PatchArgs {
  const { flags, positional } = parseTokens(args);
  let specPath = currentSpecPath;
  if (positional.length > 0) {
    specPath = normalizeSpecPath(positional[positional.length - 1]);
  }

  let fromPhase: Phase | undefined;
  let invalidFrom: string | undefined;
  if (flags.has("from")) {
    const target = (flags.get("from") ?? "").trim().toLowerCase();
    if (["a", "negotiate", "b", "c"].includes(target)) {
      fromPhase = target === "negotiate" ? "negotiate" : (target.toUpperCase() as Phase);
    } else {
      invalidFrom = flags.get("from") ?? "";
    }
  }

  return { specPath, fromPhase, invalidFrom };
}

export function resolvePatchTargetPhase(state: { current: LoopState }, fromPhase: Phase | undefined): Phase {
  if (fromPhase) return fromPhase;
  if (state.current.phase === "escalated") return state.current.lastPhase;
  return "A";
}

export function cmdPatch(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Patch the spec and restart from a phase: [spec-path] [--from <phase>]",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parsePatchArgs(args, state.current.specPath);
      if (parsed.invalidFrom !== undefined) {
        ctx.ui.notify(`Invalid --from value: ${parsed.invalidFrom}. Use A, negotiate, B, or C.`, "warning");
        return;
      }

      if (isIdleOrDone(state.current.phase)) {
        ctx.ui.notify(
          state.current.phase === "done"
            ? "Loop is complete. Use /loop <spec> to start a new loop."
            : "Loop is not running. Use /loop <spec> to start.",
          "warning",
        );
        return;
      }

      if (resolveExistingSpec(parsed.specPath, ctx.cwd) === null) {
        ctx.ui.notify(`Spec file not found: ${parsed.specPath}`, "error");
        return;
      }

      const oldPhase = state.current.phase;
      const targetPhase = resolvePatchTargetPhase(state, parsed.fromPhase);

      try {
        pi.appendEntry("loop-spec-patch", {
          specPath: parsed.specPath,
          fromPhase: oldPhase,
          toPhase: targetPhase,
          ts: new Date().toISOString(),
        });
      } catch {
        // Best-effort in print mode
      }

      state.current.specPath = parsed.specPath;
      state.current.phase = targetPhase;
      state.current.lastPhase = oldPhase;
      resetPhaseState(state.current);
      state.current.justTransitioned = true;
      state.current.justTransitionedBySettle = true; // settle-path flag: the re-entry settle is consumed (S1 entry 2)

      commit(state.current, pi, debug);
      ctx.ui.notify(`Spec patched. Restarting from Phase ${targetPhase}, round 1.`, "info");
      ctx.ui.setStatus("loop", `Phase ${targetPhase} — round 1 (patched)`);
      debug(`Command: /loop-patch → ${oldPhase} → ${targetPhase} (spec: ${parsed.specPath})`);

      sendPrompt(
        pi,
        `The spec at ${parsed.specPath} has been patched. Re-read it carefully.\nRestarting from Phase ${targetPhase} (round 1).\nFocus on the changes — the previous tests/implementation may encode the old behavior.`,
        state.current,
        debug,
      );
    },
  };
}
