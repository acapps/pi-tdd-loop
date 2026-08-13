// --- Selector utilities ---

import type { LoopState } from "./types";

// --- Format status for UI ---

export function formatStatus(state: LoopState): string {
  const phase = state.phase as string;
  const round = state.round;
  const dispute = state.disputeCount;
  const coverage = state.coverageThreshold;

  return `Phase ${phase} — round ${round}${dispute > 0 ? `, disputes: ${dispute}` : ""}. Coverage threshold: ${coverage}%`;
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

  for (const part of parts) {
    if (part.startsWith("--coverage=")) {
      coverage = parseInt(part.split("=")[1], 10);
    } else if (part.startsWith("--language=")) {
      language = part.split("=")[1];
    } else if (!part.startsWith("--")) {
      specPath = part;
    }
  }

  return { specPath, coverage, language };
}
