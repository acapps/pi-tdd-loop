// Phase 0 git state check — verify the working tree is clean before the loop
// starts, and report any non-test files that are dirty.
//
// Rationale (internal/ruleset-role-compliance.md): the loop's phase gates
// assume a clean starting state. If files are dirty before Phase 0, the
// scope-check at phase boundaries will flag them as out-of-scope, and the
// agent may try to "fix" them via bash, bypassing the gates.

import { execSync } from "node:child_process";
import type { LanguageKey } from "./types";
import { getLanguageConfig } from "./languages";

/**
 * Get the list of new or modified test files in the working tree.
 * Uses git to find modified + untracked files, then filters by the
 * language's test file pattern.
 *
 * Returns null when git is unavailable (not a git repo, git not installed)
 * so the caller can distinguish "no new tests" from "unknown".
 */
export function getNewTestFiles(cwd: string, language: LanguageKey): string[] | null {
  const lang = getLanguageConfig(language);
  const all = new Set<string>();
  let gitAvailable = false;

  try {
    const modified = execSync("git diff --name-only HEAD", {
      cwd, timeout: 10000, stdio: "pipe",
    }).toString().trim().split("\n").filter(Boolean);
    for (const f of modified) all.add(f);
    gitAvailable = true;
  } catch { /* not a git repo */ }

  try {
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd, timeout: 10000, stdio: "pipe",
    }).toString().trim().split("\n").filter(Boolean);
    for (const f of untracked) all.add(f);
    gitAvailable = true;
  } catch { /* not a git repo */ }

  if (!gitAvailable) return null;
  return [...all].filter(f => lang.isTestFile(f));
}

export interface GitStateReport {
  clean: boolean;
  dirtyFiles: string[];
  nonTestFiles: string[];
  untrackedFiles: string[];
  message: string;
}

/**
 * Check the git working tree state. Returns a report with dirty files,
 * separated into test files and non-test files.
 *
 * Non-test files in the dirty set are a warning: they suggest prior work
 * that wasn't committed, which will confuse the scope-check and may lead
 * the agent to modify them via bash.
 */
export function checkGitState(cwd: string, language: LanguageKey): GitStateReport {
  const lang = getLanguageConfig(language);

  let dirtyFiles: string[] = [];
  let untrackedFiles: string[] = [];

  try {
    // Modified/staged files
    const modified = execSync("git diff --name-only HEAD", {
      cwd,
      timeout: 10000,
      stdio: "pipe",
    }).toString().trim().split("\n").filter(Boolean);

    // Untracked files
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd,
      timeout: 10000,
      stdio: "pipe",
    }).toString().trim().split("\n").filter(Boolean);

    dirtyFiles = modified;
    untrackedFiles = untracked;
  } catch {
    // Not a git repo, or git not available — treat as clean (don't block)
    return {
      clean: true,
      dirtyFiles: [],
      nonTestFiles: [],
      untrackedFiles: [],
      message: "Git state check skipped (not a git repo or git unavailable).",
    };
  }

  const nonTestFiles = dirtyFiles.filter(f => !lang.isTestFile(f));
  const clean = dirtyFiles.length === 0 && untrackedFiles.length === 0;

  let message: string;
  if (clean) {
    message = "Git state: clean.";
  } else if (nonTestFiles.length > 0) {
    message =
      `Git state: ${dirtyFiles.length} modified, ${untrackedFiles.length} untracked.\n` +
      `WARNING: ${nonTestFiles.length} non-test file(s) are dirty:\n` +
      nonTestFiles.map(f => `  - ${f}`).join("\n") +
      "\nThese files may be flagged by the scope-check at phase boundaries. " +
      "Consider committing or stashing them before the loop starts.";
  } else {
    message = `Git state: ${dirtyFiles.length} modified, ${untrackedFiles.length} untracked (all test files).`;
  }

  return { clean, dirtyFiles, nonTestFiles, untrackedFiles, message };
}
