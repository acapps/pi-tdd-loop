// Gate transition handler — Step 9 of handleAgentSettled.
// Spec: internal/bug-gate-signal-integrity.md
//  - async; awaits runGates → GateOutcome
//  - kind "result" → computeTransition; kind "error" → computeGateErrorTransition
//  - G3: state.current.lastGateResult is set ONLY on a real gate result —
//    never on error (a gate that could not run is not a gate result).

import type { LoopState, GateResult } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import { runGates } from "../../gates";
import * as T from "../../transitions";
import { applyEffect } from "./effect-applicator";

// B3 alias: T.TransitionEffect is not exported from transitions.ts.
type TransitionEffect = ReturnType<typeof T.computeTransition>["effect"];

export interface GateHandlerInput {
  state: LoopState;
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
}

export interface GateHandlerOutput {
  state: LoopState;
  effect: TransitionEffect;
  prompt?: string;
  gateResult: GateResult | null; // null when the gate tool could not run (error)
  applied: boolean;
}

// Sentinel: a duplicate settle was dropped while a gate was in flight.
export const NO_GATE: GateHandlerOutput = {
  state: null as unknown as LoopState,
  effect: { type: "noop" },
  gateResult: null,
  applied: false,
};

// Module-local duplicate-settle lock (spec: internal/bug-gate-slow-settle-duplicate.md).
// One extension instance serves one loop, so a module-global flag is sufficient
// today; if multi-loop support ever lands, this must become per-LoopState.
// Cleared in `finally` so a thrown gate cannot wedge the loop.
let gateInFlight = false;

export async function handleGateTransition(
  input: GateHandlerInput,
): Promise<GateHandlerOutput> {
  const { state, pi, ctx, lang, debug } = input;
  const { phase, round, coverageThreshold, language, buildTool } = state;

  // A second agent_settled landing while the first gate is still running is
  // dropped: no second runGates, no second effect, no second prompt. The
  // dispatcher's `applied === false` path already no-ops state on this output.
  if (gateInFlight) {
    debug(`Gate in flight — dropping duplicate settle (Phase ${phase} round ${round})`);
    return NO_GATE;
  }
  gateInFlight = true;
  try {
    const outcome = await runGates(ctx.cwd, coverageThreshold, language, buildTool, phase);

    const gate = outcome.kind === "result" ? outcome.result! : null;
    const transition = gate
      ? T.computeTransition(state, gate)
      : T.computeGateErrorTransition(state, outcome.error ?? "gate tool could not run");

    const newState = transition.state;

    const gateLog = gate
      ? formatGateLog(gate)
      : `Gate error: ${outcome.error ?? "tool could not run"}`;
    debug(gateLog);
    debug(`→ ${transition.effect.type} (Phase ${newState.phase} round ${newState.round})`);

    // G3: lastGateResult is set ONLY on a real gate result — never on error.
    // The dispatcher assigns it onto the re-assigned state.current.
    const { applied } = applyEffect({
      state: { current: newState },
      pi,
      ctx,
      lang,
      debug,
      effect: transition.effect,
      gateResult: gate ?? errorGateResult(outcome.error),
    });

    // Git branch workflow (opt-in): on the done effect, the merge-back runs
    // asynchronously inside applyDoneEffect (fire-and-forget). A merge conflict
    // prompts the Writer for the single resolution attempt; the next settle
    // verifies the outcome (dispatcher step 0, handleMergeVerification).
    // Completion reporting (notify/status/prompt) happens synchronously in
    // applyDoneEffect, before the merge resolves — the merge is a post-step.

    return { state: newState, effect: transition.effect, gateResult: gate, applied };
  } finally {
    gateInFlight = false;
  }
}

function formatGateLog(gate: GateResult): string {
  const failures = gate.failures.length > 0 || !gate.tests ? ` (${gate.failures.length} failures)` : "";
  return `Gate ${gate.tests ? "pass" : "fail"}${failures} [compile=${gate.compile} tests=${gate.tests} cov=${gate.coverage}%]`;
}

// A gate that could not run (tool spawn error) is not a gate result — but the
// effect still needs a sentinel result to log the failure against.
function errorGateResult(error?: string): GateResult {
  return {
    compile: false,
    compileError: error ?? "",
    tests: false,
    allPassed: false,
    coverage: 0,
    failures: [],
  };
}