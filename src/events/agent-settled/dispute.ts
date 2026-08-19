// --- dispute handler ---
// Dispute fix and dispute review handling.
// Spec: internal/04-implement-agent-settled-handlers.md (R2, flag-preservation).

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import * as GP from "../../generic-prompts";

// --- Types ---

export interface DisputeHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  // Optional (R2): the dispatcher omits it for handleDisputeFix, which never
  // debug-logs; handleDisputeReview still receives it.
  debug?: (msg: string) => void;
}

export interface DisputeHandlerOutput {
  handled: boolean;
  type?: "fix" | "review" | "defend" | "writer-fix";
}

// --- Public API ---

export function handleDisputeFix(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, ctx, lang } = input;
  if (!state.current.awaitDisputeFix) return { handled: false, type: "fix" };

  // No state mutation here — the flag is cleared elsewhere (prompt-build, spec 03).
  ctx.ui.setStatus("loop", `Phase B — round ${state.current.round} (dispute fix)`);
  pi.sendUserMessage(lang.prompts.promptTesterDisputeFix(), { triggerTurn: true });
  return { handled: true, type: "fix" };
}

export function handleDisputeReview(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, ctx, debug } = input;
  if (!state.current.awaitDisputeReview) return { handled: false, type: "review" };

  // Spec 09 Table 1 row 1: schedule the reviewer turn. Filer is derived at
  // scheduling (disputeMode is stable from filing to settle); the prompt is
  // addressed to the REVIEWER, not the filer.
  const filer = state.current.disputeMode ? "tester" : "writer";
  const reviewer = filer === "writer" ? "tester" : "writer";
  const prompt = filer === "writer"
    ? GP.promptTesterReviewWriterDispute(state.current.lastProposal)
    : GP.promptWriterDisputeReview(state.current.lastProposal);
  debug?.(`Dispute review → ${reviewer} review turn`);
  pi.sendUserMessage(prompt, { triggerTurn: true });
  state.current.awaitDisputeReview = false; // cleared at scheduling — never survives a settle
  persistState(state, pi);
  ctx.ui.setStatus("loop", `Phase ${state.current.phase} — round ${state.current.round} (dispute review)`);
  return { handled: true, type: "review" }; // the gate resumes on the next settle
}

// --- Spec 09: follow-up delivery handlers (Table 3) ---

export function handleDisputeDefend(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, debug } = input;
  if (state.current.disputeDefended === undefined) return { handled: false, type: "defend" };

  // Routed by the RECORDED filer (never re-derived: disputeMode was cleared by
  // Table 2 row 4 and is no longer a reliable signal — reviewer F-B).
  const prompt = state.current.disputeFiler === "tester"
    ? GP.promptTesterReportRejected(state.current.disputeDefended)
    : GP.promptWriterDisputeDefended(state.current.disputeDefended);
  debug?.("Dispute defend → delivering decision");
  pi.sendUserMessage(prompt, { triggerTurn: true });
  state.current.disputeDefended = undefined;
  state.current.disputeFiler = undefined; // cleared per Table 3 row 1
  persistState(state, pi);
  return { handled: true, type: "defend" };
}

export function handleWriterConcedeFix(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, debug } = input;
  if (state.current.awaitWriterConcedeFix !== true) return { handled: false, type: "writer-fix" };

  debug?.("Writer conceded → fix turn");
  pi.sendUserMessage(GP.promptWriterConcedeFix(state.current.lastProposal), { triggerTurn: true });
  state.current.awaitWriterConcedeFix = false;
  state.current.disputeFiler = undefined; // N2: cleared on this row too
  persistState(state, pi);
  return { handled: true, type: "writer-fix" };
}

// --- Shared helpers ---

function persistState(state: { current: LoopState }, pi: ExtensionAPI): void {
  pi.appendEntry("loop-state", { ...state.current });
}
