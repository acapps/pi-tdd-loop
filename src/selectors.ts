// --- Selector utilities ---

import { formatFailures } from "./gates";
import type { LoopState } from "./types";

// --- Format status for UI ---

export function formatStatus(state: LoopState): string {
  const phase = state.phase as string;
  const round = state.round;
  const parts: string[] = [];

  parts.push(`Phase: ${phase}, round ${round}`);

  if (state.branch) {
    const b = state.branch;
    parts.push(`Branch: ${b.name} (off ${b.base}) — ${b.merged ? "merged" : "unmerged"}`);
  }

  if (state.lastGateResult) {
    parts.push("");
    parts.push(...formatGateLines(state.lastGateResult, state.coverageThreshold));
  } else {
    parts.push("");
    parts.push("  (no gate data)");
  }

  return parts.join("\n");
}

function formatGateLines(
  g: NonNullable<LoopState["lastGateResult"]>,
  threshold: number,
): string[] {
  const lines: string[] = [];
  lines.push(`  compile: ${g.compile ? "✓" : "✗"}`);
  lines.push(`  allPassed: ${g.allPassed ? "✓" : `✗ (${g.failures.length} failures)`}`);

  if (g.failures.length > 0) {
    const maxShow = 5;
    lines.push(formatFailures(g.failures.slice(0, maxShow)));
    if (g.failures.length > maxShow) {
      lines.push(`  ... and ${g.failures.length - maxShow} more`);
    }
  }

  if (g.coverage > 0) {
    lines.push(`  coverage: ${g.coverage}% (threshold: ${threshold}%)`);
  }
  return lines;
}

// --- Parse /loop arguments ---

export interface LoopArgs {
  specPath: string;
  coverage?: number;
  language?: string;
  branch?: string;
}

export function parseLoopArgs(args: string): LoopArgs {
  const parts = args.trim().split(/\s+/);
  const flags: Record<string, string | undefined> = {};
  const positional: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--coverage" && i + 1 < parts.length) {
      flags.coverage = parts[++i];
    } else if (part.startsWith("--coverage=")) {
      flags.coverage = part.split("=")[1];
    } else if (part === "--language" && i + 1 < parts.length) {
      flags.language = parts[++i];
    } else if (part.startsWith("--language=")) {
      flags.language = part.split("=")[1];
    } else if (part === "--branch" && i + 1 < parts.length) {
      flags.branch = parts[++i];
    } else if (part.startsWith("--branch=")) {
      flags.branch = part.split("=").slice(1).join("=");
    } else if (!part.startsWith("--")) {
      positional.push(part);
    }
  }

  return {
    specPath: normalizeSpecPath(positional[0] ?? ""),
    coverage: flags.coverage !== undefined ? parseFloat(flags.coverage) : undefined,
    language: flags.language,
    branch: flags.branch,
  };
}

// Strips the pi path prefix (@) and expands a leading tilde (~) to the
// home directory.
function normalizeSpecPath(specPath: string): string {
  if (specPath.startsWith("@")) {
    specPath = specPath.slice(1);
  }
  if (specPath.startsWith("~")) {
    const os = require("node:os");
    specPath = specPath.replace("~", os.homedir());
  }
  return specPath;
}
