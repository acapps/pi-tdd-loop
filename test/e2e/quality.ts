// --- Real Code Quality Measurement ---
// Measures the quality of code produced by the loop extension.
// Run against real Go code to produce a quality score.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// --- Types ---

export interface QualityMetrics {
  compiles: boolean;
  testsPass: boolean;
  coverage: number;
  testThoroughness: number; // 0-100
  edgeCaseCoverage: number; // 0-100
  codeComplexity: number; // avg cyclomatic complexity
  linesOfCode: number;
  testLinesOfCode: number;
  numFunctions: number;
  numTestCases: number;
  numTestFiles: number;
  compileError?: string;
  testOutput?: string;
  coverageOutput?: string;
}

export interface QualityScore {
  score: number; // 0-100
  subScores: {
    compiles: number; // 20
    testsPass: number; // 25
    coverage: number; // 20
    testThoroughness: number; // 15
    edgeCases: number; // 10
    complexity: number; // 10
  };
  metrics: QualityMetrics;
  report: string;
}

// --- Weights ---

const W_COMPILES = 20;
const W_TESTS_PASS = 25;
const W_COVERAGE = 20;
const W_THOROUGHNESS = 15;
const W_EDGE_CASES = 10;
const W_COMPLEXITY = 10;

// --- Public API ---

/**
 * Measure the quality of code in a directory.
 * @param projectDir - Path to the project root (where go.mod lives)
 * @param expectedFunctions - List of function names that should be implemented
 * @param coverageThreshold - Minimum coverage percentage (default 80)
 * @returns QualityScore with 0-100 score and detailed metrics
 */
export function measureQuality(
  projectDir: string,
  expectedFunctions: string[],
  coverageThreshold: number = 80,
): QualityScore {
  const metrics = gatherMetrics(projectDir, expectedFunctions, coverageThreshold);
  const subScores = computeSubScores(metrics, coverageThreshold);
  const score = computeCompositeScore(subScores);
  const report = formatReport(metrics, subScores, score);

  return { score, subScores, metrics, report };
}

// --- Metric Gathering ---

function gatherMetrics(
  projectDir: string,
  expectedFunctions: string[],
  coverageThreshold: number,
): QualityMetrics {
  const metrics: QualityMetrics = {
    compiles: false,
    testsPass: false,
    coverage: 0,
    testThoroughness: 0,
    edgeCaseCoverage: 0,
    codeComplexity: 0,
    linesOfCode: 0,
    testLinesOfCode: 0,
    numFunctions: 0,
    numTestCases: 0,
    numTestFiles: 0,
  };

  // 1. Check if it compiles
  try {
    const output = execSync("go build ./...", { cwd: projectDir, encoding: "utf-8", timeout: 30000 });
    metrics.compiles = true;
  } catch (err: any) {
    metrics.compiles = false;
    metrics.compileError = err.stderr || err.message;
  }

  // 2. Run tests
  try {
    const output = execSync("go test -json ./...", { cwd: projectDir, encoding: "utf-8", timeout: 60000 });
    const allPassed = parseTestJson(output);
    metrics.testsPass = allPassed.passed;
    metrics.testOutput = output;
    metrics.numTestCases = allPassed.testCount;
  } catch (err: any) {
    metrics.testsPass = false;
    metrics.testOutput = err.stderr || err.stdout || err.message;
  }

  // 3. Coverage
  try {
    const output = execSync("go test -cover ./...", { cwd: projectDir, encoding: "utf-8", timeout: 60000 });
    const match = output.match(/coverage:\s+(\d+\.?\d*)%/);
    if (match) {
      metrics.coverage = parseFloat(match[1]);
    }
    metrics.coverageOutput = output;
  } catch (err: any) {
    metrics.coverage = 0;
    metrics.coverageOutput = err.stderr || err.message;
  }

  // 4. Static analysis (no external tools needed)
  analyzeSourceFiles(projectDir, expectedFunctions, metrics);

  return metrics;
}

