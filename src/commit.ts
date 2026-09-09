// Single commit point for loop state persistence — internal/refactor-state-model-divergence.md.
//
// Every state mutation that must survive a reload flows through `commit()`,
// which validates the flat LoopState via `validateLoopState` and then persists
// it as a `loop-state` session entry. On validation failure it logs a debug
// line and STILL persists (pinned quirk Q1: a persisted broken state is
// recoverable via quarantine-on-restore; a dropped one is silently lost).
//
// When PI_LOOP_RUNNER=1 (external runner mode), commit() also writes a
// best-effort status file (.pi/loop-status) in the workspace root so the
// runner script can poll loop progress without parsing session entries.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoopState } from "./types";
import { validateLoopState, validationErrors } from "./state-validation";
import { getWorkspaceRoot } from "./types";

export interface CommitApi {
  appendEntry(customType: string, data: unknown): void;
}

export type CommitDebug = (msg: string) => void;

/**
 * Validate-then-persist the loop state.
 *
 * - Valid state: persisted, no debug line.
 * - Invalid state: debug `commit: state failed validation — ${errors}`,
 *   then persisted anyway (Q1).
 * Never throws.
 */
export function commit(state: LoopState, api: CommitApi, debug: CommitDebug): void {
  const errors = validationErrors(state);
  if (errors.length > 0) {
    // Pinned debug format (Q1): `commit: state failed validation — ${errors}`
    debug(`commit: state failed validation — ${errors.join("; ")}`);
  }
  api.appendEntry("loop-state", { ...state });

  // Best-effort status file for external runner (PI_LOOP_RUNNER=1).
  // The session entry is the source of truth; this file is a convenience
  // for the runner script to poll without parsing session entries.
  if (process.env.PI_LOOP_RUNNER === "1") {
    try {
      const wsRoot = getWorkspaceRoot(state.specPath);
      const dir = join(wsRoot, ".pi");
      mkdirSync(dir, { recursive: true });
      const statusFile = join(dir, "loop-status");
      writeFileSync(statusFile, JSON.stringify({
        status: state.phase === "done" ? "done"
          : state.phase === "escalated" ? "escalated"
          : "active",
        phase: state.phase,
        round: state.round,
        specPath: state.specPath,
        updatedAt: new Date().toISOString(),
      }), "utf8");
    } catch (err) {
      debug(`commit: status file write failed — ${err}`);
    }
  }
}
