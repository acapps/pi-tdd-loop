// --- Phase 0 → Phase A transition ---
// "Same transition, two entry points" (bug-phase-0-approval-dead-end): the
// agent's negotiate_propose("approve") and the human's /loop-approve both
// call this single function, so the field writes and prompt can never drift.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState } from "./types";
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
 * starts Phase A (startPhaseA, the Phase 0 auto-approve in review.ts) so
 * the field set can never drift.
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
  debug("Phase 0 approve → Phase A, round 1");
  const s = state.current;
  applyPhaseAFields(s);

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
