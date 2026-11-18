// --- Phase 0: spec file I/O + runner pre-flight check (src/reviewer.ts split, step 1) ---

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageKey } from "../types";
import { execSync } from "node:child_process";
import { execErrorMessage } from "../exec-error";

/**
 * Read the spec file at the given path.
 * Absolute paths are used as-is.
 * Relative paths: if baseDir is given, resolve against baseDir first.
 * Falls back to process CWD if not found.
 * Returns the text content or null if the file does not exist.
 */
export function readSpec(specPath: string, baseDir?: string): string | null {
  try {
    // Absolute paths: use directly
    if (specPath.startsWith("/")) {
      if (!existsSync(specPath)) return null;
      return readFileSync(specPath, "utf-8");
    }
    // Relative path: prefer baseDir if provided
    if (baseDir) {
      const fullPath = resolve(baseDir, specPath);
      if (existsSync(fullPath)) {
        return readFileSync(fullPath, "utf-8");
      }
    }
    // Fallback: process CWD
    if (existsSync(specPath)) {
      return readFileSync(specPath, "utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate that the test runner can execute in the project directory.
 * Returns { ok: true } if the runner is available, or { ok: false, error } if not.
 * This is a pre-flight check for blank projects.
 */
export function validateTestRunner(
  cwd: string,
  language: LanguageKey,
): { ok: boolean; error?: string } {
  const cmd = getRunnerValidationCommand(language);
  try {
    execSync(cmd, { cwd, timeout: 15000, stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: execErrorMessage(err) };
  }
}

function getRunnerValidationCommand(language: LanguageKey): string {
  switch (language) {
    case "go": return "go version && go env GOROOT";
    case "java": return "mvn --version || gradle --version || echo java-missing";
    case "typescript": return "npx vitest --version || npx tsc --version || echo ts-missing";
    default: return "echo unknown";
  }
}
