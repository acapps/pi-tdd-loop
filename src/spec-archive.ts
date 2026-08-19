// --- Spec archive ---
// On loop completion, the spec file is renamed with a `done-` prefix so a
// finished spec is visually distinguishable from an open one. Unit is a pure
// function; the caller performs the fs side effects.

import { basename, dirname, extname, join, resolve } from "node:path";

// Sync fs is resolved lazily (inside archiveSpecFile): the pure path function
// must not load node:fs, and lazy resolution keeps failure-path tests free of
// ESM module-mocking (vi.spyOn on node builtins does not work under vitest).
let fsSync: any;
function syncFs(): typeof import("node:fs") {
  if (!fsSync) fsSync = require("node:fs");
  return fsSync;
}

/**
 * Resolve the `done-`-prefixed path for a spec file. Returns null when the
 * spec is already archived (filename starts with `done-`) — the rename is
 * idempotent and must not double-prefix.
 */
export function doneSpecPath(specPath: string, cwd: string): string | null {
  const base = basename(specPath);
  if (base.startsWith("done-")) return null;
  const dir = specPath.includes("/") ? resolve(cwd, dirname(specPath)) : cwd;
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  return join(dir, `done-${stem}${ext}`);
}

/**
 * Perform the rename. Returns the archived path, or null when skipped
 * (already archived, source missing, or target already exists — never
 * overwrites an existing file). Never throws.
 */
export function archiveSpecFile(specPath: string, cwd: string): string | null {
  const fs = syncFs();
  const target = doneSpecPath(specPath, cwd);
  if (target === null) return null;
  const abs = resolve(cwd, specPath);
  if (!fs.existsSync(abs)) return null;
  if (fs.existsSync(target)) return null;
  try {
    fs.renameSync(abs, target);
  } catch {
    return null;
  }
  return target;
}
