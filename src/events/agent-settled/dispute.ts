// --- dispute handler ---
// Dispute fix and dispute review handling.
// Spec: internal/04-implement-agent-settled-handlers.md (R2, flag-preservation).
// Lifecycle: internal/bug-dispute-reload-evaporation.md — the 4 handlers are
// status transitions on state.current.dispute; the status moves AT delivery
// (set before send, persist before send), so a reload can never double-
// deliver or evaporate a pending leg.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import * as GP from "../../generic-prompts";
import { commit } from "../../commit";
import { sendPrompt } from "../../prompt";
import { getTestCommand } from "../../gates";
import { getWorkspaceRoot } from "../../types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- Types ---

export interface DisputeHandlerInput {
  state: { current: LoopState };
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
}

export interface DisputeHandlerOutput {
  handled: boolean;
  type?: "fix" | "review" | "defend" | "concede" | "writer-fix";
}

// --- Public API ---

// Row 5: status "conceded" + writer filed → the Tester fixes the test.
// The status → "closed" moves BEFORE the send (persist before send): a
// reload after delivery cannot re-deliver.
//
// If the Tester already fixed the test in the decision turn (the suite is
// green), skip the fix prompt and let the normal gate handle the advance.
export async function handleDisputeFix(
  input: DisputeHandlerInput,
): Promise<DisputeHandlerOutput> {
  const { state, pi, ctx, lang, debug } = input;
  const d = state.current.dispute;
  if (!d || d.status !== "conceded" || d.filer !== "writer") return { handled: false };

  // Check if the suite is already green (the Tester may have fixed the test
  // in the same turn as the concede decision).
  const s = state.current;
  const cwd = getWorkspaceRoot(s.specPath);
  const testCmd = getTestCommand(s.language, s.buildTool, { cwd });
  let suiteGreen = false;
  try {
    const [bin, ...args] = testCmd.split(/\s+/);
    await execFileAsync(bin, args, { cwd, timeout: 30000 });
    suiteGreen = true;
  } catch {
    suiteGreen = false;
  }

  if (suiteGreen) {
    debug("Dispute fix → suite already green, skipping fix prompt");
    state.current.dispute = { ...d, status: "closed" };
    commit(state.current, pi, debug);
    return { handled: true };
  }

  debug("Dispute fix → Tester fixes the test");
  state.current.dispute = { ...d, status: "closed" };
  commit(state.current, pi, debug);
  ctx.ui.setStatus("loop", `Phase B — round ${state.current.round} (dispute fix)`);
  sendPrompt(pi, lang.prompts.promptTesterDisputeFix(), state.current, debug);
  return { handled: true };
}

// Row 3: status "filed" → "in-review": schedule the reviewer turn.
// Set-before-send + persist-before-send (S2): the review leg is crash-safe
// by construction, and a reload re-delivers (the status survived).
export function handleDisputeReview(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, ctx, debug } = input;
  const d = state.current.dispute;
  if (!d || (d.status !== "filed" && d.status !== "in-review")) return { handled: false, type: "review" };

  // The RECORDED filer from filing — never re-derived.
  const filer = d.filer ?? "writer";
  const reviewer = filer === "writer" ? "tester" : "writer";
  const prompt = filer === "writer"
    ? GP.promptTesterReviewWriterDispute(d.claim ?? state.current.lastProposal)
    : GP.promptWriterDisputeReview(d.claim ?? state.current.lastProposal);
  debug(`Dispute review → ${reviewer} review turn`);

  state.current.dispute = { ...d, status: "in-review" };
  commit(state.current, pi, debug); // persist BEFORE the send (S2)
  sendPrompt(pi, prompt, state.current, debug);
  ctx.ui.setStatus("loop", `Phase ${state.current.phase} — round ${state.current.round} (dispute review)`);
  return { handled: true, type: "review" }; // the gate resumes on the next settle
}

// Row 7: status "defended" → closed: deliver the defend decision, routed by
// the RECORDED filer.
export function handleDisputeDefend(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, debug } = input;
  const d = state.current.dispute;
  if (!d || d.status !== "defended") return { handled: false };

  const prompt = d.filer === "tester"
    ? GP.promptTesterReportRejected(d.decision ?? "")
    : GP.promptWriterDisputeDefended(d.decision ?? "");
  debug("Dispute defend → delivering decision");
  state.current.dispute = { ...d, status: "closed" };
  commit(state.current, pi, debug); // persist BEFORE the send
  sendPrompt(pi, prompt, state.current, debug);
  return { handled: true, type: "defend" };
}

// Row 4 (tester filed → Writer fixes): status "conceded" + tester filed →
// closed: deliver the writer concede-fix prompt.
export function handleWriterConcedeFix(
  input: DisputeHandlerInput,
): DisputeHandlerOutput {
  const { state, pi, debug } = input;
  const d = state.current.dispute;
  if (!d || d.status !== "conceded" || d.filer !== "tester") return { handled: false };

  debug("Writer conceded → fix turn");
  state.current.dispute = { ...d, status: "closed" };
  commit(state.current, pi, debug); // persist BEFORE the send
  sendPrompt(pi, GP.promptWriterConcedeFix(d.claim ?? state.current.lastProposal), state.current, debug);
  return { handled: true, type: "writer-fix" };
}
