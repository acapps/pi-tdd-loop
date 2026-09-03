// --- Git workflow ---
// Opt-in branch lifecycle for /loop --branch: create a branch off the
// mainline before Phase 0, merge it back when the loop completes.
//
// Design constraints (negotiated plan):
//   - Opt-in: no --branch flag → zero git side effects.
//   - Single conflict attempt: the Writer gets exactly one turn to resolve
//     merge conflicts. If it fails, escalate to the human. No retry loops.
//   - Clean tree guard: refuse to start on a dirty working tree.
//   - State persistence: the branch is recorded in LoopState.branch so
//     /loop-continue and /loop-restart do not re-branch.

import { execFile } from "node:child_process";
import type { LanguageKey } from "./types";

// --- Types ---

export interface BranchInfo {
  name: string;
  base: string;
  merged: boolean;
}

export type GitSetupOutcome =
  | { kind: "ok"; branch: BranchInfo }
  | { kind: "error"; error: string };

export type GitMergeOutcome =
  | { kind: "merged" }
  | { kind: "conflict"; files: string[] }
  | { kind: "error"; error: string };

// --- Pure helpers ---

/**
 * Derive the default branch name from the spec path:
 * `loop/<slug>` where slug is the spec filename without extension,
 * lowercased, with non-alphanumeric runs collapsed to `-`.
 */
export function branchNameFromSpec(specPath: string): string {
  const base = specPath.split(/[\\/]/).pop() ?? "spec";
  const noExt = base.replace(/\.[^.]+$/, "");
  const slug = noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "spec";
  return `loop/${slug}`;
}

/**
 * Parse `git diff --name-only --diff-filter=U` output into a list of
 * conflicted file paths (empty lines dropped).
 */
