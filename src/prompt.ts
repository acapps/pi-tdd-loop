// Prompt delivery — adapts to the execution context.
//
// Normal mode (interactive TUI/RPC): uses pi.sendUserMessage() with
// deliverAs: "followUp" for intra-process continuation.
//
// Runner mode (PI_LOOP_RUNNER=1, e.g. pi --continue --print): the process
// exits after agent_end, so followUps are never processed. Instead, the
// prompt is written to .pi/loop-status and the external runner
// (bin/run-loop.sh) picks it up on the next iteration.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWorkspaceRoot } from "./types";
import type { LoopState } from "./types";

export type PromptDebug = (msg: string) => void;

/**
 * True when running under the external runner (pi --continue --print).
 * In this mode, followUps are not processed; the status file is used instead.
 */
export function isRunnerMode(): boolean {
  return process.env.PI_LOOP_RUNNER === "1";
}

/**
 * Send a prompt to the agent.
 *
 * - Normal mode: pi.sendUserMessage(prompt, { deliverAs: "followUp" }).
 * - Runner mode: write the prompt to .pi/loop-status so the external
 *   runner can pick it up. The process will exit after agent_end.
 *
 * Never throws.
 */
export function sendPrompt(
  pi: ExtensionAPI,
  prompt: string,
  state: LoopState | undefined,
  debug: PromptDebug,
): void {
  if (isRunnerMode()) {
    if (state) {
      try {
        const wsRoot = getWorkspaceRoot(state.specPath);
        const dir = join(wsRoot, ".pi");
        mkdirSync(dir, { recursive: true });
        const statusFile = join(dir, "loop-status");
        writeFileSync(statusFile, JSON.stringify({
          status: "continue",
          prompt,
          phase: state.phase,
          round: state.round,
          specPath: state.specPath,
          updatedAt: new Date().toISOString(),
        }), "utf8");
      } catch (err) {
        debug(`prompt: status file write failed — ${err}`);
      }
    }
    debug(`prompt: [runner-mode] wrote prompt to status file (${prompt.length} chars)`);
    return;
  }

  try {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  } catch (err) {
    debug(`prompt: sendUserMessage failed — ${err}`);
  }
}
