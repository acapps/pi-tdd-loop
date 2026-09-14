// --- Selector utilities ---

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
  timeout?: number;
  autoApprove?: boolean;
  maxA?: number;
  maxNegotiate?: number;
  maxB?: number;
  maxC?: number;
  maxDispute?: number;
  maxTurnsPerPhase?: number;
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
    } else if (part === "--timeout" && i + 1 < parts.length) {
      flags.timeout = parts[++i];
    } else if (part.startsWith("--timeout=")) {
      flags.timeout = part.split("=")[1];
    } else if (part === "--no-auto-approve") {
      flags.noAutoApprove = "true";
    } else if (!part.startsWith("--")) {
      positional.push(part);
    }
  }

  return {
    specPath: normalizeSpecPath(positional[0] ?? ""),
    coverage: flags.coverage !== undefined ? parseFloat(flags.coverage) : undefined,
    language: flags.language,
    branch: flags.branch,
    timeout: flags.timeout !== undefined ? parseInt(flags.timeout, 10) : undefined,
    autoApprove: flags.noAutoApprove === "true" ? false : true,
  };
}

// Strips the pi path prefix (@) and expands a leading tilde (~) to the
// home directory.
export function normalizeSpecPath(specPath: string): string {
  if (specPath.startsWith("@")) {
    specPath = specPath.slice(1);
  }
  if (specPath.startsWith("~")) {
    const os = require("node:os");
    specPath = specPath.replace("~", os.homedir());
  }
  return specPath;
}

// --- Config file support ---

/**
 * Load loop config from `loop.config.json` or `.pi/loop.config.json`.
 * Returns {} if the file doesn't exist or is invalid.
 */
export function loadLoopConfig(cwd: string): Partial<LoopArgs> {
  const candidates = [
    join(cwd, "loop.config.json"),
    join(cwd, ".pi", "loop.config.json"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.warn(`loop.config.json: expected an object — using defaults`);
        return {};
      }
      // Filter to known fields with correct types
      const result: Partial<LoopArgs> = {};
      if (typeof parsed.coverage === "number") result.coverage = parsed.coverage;
      if (typeof parsed.language === "string") result.language = parsed.language;
      if (typeof parsed.timeout === "number") result.timeout = parsed.timeout;
      if (typeof parsed.autoApprove === "boolean") result.autoApprove = parsed.autoApprove;
      if (typeof parsed.branch === "string" || parsed.branch === true) result.branch = parsed.branch === true ? "" : parsed.branch;
      if (typeof parsed.maxA === "number") result.maxA = parsed.maxA;
      if (typeof parsed.maxNegotiate === "number") result.maxNegotiate = parsed.maxNegotiate;
      if (typeof parsed.maxB === "number") result.maxB = parsed.maxB;
      if (typeof parsed.maxC === "number") result.maxC = parsed.maxC;
      if (typeof parsed.maxDispute === "number") result.maxDispute = parsed.maxDispute;
      if (typeof parsed.maxTurnsPerPhase === "number") result.maxTurnsPerPhase = parsed.maxTurnsPerPhase;
      return result;
    } catch {
      console.warn(`loop.config.json: invalid JSON — using defaults`);
      return {};
    }
  }

  return {};
}

/**
 * Merge CLI args with config file values. CLI wins over config.
 * A CLI value of `undefined` means "not specified" → use config.
 */
export function mergeLoopArgs(cli: LoopArgs, config: Partial<LoopArgs>): LoopArgs {
  return {
    specPath: cli.specPath,
    coverage: cli.coverage !== undefined ? cli.coverage : config.coverage,
    language: cli.language !== undefined ? cli.language : config.language,
    branch: cli.branch !== undefined ? cli.branch : config.branch,
    timeout: cli.timeout !== undefined ? cli.timeout : config.timeout,
    autoApprove: cli.autoApprove !== undefined ? cli.autoApprove : config.autoApprove,
    maxA: cli.maxA !== undefined ? cli.maxA : config.maxA,
    maxNegotiate: cli.maxNegotiate !== undefined ? cli.maxNegotiate : config.maxNegotiate,
    maxB: cli.maxB !== undefined ? cli.maxB : config.maxB,
    maxC: cli.maxC !== undefined ? cli.maxC : config.maxC,
    maxDispute: cli.maxDispute !== undefined ? cli.maxDispute : config.maxDispute,
    maxTurnsPerPhase: cli.maxTurnsPerPhase !== undefined ? cli.maxTurnsPerPhase : config.maxTurnsPerPhase,
  };
}
