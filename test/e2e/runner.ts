// --- E2E Runner ---
// Runs the loop extension against a spec, measures code quality, saves results.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { measureQuality, type QualityScore, type QualityMetrics } from "./quality";
import { computeProcessScore, computeCombinedScore, type ProcessScoreResult } from "./process-score";
import type { LoopMetrics } from "../../src/metrics";
import type { GateScenario } from "../../test/golden/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Expected function names from the spec
const EXPECTED_FUNCTIONS = ["Reverse", "Capitalize", "TrimSpace", "IsPalindrome"];

// Results directory
const RESULTS_DIR = join(__dirname, "results");
const SPEC_DIR = join(__dirname, "specs");

// --- Types ---

export interface Scorecard {
  runId: string;
  label: string;
  timestamp: string;
  spec: string;
  projectDir: string;
  // Two scores
  processScore: number;  // 0-100: loop efficiency
  qualityScore: number;  // 0-100: code quality
  combinedScore: number; // weighted average
  processResult?: ProcessScoreResult;
  qualityResult?: QualityScore;
  // Raw metrics
  loopMetrics?: LoopMetrics;
  codeMetrics?: QualityMetrics;
  passed: boolean;
  note?: string;
}

// --- Public API ---

/**
 * Run the loop extension against a spec and measure the produced code.
 * 
 * This function:
 * 1. Creates a temp Go project
 * 2. Runs `pi /loop <spec>` (requires pi installed)
 * 3. Measures the produced code's quality
 * 4. Computes process score from loop metrics
 * 5. Returns a scorecard with both scores
 * 
 * @param label - Label for this run (e.g., "baseline", "prompt-v2")
 * @param loopMetrics - LoopMetrics from the run (process metrics)
 * @param scenario - The GateScenario that was run
 * @param projectDir - Path to the project with produced code
 * @param note - Optional note about the run
 */
export function runE2eTest(
  label: string,
  loopMetrics: LoopMetrics,
  scenario: GateScenario,
  projectDir: string,
  note?: string,
): Scorecard {
  try {
    // Compute process score from loop metrics
    const processResult = computeProcessScore(loopMetrics, scenario);

    // Measure quality of produced code
    const qualityResult = measureQuality(projectDir, EXPECTED_FUNCTIONS);

    // Combined score
    const combined = computeCombinedScore(processResult.score, qualityResult.score);

    const scorecard = {
      runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      timestamp: new Date().toISOString(),
      spec: "stringutil-spec.md",
      projectDir,
      processScore: processResult.score,
      qualityScore: qualityResult.score,
      combinedScore: combined,
      processResult,
      qualityResult,
      loopMetrics,
      codeMetrics: qualityResult.metrics,
      passed: combined >= 70,
      note,
    };

    saveScorecard(scorecard);
    printReport(scorecard);
    return scorecard;

  } catch (err: any) {
    console.error(`E2E test failed: ${err.message}`);
    return buildErrorScorecard(label, projectDir, err.message);
  }
}

/**
 * Compare two scorecards and report the difference.
 */
export function compareRuns(a: Scorecard, b: Scorecard): string {
  const procDiff = b.processScore - a.processScore;
  const qualDiff = b.qualityScore - a.qualityScore;
  const combinedDiff = b.combinedScore - a.combinedScore;

  return [
    "═══ Comparison ═══",
    `${a.label}: Process ${a.processScore}, Quality ${a.qualityScore}, Combined ${a.combinedScore}`,
    `${b.label}: Process ${b.processScore}, Quality ${b.qualityScore}, Combined ${b.combinedScore}`,
    `Combined change: ${combinedDiff > 0 ? "+" : ""}${combinedDiff}`,
    `Process change: ${procDiff > 0 ? "+" : ""}${procDiff}`,
    `Quality change: ${qualDiff > 0 ? "+" : ""}${qualDiff}`,
  ].join("\n");
}

/**
 * Load a saved scorecard from a file.
 */
export function loadScorecard(filePath: string): Scorecard | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// --- Helpers ---

function createTempProject(): string {
  const os = require("node:os");
  const fs = require("node:fs");
  const tmpdir = fs.mkdtempSync(join(os.tmpdir(), "loop-e2e-"));
  return tmpdir;
}

function printReport(scorecard: Scorecard): void {
  console.log("═══ E2E Scorecard ═══");
  console.log(`Label: ${scorecard.label}`);
  console.log(`Process Score: ${scorecard.processScore}/100`);
  console.log(`Quality Score: ${scorecard.qualityScore}/100`);
  console.log(`Combined:      ${scorecard.combinedScore}/100`);
  console.log("");
  if (scorecard.processResult) {
    console.log("Process details:");
    console.log(`  Final phase: ${scorecard.loopMetrics?.finalPhase || "unknown"}`);
    console.log(`  Gate runs: ${scorecard.loopMetrics?.gateRuns || 0}`);
    console.log(`  Disputes: ${scorecard.loopMetrics?.disputesRaised || 0}`);
  }
  if (scorecard.qualityResult) {
    console.log("");
    console.log(scorecard.qualityResult.report);
  }
  if (scorecard.note) {
    console.log(`\nNote: ${scorecard.note}`);
  }
}

function buildErrorScorecard(
  label: string,
  projectDir: string,
  error: string,
): Scorecard {
  return {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    timestamp: new Date().toISOString(),
    spec: "stringutil-spec.md",
    projectDir,
    processScore: 0,
    qualityScore: 0,
    combinedScore: 0,
    passed: false,
    note: `Error: ${error}`,
  };
}

function saveScorecard(scorecard: Scorecard): void {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const ts = scorecard.timestamp.replace(/[:.]/g, "-");
  const filename = `${scorecard.label}_${ts}.json`;
  // Remove projectDir from saved scorecard (it's a temp dir)
  const saved = { ...scorecard, projectDir: "(temp dir)" };
  writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(saved, null, 2), "utf-8");
}
