// --- Graphify integration ---
// Builds/queries knowledge graph of the project for agent context.

import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type DebugFn = (msg: string) => void;

// --- Public API ---

export function ensureGraph(
  cwd: string,
  action: "build" | "update" | "query",
  debug: DebugFn,
): void {
  debug(`graphify: running cd "${cwd}" && graphify`);
  try {
    const output = execSync(
      action === "query" ? "graphify query 'what does this project do?'" : "graphify",
      { cwd, timeout: 30000, encoding: "utf-8", stdio: "pipe" },
    );
    debug(`graphify: success (${output.length} chars output)`);
  } catch (err: any) {
    debug(`graphify: failed (${err.stderr || err.message})`);
  }
}

export function queryGraph(
  cwd: string,
  question: string,
  debug: DebugFn,
): string | null {
  debug(`graphify: query "${question}"`);
  try {
    const output = execSync(
      `graphify query '${question.replace(/'/g, "\\'")}'`,
      { cwd, timeout: 30000, encoding: "utf-8", stdio: "pipe" },
    );
    return output.trim();
  } catch (err: any) {
    debug(`graphify: query failed (${err.stderr || err.message})`);
    return null;
  }
}
