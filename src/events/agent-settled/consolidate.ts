// --- consolidate (settle effect) ---
// The mechanical settle effect that folds the Tester's two-tier contract into
// one visible contract. It rewrites the spec Inventory (promote non-conceded
// [holdback] rows, drop conceded ones), removes the conceded files from disk,
// and emits the fold status prompt. Runs before the loop reports done, so the
// loop cannot report green with an un-promoted holdback tier.
//
// Spec: internal/wire-holdback-test-contract.md. Row 5 (the fold).

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DisputeState } from "../../types";
import {
  consolidate as pureConsolidate,
  consolidateStatus,
  type ConsolidateResult as FoldResult,
} from "../../fold";

// Matches a [holdback] Inventory row:  - `test/holdback/x.test.ts` [holdback]
const HOLDBACK_ROW = /^- `([^`]+)`\s*\[holdback\]/;

export interface ConsolidateInput {
  state: { specPath: string; dispute?: DisputeState };
  ctx: { ui: { setStatus: (scope: string, status: string) => void }; cwd: string };
  pi: unknown;
  debug: (msg: string) => void;
  holdbackSubdir?: string;
  holdbackFiles?: Record<string, string>;
}

export interface ConsolidateResult {
  promoted: number;
  dropped: number;
  merged: boolean;
}

/**
 * Read the holdback files' contents from disk (keyed by path). Used only when
 * the caller does not supply holdbackFiles. The fold's test→file mapping needs
 * the file contents to concede by test+subtest.
 */
function readHoldbackFiles(specText: string, cwd: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const line of specText.split("\n")) {
    const m = line.match(HOLDBACK_ROW);
    if (!m) continue;
    const path = m[1];
    try {
      files[path] = readFileSync(join(cwd, path), "utf-8");
    } catch {
      // File missing on disk — skip it; the fold still folds the Inventory.
    }
  }
  return files;
}

/**
 * Run the fold: read the spec, fold it, write the folded spec back, remove the
 * conceded files from disk, and emit the fold status prompt.
 */
export function runConsolidation(input: ConsolidateInput): ConsolidateResult {
  const { state, ctx, debug, holdbackSubdir, holdbackFiles } = input;

  const specText = readFileSync(state.specPath, "utf-8");
  const files = holdbackFiles ?? readHoldbackFiles(specText, ctx.cwd);
  const resolvedFailures = state.dispute?.resolvedFailures ?? [];

  const result: FoldResult = pureConsolidate({
    specText,
    holdbackSubdir,
    holdbackFiles: files,
    resolvedFailures,
  });

  // Only touch disk, status, and the debug trace when something actually
  // folded. A run with no holdback tier is a no-op: leave the visible contract,
  // its status line, and the debug trace untouched so it never perturbs the
  // existing settle path.
  if (result.promoted > 0 || result.dropped > 0) {
    // Rewrite the visible contract (promote + drop) back onto disk.
    writeFileSync(state.specPath, result.specText);

    // Defensive drop: remove every conceded holdback file so a mis-specified
    // test can neither block the Phase C gate nor be enshrined in the contract.
    for (const file of result.droppedFiles) {
      rmSync(file);
    }

    ctx.ui.setStatus("loop", consolidateStatus(result.promoted, result.dropped, result.merged));
    debug(`Fold: ${result.promoted} promoted, ${result.dropped} dropped`);
  }

  return { promoted: result.promoted, dropped: result.dropped, merged: result.merged };
}

/** Settle-effect entry point — the fold at settle. */
export function consolidateEffect(input: ConsolidateInput): ConsolidateResult {
  return runConsolidation(input);
}
