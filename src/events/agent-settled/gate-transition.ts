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

export async function handleGateTransition(
  input: GateHandlerInput,
): Promise<GateHandlerOutput> {
  const { state, pi, ctx, lang, debug } = input;
  const { phase, round, coverageThreshold, language, buildTool } = state;

  const outcome = await runGates(ctx.cwd, coverageThreshold, language, buildTool, phase);

  let gate: GateResult | null = null;
  let transition: { state: LoopState; effect: TransitionEffect };
  if (outcome.kind === "result") {
    gate = outcome.result!;
    transition = T.computeTransition(state, gate);
  } else {
    transition = T.computeGateErrorTransition(state, outcome.error ?? "gate tool could not run");
  }

  const newState = transition.state;
  if (gate) {
    // G3: lastGateResult is set ONLY on a real gate result — never on error.
    // The dispatcher assigns it onto the re-assigned state.current.
  }

  const gateLog = gate
    ? `Gate ${gate.tests ? "pass" : "fail"}${gate.failures.length > 0 || !gate.tests ? ` (${gate.failures.length} failures)` : ""} [compile=${gate.compile} tests=${gate.tests} cov=${gate.coverage}%]`
    : `Gate error: ${outcome.error ?? "tool could not run"}`;
  debug(gateLog);
  debug(`→ ${transition.effect.type} (Phase ${newState.phase} round ${newState.round})`);

  const { applied } = applyEffect({
    state: { current: newState },
    pi,
    ctx,
    lang,
    debug,
    effect: transition.effect,
    gateResult: gate ?? {
      compile: false,
      compileError: outcome.error ?? "",
      tests: false,
      allPassed: false,
      coverage: 0,
      failures: [],
    },
  });

  return { state: newState, effect: transition.effect, gateResult: gate, applied };
}
