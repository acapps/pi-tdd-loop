// Scope check — Phase B/C gate guard against cross-spec contamination.
//
// A Writer working on spec X must not leave edits in files that belong to
// another spec's territory. Observed: session 01a0bba2 (spec
// fix-just-transitioned-settle-drop) — the Writer implemented parts of
// fix-phase0-scanner-noise (S1 framing line in loop.ts, S4 contract scoping
// in reviewer.ts) mid-run, with no negotiation and no test contract. The
// gate never caught it: the contaminated files were outside the active
// spec's Inventory and the suite stayed green.
//
// Mechanism: at gate time, compare the git dirty set against the active
// spec's Inventory file list. Files outside it (plus a small allowlist)
// fail the gate with a named list, so the loop forces a dispute or a scope
// decision IN the run — not after the fact.
//
// Design notes:
//  - The check runs ONLY when git reports the gate cwd is inside a
//    repository. Non-git checkouts (e.g. temp-dir e2e scaffolds) skip it —
//    a scope check without git is unverifiable, and skipping is the safe
//    default (never fail a gate on an unverifiable premise).
//  - `git status --porcelain` reads the index + worktree; staged and
//    unstaged both count. Untracked files count too (a half-written
//    contract test in another spec's territory is contamination as well).
//  - The Inventory is parsed from the spec's `## Inventory` markdown table
//    (first column, backtick-quoted paths). Specs without an Inventory
//    section skip the check (same safe default).

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

export interface ScopeCheckResult {
  /** true when no out-of-scope files were found (or the check was skipped). */
  ok: boolean;
  /** Out-of-scope files, relative to the gate cwd (empty when ok or skipped). */
  outOfScope: string[];
  /** true when the check did not run (not a git repo, or no Inventory). */
  skipped: boolean;
  /** Human-readable reason when skipped. */
  skipReason?: string;
}

// Files the loop itself touches, regardless of the active spec's Inventory:
// the spec file (archived to done- on completion), the index, and the
// archive target. Kept minimal — anything else is a scope decision.
const ALLOWLIST = new Set([
  "internal/index.md",
]);

/**
 * True when a backtick-quoted token looks like a file path: contains a `/`
 * or ends in a known source/test extension. This is what separates the
 * Inventory's file entries from the many other backtick tokens a spec carries
 * (function names like `buildWriterPrompt`, flags, strings).
 */
function isFilePath(token: string): boolean {
  if (token.includes("/")) return true;
  return /\.[a-z]{1,5}$/i.test(token);
}

/**
 * Parse the `## Inventory` section of a spec file into its file paths.
 * Returns the paths, or null when the section is absent or lists no files.
 * Pure string function — unit-testable without I/O.
 *
 * Handles BOTH Inventory formats the spec-authoring template produces:
 *  - bullet list (the template's actual form):
 *      - **Files:**
 *        - `src/foo.ts` — modify ...
 *        - `test/foo.test.ts` — extend ...
 *  - markdown table (also accepted):
 *      | `src/foo.ts` | Modify |
 *
 * It extracts every backtick-quoted token in the section that looks like a
 * file path (isFilePath), deduplicated, in order of first appearance. The
 * earlier table-only parser returned null for every bullet-list spec — a
 * silent no-op that skipped the scope check on real specs (session 01a0d128).
 */