// --- Go Test JSON Parser ---

interface TestJsonResult {
  passed: boolean;
  testCount: number;
  failures: string[];
}

function parseTestJson(output: string): TestJsonResult {
  const lines = output.trim().split("\n");
  const result: TestJsonResult = { passed: true, testCount: 0, failures: [] };

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.Action === "run" || parsed.Action === "pass" || parsed.Action === "fail") {
        result.testCount++;
      }
      if (parsed.Action === "fail" && !parsed.Test.startsWith("WARNING")) {
        result.passed = false;
        result.failures.push(parsed.Test || "unknown");
      }
    } catch {
      // Not JSON, skip
    }
  }

  return result;
}

// --- Source Code Analysis ---

function analyzeSourceFiles(
  projectDir: string,
  expectedFunctions: string[],
  metrics: QualityMetrics,
): void {
  const files = findGoFiles(projectDir);
  let totalLines = 0;
  let testLines = 0;
  let foundFunctions = new Set<string>();
  let totalTestCases = 0;
  let totalComplexity = 0;
  let funcCount = 0;

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const isTest = file.includes("_test.go");
    const lines = content.split("\n");

    if (isTest) {
      testLines += lines.length;
      metrics.numTestFiles++;
      totalTestCases += countTestCases(content);
    } else {
      totalLines += lines.length;
      const funcs = extractFunctions(content);
      for (const fn of funcs) {
        foundFunctions.add(fn.name);
        totalComplexity += computeCyclomaticComplexity(content, fn);
        funcCount++;
      }
    }
  }

  metrics.linesOfCode = totalLines;
  metrics.testLinesOfCode = testLines;
  metrics.numFunctions = foundFunctions.size;
  metrics.numTestCases = Math.max(metrics.numTestCases, totalTestCases);
  metrics.codeComplexity = funcCount > 0 ? totalComplexity / funcCount : 0;

  // Test thoroughness: test cases per function
  if (foundFunctions.size > 0) {
    metrics.testThoroughness = Math.min(100, (metrics.numTestCases / foundFunctions.size) / 10 * 100);
  }

  // Edge case coverage: check for common edge case patterns
  const testFiles = files.filter(f => f.includes("_test.go"));
  metrics.edgeCaseCoverage = measureEdgeCaseCoverage(testFiles, expectedFunctions);
}

function findGoFiles(projectDir: string): string[] {
  const files: string[] = [];
  walkDir(projectDir, (file) => {
    if (file.endsWith(".go")) {
      files.push(file);
    }
  });
  return files;
}

function walkDir(dir: string, cb: (file: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "vendor" || entry === "node_modules") continue;
      walkDir(full, cb);
    } else {
      cb(full);
    }
  }
}

