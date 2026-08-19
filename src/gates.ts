// --- Gates ---
// Phase gate checks: compilation, tests, coverage.
// Spec: internal/bug-gate-signal-integrity.md — exit code is the gate signal;
// parsed failures are display-only; a tool that cannot run is an error.

import { execFile } from "node:child_process";
import type { LanguageKey, BuildTool, Phase, GateResult } from "./types";

export interface GateOutcome {
  kind: "result" | "error";
  result?: GateResult; // present when kind === "result"
  error?: string; // present when kind === "error" — tool could not run
}

// --- Public API (new contract) ---

export async function runGates(
  cwd: string,
  coverageThreshold: number,
  language: LanguageKey,
  buildTool: BuildTool,
  phase: Phase,
): Promise<GateOutcome> {
  void coverageThreshold; // the threshold is a transition concern (T2), not a signal concern
  const result: GateResult = {
    compile: false,
    compileError: "",
    tests: false,
    allPassed: false,
    coverage: 0,
    failures: [],
  };

  // 1. Compile check (execFile-based; a spawn error is a gate error, never a pass)
  const compile = await execCommand(getCompileCommand(language, buildTool), cwd, 30_000);
  if (compile.kind === "error") return { kind: "error", error: compile.error };
  if (compile.exitCode !== 0) {
    result.compileError = compile.stderr || compile.stdout || "(no output captured)";
    return { kind: "result", result };
  }
  result.compile = true;

  // 2. Test check — the exit code is the signal; parsed failures are display-only.
  const test = await execCommand(getTestCommand(language, buildTool), cwd, 60_000);
  if (test.kind === "error") return { kind: "error", error: test.error };

  const output = (test.stdout ?? "") + (test.stderr ?? "");
  const parsed = parseTestOutput(output, language);
  result.tests = test.exitCode === 0;
  result.allPassed = test.exitCode === 0;
  result.failures = parsed.failures;

  // 3. Coverage sub-check (B/C only, and only on an exit-0 run — row-ordering pin:
  // a red run never reports a coverage number).
  if (test.exitCode === 0 && (phase === "B" || phase === "C")) {
    const coverage = parseCoverage(output, language);
    if (coverage !== null) result.coverage = coverage;
  }

  return { kind: "result", result };
}

// --- Compile / test commands ---

function getCompileCommand(language: LanguageKey, buildTool: BuildTool): string {
  switch (language) {
    case "go": return "go build ./...";
    case "java": return buildTool === "gradle" ? "gradle compileJava" : "mvn compile -q";
    case "typescript": return "npx tsc --noEmit";
    default: return "echo unknown";
  }
}

// Pure parser: one attempt per language, last match wins, finite values in
// [0, 100] only; null when nothing matches (unavailable → skip, never 0).
export function parseCoverage(output: string, language: LanguageKey): number | null {
  let pattern: RegExp;
  switch (language) {
    case "go":
      pattern = /coverage:\s+(\d+(?:\.\d+)?)%\s+of\s+statements/;
      break;
    case "java":
      // JaCoCo summary line (maven and gradle emit the same table shape).
      pattern = /Total,\s+\d+(?:\s*,\s*\d+)*,\s*(\d+(?:\.\d+)?)%/;
      break;
    case "typescript":
      // vitest coverage table: All files | <lines> | <% Coverage> | ...
      pattern = /All files\s*\|\s*\d+\s*\|\s*(\d+(?:\.\d+)?)/;
      break;
    default:
      return null;
  }
  let value: number | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const candidate = Number(match[1]);
    if (Number.isFinite(candidate) && candidate >= 0 && candidate <= 100) {
      value = candidate; // last match wins
    }
  }
  return value;
}

// Single-invocation test command (B/C): yields both signal and coverage.
// No `|| true` / `|| echo` fallbacks.
export function getTestCommand(language: LanguageKey, buildTool?: BuildTool): string {
  switch (language) {
    case "go": return "go test -json -cover ./...";
    case "java": return buildTool === "gradle" ? "gradle test" : "mvn test -Djacoco.skip=false";
    case "typescript": return "npx vitest run --coverage";
    default: return "echo unknown";
  }
}

// --- Process runner ---
// execFile does not go through a shell, so the command string is the binary
// and the remainder are its arguments. A spawn failure (ENOENT, bad cwd,
// timeout) is a gate error — never a fabricated GateResult.

interface ExecOutcome {
  kind: "ok" | "error";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

function execCommand(command: string, cwd: string, timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const [file, ...args] = command.split(/\s+/);
    if (!file) {
      resolve({ kind: "error", error: "empty command" });
      return;
    }
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      // execFile sets `error` for any non-zero exit (with error.code = exit
      // code) and for spawn failures (error.code = 'ENOENT' etc.). A non-
      // numeric code means the tool could not run at all.
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code !== "number") {
          const message = error.message || String(error);
          resolve({ kind: "error", error: message });
          return;
        }
        resolve({ kind: "ok", exitCode: code, stdout: stdout ?? "", stderr: stderr ?? "" });
        return;
      }
      resolve({ kind: "ok", exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

// --- Display-only helpers (kept for existing consumers; signatures unchanged) ---

interface TestResult {
  passed: boolean;
  allPassed: boolean;
  failures: { test: string; subtest: string; output: string }[];
}

export function parseTestOutput(output: string, language: LanguageKey): TestResult {
  const failures: { test: string; subtest: string; output: string }[] = [];

  // Go JSON output
  if (language === "go") {
    const lines = output.trim().split("\n");
    let currentTest = "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.Action === "run" && parsed.Test) currentTest = parsed.Test;
        if (parsed.Action === "fail" && parsed.Test && !parsed.Test.startsWith("WARNING")) {
          failures.push({ test: currentTest || parsed.Test, subtest: parsed.Test, output: parsed.Output || "" });
        }
      } catch { /* not JSON */ }
    }
  } else {
    // Generic: line-anchored "FAIL <id>" entries (vitest: "FAIL  test/x.test.ts > …",
    // maven-style: "FAIL com.example.MyTest"). Passing verbose lines embed
    // "FAIL" mid-line after "✓ … > " and must not count.
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*FAIL\s+([\w/.+-]+)/);
      if (match) failures.push({ test: `FAIL ${match[1]}`, subtest: "", output: "" });
    }
  }

  const allPassed = failures.length === 0;
  return { passed: allPassed, allPassed, failures };
}

export function formatFailures(failures: { test: string; subtest: string; output: string }[]): string {
  if (failures.length === 0) return "(unknown failures)";

  // Deduplicate by test/subtest pair (last entry wins)
  const seen = new Map<string, { test: string; subtest: string; output: string }>();
  for (const f of failures) {
    const key = f.subtest ? `${f.test}/${f.subtest}` : f.test;
    seen.set(key, f);
  }

  return Array.from(seen.values()).map(f => {
    const name = f.subtest ? `${f.test}/${f.subtest}` : f.test;
    const output = f.output.length > 1000 ? f.output.slice(0, 1000) + "... (truncated)" : f.output;
    return `  - ${name}\n${output.trim()}`;
  }).join("\n");
}
