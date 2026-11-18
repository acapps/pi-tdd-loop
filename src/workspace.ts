// --- Workspace path helpers (src/types.ts split, step 5) ---
// Pure path logic; re-exported from src/types.ts so existing importers
// ("import { getWorkspaceRoot } from "./types"") are unchanged.

/**
 * True when the spec path points into the golden project directory.
 */
export function isGoldenProject(specPath: string): boolean {
  return specPath.startsWith("test/golden/");
}

/**
 * For golden projects: returns the project directory (parent of spec.md).
 * For self-refactors: returns "." (cwd, no constraint).
 */
export function getWorkspaceRoot(specPath: string): string {
  if (!isGoldenProject(specPath)) return ".";
  const parts = specPath.split("/");
  parts.pop(); // remove "spec.md"
  return parts.join("/");
}

/**
 * Returns true when `path` is within `workspaceRoot`.
 * A path is within the workspace if it starts with the workspace root
 * (as a directory prefix). The workspace root itself is not a valid
 * write target (you write files *under* it).
 */
export function isWorkspacePath(path: string, workspaceRoot: string): boolean {
  if (workspaceRoot === ".") return true; // self-refactor: no constraint
  const normalized = path.startsWith("/") ? path : "/" + path;
  const root = workspaceRoot.startsWith("/") ? workspaceRoot : "/" + workspaceRoot;
  return normalized.startsWith(root + "/");
}
