// --- /spec file I/O (src/spec-command.ts split, step 3) ---

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readSpec } from "./reviewer";

/**
 * Normalize the output directory for display and prompt paths.
 * Pinned: "internal/" → "internal"; "internal" → "internal";
 * "backlog/" → "backlog"; "" → "".
 * (The default outDir "internal/" would otherwise render as "internal//slug.md".)
 */
export function normalizeOutDir(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/**
 * Resolve the goal argument to text.
 * "" → "" (verbatim, pinned). Goal starting with "@" (strip one leading @)
 * or an existing path (same resolution order as readSpec: absolute as-is,
 * relative against cwd, then process cwd) is read as a file. Otherwise the
 * goal is returned verbatim. Returns null when a referenced file is missing.
 */
export function resolveGoal(goalArg: string, cwd: string): string | null {
  if (goalArg === "") return "";

  const file = findGoalFile(goalArg, cwd);
  if (file === null) return goalArg;
  return readSpec(file);
}

/**
 * Locate the file a goal references, or null when the goal is plain text.
 * "@x" → "x" (referenced unconditionally); otherwise an existing path —
 * raw first, then resolved against cwd (readSpec re-probes the process
 * cwd as a final fallback).
 */
function findGoalFile(goalArg: string, cwd: string): string | null {
  if (goalArg.startsWith("@")) return goalArg.slice(1);
  if (existsSync(goalArg)) return goalArg;
  const underCwd = resolve(cwd, goalArg);
  if (existsSync(underCwd)) return underCwd;
  return null;
}

/** readSpec("docs/spec-authoring.md", cwd); null when the file is missing. */
export function readRubric(cwd: string): string | null {
  return readSpec("docs/spec-authoring.md", cwd);
}