export function parseInventory(specText: string): string[] | null {
  const lines = specText.split("\n");
  let inInventory = false;
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+Inventory\b/i.test(trimmed)) {
      inInventory = true;
      continue;
    }
    if (inInventory && /^##\s+/i.test(trimmed)) break; // next section
    if (!inInventory) continue;
    // Every backtick-quoted token on the line (bullet rows, table cells, prose).
    const tokens = trimmed.match(/`([^`]+)`/g) ?? [];
    for (const t of tokens) {
      // Strip a line qualifier (path:125 → path) and surrounding whitespace.
      const path = t.slice(1, -1).trim().replace(/:\d+$/, "").trim();
      if (isFilePath(path) && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }
  }
  return files.length > 0 ? files : null;
}

/**
 * Get the git dirty set (staged + unstaged + untracked) as paths relative
 * to `cwd`. Returns null when `cwd` is not inside a git repository.
 */
export function getGitDirtyFiles(cwd: string): string[] | null {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    const files: string[] = [];
    for (const line of out.split("\n")) {
      if (line.length < 4) continue;
      // porcelain v1: "XY path" — renames are "XY old -> new"; take the new.
      let path = line.slice(3).trim();
      const arrow = path.indexOf(" -> ");
      if (arrow !== -1) path = path.slice(arrow + 4);
      // Quoted paths (unicode): "path" — strip the quotes.
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
      if (path) files.push(path);
    }
    return files;
  } catch {
    return null; // not a git repo (or git unavailable)
  }
}

/**
 * Get only the untracked files (?? prefix) from `git status --porcelain`.
 * Used for the scope-check baseline: pre-existing untracked files are
 * "just other work in the repo" and should not block the gate. Modified
 * tracked files (M) are NOT included — their dirty state is meaningful
 * (content changed) and they must still be checked against the Inventory.
 */
export function getGitUntrackedFiles(cwd: string): string[] | null {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    const files: string[] = [];
    for (const line of out.split("\n")) {
      if (line.length < 4) continue;
      // Only untracked: "?? path"
      if (!line.startsWith("??")) continue;
      let path = line.slice(3).trim();
      // Quoted paths (unicode): "path" — strip the quotes.
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
      if (path) files.push(path);
    }
    return files;
  } catch {
    return null;
  }
}

/**
 * Run the scope check. Pure orchestration over the two functions above —
 * unit-test by mocking execSync/readFileSync, never by spawning git.
 *
 * @param cwd         gate cwd (the directory the gate runs in)
 * @param specPath    active spec path (absolute or relative to cwd)
 * @param specText    active spec content (caller reads it; null = unreadable)
 */
export function checkScope(
  cwd: string,
  specPath: string,
  specText: string | null,
  baseline?: string[],
): ScopeCheckResult {
  if (specText === null) {
    return { ok: true, outOfScope: [], skipped: true, skipReason: "spec unreadable" };
  }
  const inventory = parseInventory(specText);
  if (inventory === null) {
    return { ok: true, outOfScope: [], skipped: true, skipReason: "no Inventory section" };
  }
  const dirty = getGitDirtyFiles(cwd);
  if (dirty === null) {
    return { ok: true, outOfScope: [], skipped: true, skipReason: "not a git repository" };
  }

  // Filter out files that were already dirty at spec start (baseline).
  // These are pre-existing untracked/modified files, not contamination.
  const effectiveDirty = baseline
    ? dirty.filter((f) => !baseline.includes(f))
    : dirty;

  // Build the allowed set: Inventory paths (resolved against cwd) + the
  // spec file itself + its done- archive twin + the allowlist.
  const allowed = new Set<string>();
  for (const p of inventory) allowed.add(normalize(p, cwd));
  const absSpec = isAbsolute(specPath) ? specPath : resolve(cwd, specPath);
  allowed.add(absSpec);
  // done- twin: internal/fix-foo.md → internal/done-fix-foo.md
  // (the archive convention keeps the "fix-" prefix: done- + original basename)
  const specDir = absSpec.slice(0, absSpec.lastIndexOf("/"));
  const specBase = absSpec.slice(absSpec.lastIndexOf("/") + 1);
  const doneBase = "done-" + specBase;
  allowed.add(specDir + "/" + doneBase);
  for (const a of ALLOWLIST) allowed.add(resolve(cwd, a));

  const outOfScope: string[] = [];
  for (const f of effectiveDirty) {
    const abs = isAbsolute(f) ? f : resolve(cwd, f);
    if (!allowed.has(abs)) outOfScope.push(f);
  }
  outOfScope.sort();
  return { ok: outOfScope.length === 0, outOfScope, skipped: false };
}

function normalize(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Read the active spec for the scope check. Returns null when unreadable —
 * the check skips (safe default), it does not fail the gate.
 */
export function readSpecForScopeCheck(cwd: string, specPath: string): string | null {
  const abs = isAbsolute(specPath) ? specPath : resolve(cwd, specPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}
