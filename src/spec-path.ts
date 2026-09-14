// --- Spec path resolution ---
// Shared by the commands that take a spec path (/loop, /loop-patch,
// /loop-decompose): resolve against the cwd and check existence in one place.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve a (possibly relative) spec path against the cwd and check that it
 * exists. Returns the absolute path, or null when the file is missing.
 */
export function resolveExistingSpec(specPath: string, cwd: string): string | null {
  const full = resolve(cwd, specPath);
  return existsSync(full) ? full : null;
}
