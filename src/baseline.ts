// --- Phase 0: Baseline check ---
// Before the loop starts, the project's existing test suite must be green
// (or the project must have no tests yet). On a red baseline the loop's
// Phase B gate (all tests pass) would be blamed for pre-existing failures,
// so /loop refuses to start and state stays idle.

import { execSync } from "node:child_process";
import { parseTestOutput, formatFailures } from "./gates";
import { validateTestRunner } from "./reviewer";
import type { LanguageKey, BuildTool, FailingTest } from "./types";

export interface BaselineResult {
  /** true when the existing suite is green (or there are no tests yet). */
  ok: boolean;
  /** true when the project has no test files — a valid, trivially-green baseline. */
  noTests: boolean;
  /** Parsed failing tests (empty when ok, or when the parser found nothing). */
  failures: FailingTest[];
  /** Raw command output (fallback signal when the parser finds nothing). */
  output: string;
}

// A cold maven build can take minutes; the baseline runs once per /loop.
const BASELINE_TIMEOUT_MS = 300000;

/**
 * Phase 0 baseline gate: verify the test runner exists, then run the
 * project's existing test suite and classify the result.
 */
export function runBaseline(
  cwd: string,
  language: LanguageKey,
  buildTool: BuildTool,
): BaselineResult {
  const runnerCheck = validateTestRunner(cwd, language);
  if (!runnerCheck.ok) {
    return {
      ok: false,
      noTests: false,
      failures: [],
      output: `test runner not available: ${runnerCheck.error}`,
    };
  }
  return runBaselineTests(cwd, language, buildTool);
}

/**
 * Run the project's existing test suite and classify the result.
 *
 * The exit code is the gate signal (raw signals, no summarization);
 * parsed failures are for display only.
 */
export function runBaselineTests(
  cwd: string,
  language: LanguageKey,
  buildTool: BuildTool,
): BaselineResult {
  const cmd = getBaselineCommand(language, buildTool);
  let exitOk = true;
  let output = "";
  try {
    output = execSync(cmd, {
      cwd,
      timeout: BASELINE_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err: any) {
    exitOk = false;
    output = [err.stdout, err.stderr, err.message]
      .filter(Boolean)
      .join("\n");
  }
  return evaluateBaseline(output, language, exitOk);
}

/**
 * Pure: classify raw test output plus exit status into a BaselineResult.
 * Kept separate from runBaselineTests so it can be unit-tested without
 * spawning processes.
 */
export function evaluateBaseline(
  output: string,
  language: LanguageKey,
  exitOk: boolean,
): BaselineResult {
  // "No tests yet" is a valid baseline — greenfield projects must be able
  // to run /loop. Checked before the exit code because vitest exits 1 when
  // no test files exist.
  if (detectNoTests(output, language, exitOk)) {
    return { ok: true, noTests: true, failures: [], output };
  }
  if (exitOk) {
    return { ok: true, noTests: false, failures: [], output };
  }
  const failures = parseTestOutput(output, language).failures;
  return { ok: false, noTests: false, failures, output };
}

function getBaselineCommand(language: LanguageKey, buildTool: BuildTool): string {
  switch (language) {
    case "go": return "go test -json ./...";
    case "java": return buildTool === "gradle" ? "gradle test 2>&1" : "mvn test 2>&1";
    case "typescript": return "npx vitest run 2>&1";
    default: return "echo unknown";
  }
}

function detectNoTests(output: string, language: LanguageKey, exitOk: boolean): boolean {
  switch (language) {
    // Go: "run" JSON events are only emitted when a test actually executed.
    // Restricted to exit 0 so a build failure in one package is not masked
    // by "[no test files]" lines from other packages. Cached results emit
    // no events, so also require the no-test marker to be present.
    case "go":
      return exitOk && /\[no test files\]/.test(output) && !/"Action":"(run|pass)"/.test(output);
    // Maven: "No tests to run." on a successful build.
    case "java":
      return exitOk && /no tests to run/i.test(output);
    // vitest: "No test files found, exiting with code 1" — a non-zero exit
    // that must still count as a valid (empty) baseline.
    case "typescript":
      return /no test files found/i.test(output);
    default:
      return false;
  }
}

/**
 * Human-readable failure detail for the /loop refusal message:
 * parsed failures when the parser found some, otherwise a tail of the raw
 * output (e.g. build errors), so the user always sees a raw signal.
 */
export function formatBaselineFailure(result: BaselineResult): string {
  if (result.failures.length > 0) {
    return formatFailures(result.failures);
  }
  const tail = result.output.trim().slice(-1500);
  return tail || "(no output captured)";
}
