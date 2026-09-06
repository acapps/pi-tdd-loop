// Single commit point for loop state persistence — internal/refactor-state-model-divergence.md.
//
// Every state mutation that must survive a reload flows through `commit()`,
// which validates the flat LoopState via `validateLoopState` and then persists
// it as a `loop-state` session entry. On validation failure it logs a debug
// line and STILL persists (pinned quirk Q1: a persisted broken state is
// recoverable via quarantine-on-restore; a dropped one is silently lost).

import type { LoopState } from "./types";
import { validateLoopState, validationErrors } from "./state-validation";

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
}