export function parseConflictedFiles(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Build the one-shot conflict-resolution prompt for the Writer.
 * Pinned verbatim: the Writer gets exactly one turn; a second conflict
 * escalates to the human, so the prompt must say so explicitly.
 */
export function promptMergeConflict(files: string[]): string {
  const fileList = files.length > 0 ? files.map((f) => `  - ${f}`).join("\n") : "  (no file list available)";
  return [
    "Merge conflict — single resolution attempt",
    "",
    "The loop's feature branch is being merged back into the mainline and",
    "git reported conflicts. You have exactly ONE turn to resolve them.",
    "If the merge still fails after your fix, the loop escalates to the",
    "human — do not attempt a second resolution.",
    "",
    "Conflicted files:",
    fileList,
    "",
    "Steps:",
    "  1. Inspect each conflicted file (`git diff --name-only --diff-filter=U`),",
    "     resolve the conflicts, and `git add` the resolved files.",
    "  2. Run the project's test suite and make sure it passes.",
    "  3. Finish the merge: `git commit` (no message needed — git uses the",
    "     default merge message).",
    "",
    "Do not push, do not create new branches, do not revert the merge.",
  ].join("\n");
}

// --- Process runner ---

interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // The cwd option is passed as the 3rd arg (object form) so callers can
    // run git in the project directory; maxBuffer is raised for verbose output.
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          ok: false,
          exitCode: typeof code === "number" ? code : 1,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
        return;
      }
      resolve({ ok: true, exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

// --- Mainline resolution ---

/**
 * Resolve the mainline branch name: `origin/HEAD` → `main` → `master`.
 * Returns null when the project is not a git repository.
 */
export async function resolveMainline(cwd: string): Promise<string | null> {
  // origin/HEAD → e.g. "origin/main" (strip the remote prefix)
  const ohead = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (ohead.ok) {
    const ref = ohead.stdout.trim(); // e.g. "refs/remotes/origin/main"
    const name = ref.replace(/^refs\/remotes\/origin\//, "");
    if (name) return name;
  }
  for (const candidate of ["main", "master"]) {
    const check = await git(["rev-parse", "--verify", `refs/heads/${candidate}`], cwd);
    if (check.ok) return candidate;
  }
  return null;
}

// --- Setup (called from /loop --branch, before Phase 0) ---

/**
 * Create the feature branch off the mainline.
 *
 * Guards:
 *   - not a git repo → error
 *   - dirty working tree → error (refuse to start)
 *   - branch already exists → error (ambiguous state; user must clean up)
 *
 * On success the process is left ON the new branch.
 */
export async function setupBranch(cwd: string, specPath: string, name?: string): Promise<GitSetupOutcome> {
  const base = await resolveMainline(cwd);
  if (base === null) {
    return { kind: "error", error: "not a git repository (or no mainline branch found)" };
  }

  const status = await git(["status", "--porcelain"], cwd);
  if (!status.ok) {
    return { kind: "error", error: `git status failed: ${status.stderr.trim()}` };
  }
  if (status.stdout.trim().length > 0) {
    return {
      kind: "error",
      error: "working tree is dirty — commit or stash changes before /loop --branch",
    };
  }

  const branchName = name ?? branchNameFromSpec(specPath);

  const exists = await git(["rev-parse", "--verify", `refs/heads/${branchName}`], cwd);
  if (exists.ok) {
    return {
      kind: "error",
      error: `branch '${branchName}' already exists — delete it or pass --branch <name>`,
    };
  }

  const create = await git(["checkout", "-b", branchName, base], cwd);
  if (!create.ok) {
    return { kind: "error", error: `git checkout -b failed: ${create.stderr.trim()}` };
  }

  return { kind: "ok", branch: { name: branchName, base, merged: false } };
}

// --- Merge (called from the done effect, at loop completion) ---

/**
 * Commit any uncommitted work on the feature branch, then merge the
 * feature branch into the mainline.
 *
 * Outcomes:
 *   - "merged"   — clean merge; the process is left on the mainline.
 *   - "conflict" — the merge stopped on conflicts; the process is left on
 *                  the mainline with the merge in progress (MERGE_HEAD set).
 *                  The caller prompts the Writer for a single resolution
 *                  attempt.
 *   - "error"    — git could not run the merge (not a repo, no branch, etc.)
 */
export async function commitAndMerge(
  cwd: string,
  branch: BranchInfo,
  language: LanguageKey,
): Promise<GitMergeOutcome> {
  void language; // reserved: a future per-language pre-merge hook (e.g. go vet)

  // 1. Commit any uncommitted work on the feature branch.
  const status = await git(["status", "--porcelain"], cwd);
  if (status.stdout.trim().length > 0) {
    const add = await git(["add", "-A"], cwd);
    if (!add.ok) return { kind: "error", error: `git add failed: ${add.stderr.trim()}` };
    const commit = await git(
      ["commit", "-m", `loop: ${branch.name} — final changes`],
      cwd,
    );
    if (!commit.ok) return { kind: "error", error: `git commit failed: ${commit.stderr.trim()}` };
  }

  // 2. Switch to the mainline and merge the feature branch.
  const checkout = await git(["checkout", branch.base], cwd);
  if (!checkout.ok) {
    return { kind: "error", error: `git checkout ${branch.base} failed: ${checkout.stderr.trim()}` };
  }

  const merge = await git(["merge", "--no-ff", branch.name], cwd);
  if (merge.ok) {
    return { kind: "merged" };
  }

  const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
  const files = parseConflictedFiles(conflicted.stdout);
  return { kind: "conflict", files };
}

/**
 * After the Writer's single conflict-resolution attempt: check whether the
 * merge is complete. Called from the settle handler when the loop is in the
 * post-merge-conflict state.
 *
 *   - merge complete (MERGE_HEAD gone, tree clean) → "merged"
 *   - merge still in progress → "conflict" again → the caller escalates
 *     (the single attempt is spent; no second turn)
 */
export async function verifyMergeComplete(cwd: string): Promise<GitMergeOutcome> {
  const head = await git(["rev-parse", "--verify", "MERGE_HEAD"], cwd);
  if (head.ok) {
    // Merge still in progress.
    const conflicted = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
    const files = parseConflictedFiles(conflicted.stdout);
    return { kind: "conflict", files };
  }
  const status = await git(["status", "--porcelain"], cwd);
  if (!status.ok) {
    return { kind: "error", error: `git status failed: ${status.stderr.trim()}` };
  }
  if (status.stdout.trim().length > 0) {
    return { kind: "error", error: "working tree is dirty after merge — resolve manually" };
  }
  return { kind: "merged" };
}
