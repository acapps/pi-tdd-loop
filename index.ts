// loop — Adversarial 3-agent code generation loop (Go, Java, TypeScript)
// Phase A: Tester → Negotiate → Phase B: Writer → Phase C: Cleaner
// Each phase is gated by independent build/test/coverage checks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Cmd from "./src/commands";
import * as Tool from "./src/tools";
import * as Ev from "./src/events";
import type { LoopState } from "./src/types";

// Initialize language registry (lazy-loaded)
import { getLanguageConfig } from "./src/languages";
// Trigger lazy initialization of all languages
try { getLanguageConfig("go"); } catch { /* already initialized */ }

export default function (pi: ExtensionAPI) {
  // Mutable state wrapper — commands/tools/events read/write state.current
  const state: { current: LoopState } = { current: {
    phase: "idle",
    round: 0,
    specPath: "",
    language: "go",
    buildTool: "maven",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    disputeMode: false,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false,
    negotiateProposed: false,
    negotiateFeedback: "",
    awaitDisputeFix: false,
    awaitDisputeReview: false,
  }};

  function debug(msg: string) {
    pi.appendEntry("loop-debug", { ts: Date.now(), msg });
  }

  // =========================================================================
  // Commands
  // =========================================================================

  pi.registerCommand("loop", Cmd.cmdLoop(state, pi, debug));
  pi.registerCommand("loop-approve", Cmd.cmdApprove(state, pi, debug));
  pi.registerCommand("loop-status", Cmd.cmdStatus(state));
  pi.registerCommand("loop-continue", Cmd.cmdContinue(state, pi, debug));
  pi.registerCommand("loop-restart", Cmd.cmdRestart(state, pi, debug));
  pi.registerCommand("loop-debug", Cmd.cmdDebug(state, debug));
  pi.registerCommand("loop-cancel", Cmd.cmdCancel(state, pi, debug));

  // =========================================================================
  // Tools
  // =========================================================================

  const propose = Tool.negotiatePropose(state, pi, debug);
  pi.registerTool(propose);

  const review = Tool.negotiateReview(state, pi, debug);
  pi.registerTool(review);

  // =========================================================================
  // Events
  // =========================================================================

  pi.on("session_start", Ev.eventSessionStart(state, pi, debug));
  pi.on("before_agent_start", Ev.eventBeforeAgentStart(state, pi, debug));
  pi.on("tool_call", Ev.eventToolCall(state, pi, debug));
  pi.on("agent_settled", Ev.eventAgentSettled(state, pi, debug));
}
