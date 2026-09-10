// loop — Adversarial 3-agent code generation loop (Go, Java, TypeScript)
// Phase A: Tester → Negotiate → Phase B: Writer → Phase C: Cleaner
// Each phase is gated by independent build/test/coverage checks.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Cmd from "./src/commands";
import { cmdSpec } from "./src/spec-command";
import * as Tool from "./src/tools";
import * as Ev from "./src/events";
import {
  createRepeatedToolCallHandler,
  resetCallCounters,
} from "./src/events/tool-call/index";
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
    gateTimeoutSec: 60,
    dispute: { status: "none" },
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle",
    justTransitioned: false,
    negotiateReprompted: false,
    negotiateProposed: false,
    negotiateFeedback: "",
  }};

  function debug(msg: string) {
    pi.appendEntry("loop-debug", { ts: Date.now(), msg });
  }

  // =========================================================================
  // Commands
  // =========================================================================

  pi.registerCommand("spec", cmdSpec(state, pi, debug));
  pi.registerCommand("loop", Cmd.cmdLoop(state, pi, debug));
  pi.registerCommand("loop-approve", Cmd.cmdApprove(state, pi, debug));
  pi.registerCommand("loop-status", Cmd.cmdStatus(state));
  pi.registerCommand("loop-continue", Cmd.cmdContinue(state, pi, debug));
  pi.registerCommand("loop-restart", Cmd.cmdRestart(state, pi, debug));
  pi.registerCommand("loop-debug", Cmd.cmdDebug(state, debug));
  pi.registerCommand("loop-cancel", Cmd.cmdCancel(state, pi, debug));
  pi.registerCommand("loop-stop", Cmd.cmdStop(state, pi, debug));

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

  pi.on("agent_settled", Ev.eventAgentSettled(state, pi, debug));
  pi.on("session_start", Ev.eventSessionStart(state, pi, debug));
  pi.on("before_agent_start", Ev.eventBeforeAgentStart(state, pi, debug));
  pi.on("tool_call", Ev.eventToolCall(state, pi, debug));
  // fix-negotiate-confirm-approval-loop §4: the repeated-call breaker.
  registerLoopBreaker(pi, debug);

  // Test-only seam (see __getStateForTest below).
  lastState = state;
}

// fix-negotiate-confirm-approval-loop §4: the repeated-call breaker wiring.
// A SECOND tool_call registration (path enforcement above stays) — separate
// module, do not consolidate. The per-turn counter map clears on turn_start
// (every fresh turn, incl. /loop-* command turns) and on agent_settled (the
// belt for turns that settle without a following turn_start).
function registerLoopBreaker(pi: ExtensionAPI, debug: (msg: string) => void): void {
  pi.on("tool_call", createRepeatedToolCallHandler(pi, debug));
  pi.on("turn_start", () => {
    resetCallCounters();
  });
  pi.on("agent_settled", () => {
    resetCallCounters();
  });
}

// Test-only seam: exposes the live state object of the LAST registered
// extension instance so a test can simulate a settle's round advance without
// running the full agent_settled pipeline. Never called from production code.
let lastState: { current: LoopState } | null = null;
export function __getStateForTest(): { current: LoopState } | null {
  return lastState;
}
