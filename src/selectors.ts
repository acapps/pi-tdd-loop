// --- Selector utilities ---

import { formatFailures } from "./gates";
import type { LoopState } from "./types";

// --- Format status for UI ---

export function formatStatus(state: LoopState): string {
  const phase = state.phase as string;
  const round = state.round;
  const parts: string[] = [];

  parts.push(`Phase: ${phase}, round ${round}`);

  if (state.lastGateResult) {
    const g = state.lastGateResult;
    parts.push("");
    parts.push(`  compile: ${g.compile ? "✓" : "✗"}`);
    parts.push(`  tests: ${g.tests ? "✓" : `✗ (${g.failures.length} failures)`}`);

    if (g.failures.length > 0) {
      const maxShow = 5;
      const shown = g.failures.slice(0, maxShow);
      const failuresText = formatFailures(shown);
      parts.push(failuresText);
      if (g.failures.length > maxShow) {
        parts.push(`  ... and ${g.failures.length - maxShow} more`);
      }
    }

    if (g.coverage > 0) {
      parts.push(`  coverage: ${g.coverage}% (threshold: ${state.coverageThreshold}%)`);
    }
  } else {
    parts.push("");
    parts.push("  (no gate data)");
  }

  return parts.join("\n");
}

// --- Parse /loop arguments ---

export interface LoopArgs {
  specPath: string;
  coverage?: number;
  language?: string;
}

export function parseLoopArgs(args: string): LoopArgs {
  const parts = args.trim().split(/\s+/);
  let specPath = "";
  let coverage: number | undefined;
  let language: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--coverage" && i + 1 < parts.length) {
      coverage = parseFloat(parts[++i]);
    } else if (part.startsWith("--coverage=")) {
      coverage = parseFloat(part.split("=")[1]);
    } else if (part === "--language" && i + 1 < parts.length) {
      language = parts[++i];
    } else if (part.startsWith("--language=")) {
      language = part.split("=")[1];
    } else if (!part.startsWith("--")) {
      if (!specPath) {
        specPath = part;
      }
    }
  }

  // Strip pi path prefix (@) if present
  if (specPath.startsWith("@")) {
    specPath = specPath.slice(1);
  }

  // Expand tilde (~) to home directory
  if (specPath.startsWith("~")) {
    const os = require("node:os");
    specPath = specPath.replace("~", os.homedir());
  }

  return { specPath, coverage, language };
}
