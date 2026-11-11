// --- Phase 0 → Phase A transition ---
// "Same transition, two entry points" (bug-phase-0-approval-dead-end): the
// agent's negotiate_propose("approve") and the human's /loop-approve both
// call this single function, so the field writes and prompt can never drift.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, Phase } from "./types";
import type { LoopStateSnapshot } from "./state/checkpoint";
import { getWorkspaceRoot } from "./types";
import { getLanguageConfig } from "./languages";
import { commit } from "./commit";
import { sendPrompt } from "./prompt";

interface PhaseACtx {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
}

/**
 * The Phase-0 → Phase-A field writes. Shared by every entry point that
 * starts Phase A (startPhaseA, the Phase 0 auto-approve in review.ts, and
 * the human /loop-approve command) so the field set can never drift.
 */
export function applyPhaseAFields(s: LoopState): void {
  s.phase = "A";
  s.round = 1;
  s.awaitingReview = false;
  s.turnsThisPhase = 1;
}

export function startPhaseA(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: PhaseACtx,
  debug: (msg: string) => void,
): void {
  const s = state.current;

  // fix-phase0-live-transcript-leaks: flush() — reset to Phase 0 review
  // with bounded transcript before entering Phase A. This ensures the
  // transcript entering Phase A contains only the Phase 0 review transcript,
  // bounded by the saved snapshot.
  const checkpointManager = s.checkpointManager;
  if (checkpointManager) {
    checkpointManager.flush();

    // Restore the Phase 0 snapshot — this resets the transcript to the
    // start of Phase 0 review, dropping all previous round history.
    const snapshots = checkpointManager.listSnapshots();
    const phase0Snapshot = snapshots.find((sn: LoopStateSnapshot) => sn.phase === "review");
    if (phase0Snapshot) {
      state.current = {
        ...state.current,
        phase: phase0Snapshot.phase as Phase,
        round: phase0Snapshot.round,
      };
      debug("Phase 0 snapshot restored — transcript bounded.");
    }
  }

  applyPhaseAFields(state.current);

  const lang = getLanguageConfig(s.language);
  ctx.ui.notify("Spec review approved. Phase A: Tester writes contract.", "info");
  ctx.ui.setStatus("loop", "Phase A — round 1");
  commit(s, pi, debug);

  sendPrompt(
    pi,
    lang.prompts.promptTesterPhaseA(s.specPath, s.buildTool, getWorkspaceRoot(s.specPath)),
    s,
    debug,
  );
}
