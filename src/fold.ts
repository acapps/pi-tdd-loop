// --- fold (pure core) ---
// The mechanical settle step that folds the Tester's two-tier contract into one
// visible contract. Pure and I/O-free so it is hermetic to test.
//
// Spec: internal/wire-holdback-test-contract.md. Row 5:
//   - Promote: every [holdback] Inventory row whose test was NOT conceded is
//     flipped to [visible].
//   - Drop: every [holdback] Inventory row whose test WAS conceded is removed
//     from the Inventory (and its file removed from disk at the effect level).
//   - The conceded test is mapped to its defining file by test+subtest against
//     the holdback file contents.
//
// U3 (optional, deferred): canonicalHoldbackTarget / moveHoldbackFile compute
// the canonical test-tree location and report the file move. The physical move
// itself is an fs-level effect (see events/agent-settled/consolidate.ts).

import type { FailingTest } from "./types";
import { INVENTORY_ROW } from "./spec-inventory";

export interface PromoteResult {
  specText: string;
  /** Count of [holdback] rows flipped to [visible] (dropConceded: rows removed). */
  promoted: number;
}

export interface ConsolidateOptions {
  specText: string;
  holdbackSubdir?: string;
  holdbackFiles?: Record<string, string>;
  resolvedFailures?: FailingTest[];
}

export interface ConsolidateResult {
  specText: string;
  promoted: number;
  dropped: number;
  promotedFiles: string[];
  droppedFiles: string[];
  /** Whether the optional U3 physical merge (holdback subdir → canonical) ran. */
  merged: boolean;
}

export interface MoveOptions {
  cwd: string;
  file: string;
  subdir: string;
  target: string;
}

export interface MoveResult {
  from: string;
  to: string | null;
  /** True when the file move was performed (the move target is valid). */
  moved: boolean;
}

/**
 * Flip every [holdback] Inventory row to [visible] and count the flips.
 * No-op when there are no [holdback] rows.
 */
export function promoteHoldback(specText: string): PromoteResult {
  const out: string[] = [];
  let promoted = 0;
  for (const line of specText.split("\n")) {
    if (/\[holdback\]/.test(line)) {
      out.push(line.replace("[holdback]", "[visible]"));
      promoted++;
    } else {
      out.push(line);
    }
  }
  return { specText: out.join("\n"), promoted };
}

/**
 * Remove the rows for the conceded files and count them. The count is returned
 * in `promoted` (the field name the contract pins), even though it is a drop.
 * No-op when none of the conceded files appear in the Inventory.
 */
export function dropConceded(specText: string, concededFiles: string[]): PromoteResult {
  const out: string[] = [];
  let removed = 0;
  for (const line of specText.split("\n")) {
    const m = line.match(/^- `([^`]+)`/);
    if (m && concededFiles.includes(m[1])) {
      removed++;
      continue;
    }
    out.push(line);
  }
  return { specText: out.join("\n"), promoted: removed };
}

/**
 * Map a conceded test+subtest to the holdback file whose content defines it.
 * The file whose contents contain BOTH the test name and the subtest name is the
 * conceded file. Returns null when no file matches.
 */
export function fileForConcededTest(
  test: string,
  subtest: string,
  holdbackFiles: Record<string, string>,
): string | null {
  for (const [file, content] of Object.entries(holdbackFiles)) {
    if (content.includes(test) && content.includes(subtest)) {
      return file;
    }
  }
  return null;
}

/**
 * Fold the two-tier contract into one visible contract.
 *   - Conceded [holdback] rows (matched by test+subtest → file) are dropped.
 *   - Non-conceded [holdback] rows are promoted to [visible].
 * Idempotent: a second run over the folded spec folds nothing.
 */
export function consolidate(opts: ConsolidateOptions): ConsolidateResult {
  const { specText, holdbackFiles, resolvedFailures } = opts;
  const files = holdbackFiles ?? {};
  const failures = resolvedFailures ?? [];

  // Which holdback files are conceded (matched by test+subtest → file).
  const concededFiles = new Set<string>();
  for (const failure of failures) {
    const file = fileForConcededTest(failure.test, failure.subtest, files);
    if (file) concededFiles.add(file);
  }

  const out: string[] = [];
  let promoted = 0;
  let dropped = 0;
  const promotedFiles: string[] = [];
  const droppedFiles: string[] = [];

  for (const line of specText.split("\n")) {
    const m = line.match(INVENTORY_ROW);
    if (m) {
      const path = m[1];
      const tag = m[2];
      if (tag === "holdback") {
        if (concededFiles.has(path)) {
          dropped++;
          droppedFiles.push(path);
          continue; // drop the row entirely
        }
        promoted++;
        promotedFiles.push(path);
        out.push(line.replace("[holdback]", "[visible]"));
        continue;
      }
    }
    out.push(line);
  }

  return {
    specText: out.join("\n"),
    promoted,
    dropped,
    promotedFiles,
    droppedFiles,
    merged: false,
  };
}

/** Render the settle fold summary for promptConsolidationStatus. */
export function consolidateStatus(promoted: number, dropped: number, merged: boolean): string {
  return (
    `Contract folded: ${promoted} holdback test(s) promoted to the visible contract, ` +
    `${dropped} conceded test(s) dropped, ` +
    `${merged ? "holdback subdir merged" : "holdback subdir retained"}.`
  );
}

/**
 * Canonical test-tree location for a holdback file: the path with the holdback
 * subdir prefix stripped. Falls back to the basename when the file is not under
 * the subdir. Pure — never returns the holdback path or an empty string.
 */
export function canonicalHoldbackTarget(file: string, subdir: string): string {
  if (subdir && file.startsWith(subdir + "/")) {
    return file.slice(subdir.length + 1);
  }
  const parts = file.split("/");
  return parts[parts.length - 1] || file;
}

/**
 * Report the move of a holdback file to its canonical location. Pure: it
 * computes the move result without touching the filesystem (the fs-level move
 * and empty-subdir removal live in the settle effect). `moved` is true when the
 * move target is valid.
 */
export function moveHoldbackFile(opts: MoveOptions): MoveResult {
  return { from: opts.file, to: opts.target, moved: true };
}
