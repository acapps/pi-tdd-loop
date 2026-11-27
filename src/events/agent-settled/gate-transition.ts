// Gate transition handler — Step 9 of handleAgentSettled.
// Spec: internal/bug-gate-signal-integrity.md
//  - async; awaits runGates → GateOutcome
//  - kind "result" → computeTransition; kind "error" → computeGateErrorTransition
//  - G3: state.current.lastGateResult is set ONLY on a real gate result —
//    never on error (a gate that could not run is not a gate result).

import type { LoopState, GateResult, FailingTest, DisputeState } from "../../types";
import { getWorkspaceRoot } from "../../types";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import type { LanguageConfig } from "../../languages";
import { runGates } from "../../gates";
import { checkScope, readSpecForScopeCheck, captureGitBaseline } from "../../scope-check";
import { getLanguageConfig } from "../../languages";
import { getNewTestFiles } from "../../git-state";
import { getLiveMetrics, accumulateGate } from "../../metrics";
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
  const { phase, round, coverageThreshold, language, buildTool, gateTimeoutSec } = state;

  // A second agent_settled landing while the first gate is still running is
  // dropped: no second runGates, no second effect, no second prompt. The
  // dispatcher's `applied === false` path already no-ops state on this output.
  if (gateInFlight) {
    debug(`Gate in flight — dropping duplicate settle (Phase ${phase} round ${round})`);
    return NO_GATE;
  }
  gateInFlight = true;
  try {
    // Golden project: gates run in the workspace root (test/golden/...),
    // not the extension cwd. Self-refactor: gates run in cwd.
    const workspaceRoot = getWorkspaceRoot(state.specPath);
    const gateCwd = workspaceRoot === "." ? ctx.cwd : join(ctx.cwd, workspaceRoot);

    const outcome = await runGates(gateCwd, coverageThreshold, language, buildTool, phase, gateTimeoutSec);

    const gate = outcome.kind === "result" ? outcome.result! : null;

    // Scope check (cross-spec contamination): a green gate with dirty files
    // outside the active spec's Inventory is a scope violation, not a pass.
    // Skips cleanly when the check cannot run (non-git cwd, no Inventory).
    if (gate && outcome.kind === "result" && (phase === "B" || phase === "C")) {
      const specText = readSpecForScopeCheck(gateCwd, state.specPath);

      // Re-capture baseline if missing (restored session). The A→B transition
      // re-captures the baseline in effect-applicator.ts so that Phase A's
      // test files are "pre-existing" for Phase B's scope check.
      if (state.baselineDirtyFiles === undefined) {
        const baseline = captureGitBaseline(gateCwd);
        if (baseline !== null) {
          state.baselineDirtyFiles = baseline;
          debug(`Scope-check baseline captured: ${baseline.length} file(s)`);
        }
      }

      const scope = checkScope(gateCwd, state.specPath, specText, state.baselineDirtyFiles);
      if (!scope.skipped && !scope.ok) {
        gate.allPassed = false;
        gate.failures = [{
          test: "scope-check",
          subtest: "out-of-scope files",
          output: scope.outOfScope.join("\n"),
        }];
        debug(`Scope check FAILED: ${scope.outOfScope.length} file(s) outside Inventory: ${scope.outOfScope.join(", ")}`);
      } else if (!scope.skipped) {
        debug("Scope check passed");
      } else if (scope.skipReason === "no Inventory section") {
        // The dangerous skip: this is a git repo with a readable spec, but its
        // Inventory could not be parsed — so cross-spec contamination is NOT
        // being checked. Surface it (session 01a0d128: the bullet-list
        // Inventory was unparseable, the check silently skipped, and a stray
        // out-of-scope test file passed the gate). Non-fatal: a spec may
        // legitimately have no file-level Inventory (e.g. a pure-doc spec).
        ctx.ui.notify(
          "Scope check skipped: the active spec has no parseable ## Inventory file list — out-of-scope edits are not being gated this run.",
          "warning",
        );
      }
    }

    // Phase A zero-test check: the gate must verify that at least one new or
    // modified test file exists. Without this, the Tester can produce zero
    // tests and the gate passes vacuously (session 01a0f4db).
    // Returns null when git is unavailable — in that case, newTestFiles stays
    // undefined and the transition proceeds as before (backwards compatible).
    if (gate && phase === "A" && gate.compile) {
      const newTests = getNewTestFiles(gateCwd, language);
      if (newTests !== null) {
        gate.newTestFiles = newTests.length;
        if (newTests.length === 0) {
          debug(`Phase A zero-test check: no new test files detected`);
        } else {
          debug(`Phase A zero-test check: ${newTests.length} new/modified test file(s)`);
        }
      }
    }

    // bug-dispute-resolves-gate-failure: a conceded / defended / closed dispute
    // has cleared the specific failures it resolved. Re-evaluate the Phase B
    // gate without them, so a disputed-and-approved failure (a false-positive
    // scope-check in session 01a1c72a, or a stale test in 01a2113a) can't be
    // re-detected on every gate run and pin the loop before Phase C. The
    // post-exclusion verdict is "compile OK and no failures remain": a gate
    // that still fails on a *real* test has failures.length > 0, so it does
    // not advance until that test is actually fixed. (The old
    // `intrinsicVerdict && failures.length === 0` was wrong for an intrinsic
    // test failure: intrinsicVerdict is the pre-exclusion verdict, which is
    // false precisely because of the failure being removed, so a fully-resolved
    // stale test never restored allPassed.)
    if (gate && phase === "B" && state.dispute && isResolvedDispute(state.dispute)) {
      const { failures, removed } = excludeResolvedDisputeFailures(gate, state.dispute.resolvedFailures);
      if (removed) {
        gate.failures = failures;
        gate.allPassed = gate.compile && failures.length === 0;
        debug(`Dispute resolved: excluded resolved failure(s); ${failures.length} remaining (Phase B gate)`);
      }
    }

    // Accumulate gate metrics for the completion report
    if (gate) {
      const metrics = getLiveMetrics();
      if (metrics) {
        accumulateGate(metrics, { compile: gate.compile, allPassed: gate.allPassed, coverage: gate.coverage, failures: gate.failures });
      }
    }

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
  const failures = gate.failures.length > 0 || !gate.allPassed ? ` (${gate.failures.length} failures)` : "";
  return `Gate ${gate.allPassed ? "pass" : "fail"}${failures} [compile=${gate.compile} allPassed=${gate.allPassed} cov=${gate.coverage}%]`;
}