function countTestCases(content: string): number {
  // Count t.Run() calls and table-driven test entries
  const tableEntries = content.match(/[\w"{}]+:\s*{[^}]*}/g);
  const tRunCalls = content.match(/t\.Run\(/g);
  const subtests = content.match(/\/\/\s*case\s+["']/gi);

  return (tableEntries?.length || 0) + (tRunCalls?.length || 0) + (subtests?.length || 0);
}

interface FuncInfo {
  name: string;
  startLine: number;
  endLine: number;
}

function extractFunctions(content: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  const lines = content.split("\n");
  let braceDepth = 0;
  let inFunc = false;
  let funcName = "";
  let funcStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inFunc) {
      const match = line.match(/^func\s+(\w+)\s*\(/);
      if (match) {
        funcName = match[1];
        funcStart = i;
        inFunc = true;
        braceDepth = 0;
      }
    }

    // Count braces
    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }

    if (inFunc && braceDepth === 0) {
      funcs.push({ name: funcName, startLine: funcStart, endLine: i });
      inFunc = false;
    }
  }

  return funcs;
}

function computeCyclomaticComplexity(content: string, func: FuncInfo): number {
  let complexity = 1; // Base complexity
  const lines = content.split("\n");

  for (let i = func.startLine; i <= func.endLine; i++) {
    const line = lines[i];
    // Count decision points
    if (/\bif\b/.test(line)) complexity++;
    if (/\bfor\b/.test(line)) complexity++;
    if (/\bswitch\b/.test(line)) complexity++;
    if (/\bcase\b/.test(line)) complexity++;
    if (/\belse\s+if\b/.test(line)) complexity++;
    if (/\b&&|\b\|\|/.test(line)) complexity += (line.match(/&&/g)?.length || 0) + (line.match(/\|\|/g)?.length || 0);
  }

  return complexity;
}

function measureEdgeCaseCoverage(testFiles: string[], expectedFunctions: string[]): number {
  let score = 0;
  const checks = [
    { pattern: /""|"empty"/, label: "empty string" },
    { pattern: /["']["']|"single"/i, label: "single character" },
    { pattern: /UTF?[- ]?8|unicode|utf8|unicode\./i, label: "UTF-8 handling" },
    { pattern: /\s+["']\s+"/i, label: "whitespace handling" },
    { pattern: /nil|zero|default/i, label: "zero value" },
    { pattern: /upper|lower|case/i, label: "case sensitivity" },
  ];

  const allContent = testFiles.map(f => readFileSync(f, "utf-8")).join("\n");

  for (const check of checks) {
    if (check.pattern.test(allContent)) score += 100 / checks.length;
  }

  return Math.round(score);
}

// --- Score Computation ---

function computeSubScores(metrics: QualityMetrics, coverageThreshold: number) {
  return {
    compiles: metrics.compiles ? 20 : 0,
    testsPass: metrics.testsPass ? 25 : 0,
    coverage: Math.min(20, (metrics.coverage / coverageThreshold) * 20),
    testThoroughness: Math.min(15, metrics.testThoroughness / 100 * 15),
    edgeCases: metrics.edgeCaseCoverage / 100 * 10,
    complexity: Math.min(10, Math.max(0, 10 - (metrics.codeComplexity - 5))), // Penalty for complexity > 5
  };
}

function computeCompositeScore(subScores: QualityScore["subScores"]): number {
  return Math.round(
    subScores.compiles +
    subScores.testsPass +
    subScores.coverage +
    subScores.testThoroughness +
    subScores.edgeCases +
    subScores.complexity,
  );
}

// --- Report Formatting ---

function formatReport(
  metrics: QualityMetrics,
  subScores: QualityScore["subScores"],
  score: number,
): string {
  const lines = [
    "═══ Code Quality Report ═══",
    `Overall Score: ${score}/100`,
    "",
    "Sub-scores:",
    `  Compiles:         ${subScores.compiles}/20  ${metrics.compiles ? "✓" : "✗"}`,
    `  Tests Pass:       ${subScores.testsPass}/25  ${metrics.testsPass ? "✓" : "✗"}`,
    `  Coverage:         ${subScores.coverage.toFixed(1)}/20  (${metrics.coverage}%)`,
    `  Thoroughness:     ${subScores.testThoroughness.toFixed(1)}/15  (${metrics.testThoroughness.toFixed(0)}%)`,
    `  Edge Cases:       ${subScores.edgeCases.toFixed(1)}/10  (${metrics.edgeCaseCoverage}%)`,
    `  Complexity:       ${subScores.complexity.toFixed(1)}/10  (avg ${metrics.codeComplexity.toFixed(1)} per function)`,
    "",
    "Details:",
    `  Functions implemented: ${metrics.numFunctions}`,
    `  Test cases: ${metrics.numTestCases}`,
    `  Source lines: ${metrics.linesOfCode}`,
    `  Test lines: ${metrics.testLinesOfCode}`,
    `  Test files: ${metrics.numTestFiles}`,
  ];

  if (metrics.compileError) {
    lines.push("");
    lines.push(`Compile error: ${metrics.compileError}`);
  }

  return lines.join("\n");
}
