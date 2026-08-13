// --- Gates ---
// Phase gate checks: compilation, tests, coverage.

import { execSync } from "node:child_process";
import type { LanguageKey, BuildTool, Phase, GateResult } from "./types";

// --- Public API ---

export function runGates(
  cwd: string,
  coverageThreshold: number,
  language: LanguageKey,
  buildTool: BuildTool,
  phase: Phase,
): GateResult {
  const result: GateResult = {
    compile: false,
    compileError: "",
    tests: false,
    allPassed: false,
    coverage: 0,
    failures: [],
  };

  // 1. Compile check
  result.compile = checkCompile(cwd, language, buildTool, result);

  if (!result.compile) return result;

  // 2. Test check
  const testResult = runTests(cwd, language, result);
  result.tests = testResult.passed;
  result.allPassed = testResult.allPassed;
  result.failures = testResult.failures;

  if (phase === "A") return result; // Phase A only checks compile + basic tests

  // 3. Coverage check (Phase B/C)
  result.coverage = checkCoverage(cwd, language, coverageThreshold);

  return result;
}

// --- Compile Check ---

function checkCompile(cwd: string, language: LanguageKey, buildTool: BuildTool, result: GateResult): boolean {
  const cmd = getCompileCommand(language, buildTool);
  try {
    execSync(cmd, { cwd, timeout: 30000, stdio: "pipe" });
    return true;
  } catch (err: any) {
    result.compileError = err.stderr || err.stdout || err.message;
    return false;
  }
}

function getCompileCommand(language: LanguageKey, buildTool: BuildTool): string {
  switch (language) {
    case "go": return "go build ./...";
    case "java": return buildTool === "gradle" ? "gradle compileJava" : "mvn compile -q";
    case "typescript": return "npx tsc --noEmit";
    default: return "echo unknown";
  }
}

// --- Test Check ---

interface TestResult {
  passed: boolean;
  allPassed: boolean;
  failures: { test: string; subtest: string; output: string }[];
}

function runTests(cwd: string, language: LanguageKey, result: GateResult): TestResult {
  const cmd = getTestCommand(language);
  try {
    const output = execSync(cmd, { cwd, timeout: 60000, encoding: "utf-8", stdio: "pipe" });
    return parseTestOutput(output, language);
  } catch (err: any) {
    // Tests failed (exit code != 0)
    const output = err.stderr || err.stdout || "";
    return parseTestOutput(output, language);
  }
}

function getTestCommand(language: LanguageKey): string {
  switch (language) {
    case "go": return "go test -json ./...";
    case "java": return "mvn test -q 2>&1 || gradle test 2>&1 || true";
    case "typescript": return "npx vitest run --reporter=verbose 2>&1 || true";
    default: return "echo unknown";
  }
}

function parseTestOutput(output: string, language: LanguageKey): TestResult {
  const failures: { test: string; subtest: string; output: string }[] = [];

  // Go JSON output
  if (language === "go") {
    const lines = output.trim().split("\n");
    let currentTest = "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.Action === "run") currentTest = parsed.Test;
        if (parsed.Action === "fail" && !parsed.Test.startsWith("WARNING")) {
          failures.push({ test: currentTest || parsed.Test, subtest: parsed.Test, output: parsed.Output || "" });
        }
      } catch { /* not JSON */ }
    }
  } else {
    // Generic: look for FAIL lines
    const failLines = output.match(/FAIL\s+[\w/.+-]+/g);
    if (failLines) {
      for (const line of failLines) {
        failures.push({ test: line.trim(), subtest: "", output: "" });
      }
    }
  }

  const allPassed = failures.length === 0;
  return { passed: allPassed, allPassed, failures };
}

// --- Coverage Check ---

function checkCoverage(cwd: string, language: LanguageKey, threshold: number): number {
  const cmd = getCoverageCommand(language);
  try {
    const output = execSync(cmd, { cwd, timeout: 60000, encoding: "utf-8", stdio: "pipe" });
    const match = output.match(/coverage:\s+(\d+\.?\d*)%/);
    if (match) return parseFloat(match[1]);
    return 0;
  } catch {
    return 0;
  }
}

function getCoverageCommand(language: LanguageKey): string {
  switch (language) {
    case "go": return "go test -cover ./...";
    case "java": return "mvn test -DfailIfNoTests=false 2>&1 || echo 'coverage: 0%'";
    case "typescript": return "npx vitest run --coverage 2>&1 || echo 'coverage: 0%'";
    default: return "echo 'coverage: 0%'";
  }
}

// --- Format Failures ---

export function formatFailures(failures: { test: string; subtest: string; output: string }[]): string {
  if (failures.length === 0) return "No specific failures captured (test runner returned non-zero exit code).";
  return failures.map(f => {
    const name = f.subtest ? `${f.test} > ${f.subtest}` : f.test;
    return `  - ${name}`;
  }).join("\n");
}
