// --- Selector utilities ---

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatFailures } from "./gates";
import { parseTokens } from "./args";
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
  const { flags, positional } = parseTokens(args, new Set(["no-auto-approve"]));

  return {
    specPath: normalizeSpecPath(positional[0] ?? ""),
    coverage: flags.get("coverage") !== undefined ? parseFloat(flags.get("coverage")!) : undefined,
    language: flags.get("language"),
    branch: flags.has("branch") ? (flags.get("branch") ?? "") : undefined,
    timeout: flags.get("timeout") !== undefined ? parseInt(flags.get("timeout")!, 10) : undefined,
    autoApprove: flags.has("no-auto-approve") ? false : true,
  };
}

// Strips the pi path prefix (@) and expands a leading tilde (~) to the
// home directory.
export function normalizeSpecPath(specPath: string): string {
  if (specPath.startsWith("@")) {
    specPath = specPath.slice(1);
  }
  if (specPath.startsWith("~")) {
    specPath = specPath.replace("~", homedir());
  }
  return specPath;
}

// --- Config file support ---

/**
 * Load loop config from `loop.config.json` or `.pi/loop.config.json`.
 * Returns {} if the file doesn't exist or is invalid.
 */
export interface LoopConfigResult {
  args: Partial<LoopArgs>;
  warnings: string[];
}

export function loadLoopConfig(cwd: string): LoopConfigResult {
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
        return { args: {}, warnings: ["loop.config.json: expected an object — using defaults"] };
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
      return { args: result, warnings: [] };
    } catch {
      return { args: {}, warnings: ["loop.config.json: invalid JSON — using defaults"] };
    }
  }

  return { args: {}, warnings: [] };
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