// A gate that could not run (tool spawn error) is not a gate result — but the
// effect still needs a sentinel result to log the failure against.
function errorGateResult(error?: string): GateResult {
  return {
    compile: false,
    compileError: error ?? "",
    allPassed: false,
    coverage: 0,
    failures: [],
  };
}

// A dispute has been resolved (the reviewer conceded or defended it, or the
// turn that resolved it has since closed it). While resolved, the gate excludes
// the failures the dispute cleared — see excludeResolvedDisputeFailures.
function isResolvedDispute(dispute: DisputeState | undefined): boolean {
  return !!dispute && (dispute.status === "conceded" || dispute.status === "defended" || dispute.status === "closed");
}

/**
 * Remove the failures a resolved dispute has cleared from a gate result.
 *
 * Matched by test + subtest, and for the scope-check also by the flagged file
 * (output) — so a NEW out-of-scope file introduced after the concede is still
 * caught, while the already-approved one is excluded. Returns the remaining
 * failures and whether anything was removed. An empty/absent resolved set is a
 * no-op, so undisputed gates behave exactly as before.
 */
function excludeResolvedDisputeFailures(
  gate: GateResult,
  resolved: FailingTest[] | undefined,
): { failures: FailingTest[]; removed: boolean } {
  if (!resolved || resolved.length === 0) return { failures: gate.failures, removed: false };
  const remaining = gate.failures.filter((f) =>
    !resolved.some((r) =>
      r.test === f.test &&
      (r.subtest === f.subtest) &&
      (r.output === f.output)
    ),
  );
  return { failures: remaining, removed: remaining.length !== gate.failures.length };
}