// --- Phase 0: Spec Reviewer (pure functions) ---

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguageKey } from "./types";
import { execSync } from "node:child_process";

import type {
  Finding,
  FindingCategory,
  Interpretation,
  SpecAnalysis,
  PhaseZeroThresholds,
  Clarification,
  ClarificationAddendum,
} from "./types";
import { DEFAULT_PHASE_ZERO_THRESHOLDS } from "./types";

// --- Public API ---

/**
 * Read the spec file at the given path.
 * Absolute paths are used as-is.
 * Relative paths: if baseDir is given, resolve against baseDir first.
 * Falls back to process CWD if not found.
 * Returns the text content or null if the file does not exist.
 */
export function readSpec(specPath: string, baseDir?: string): string | null {
  try {
    // Absolute paths: use directly
    if (specPath.startsWith("/")) {
      if (!existsSync(specPath)) return null;
      return readFileSync(specPath, "utf-8");
    }
    // Relative path: prefer baseDir if provided
    if (baseDir) {
      const fullPath = resolve(baseDir, specPath);
      if (existsSync(fullPath)) {
        return readFileSync(fullPath, "utf-8");
      }
    }
    // Fallback: process CWD
    if (existsSync(specPath)) {
      return readFileSync(specPath, "utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate that the test runner can execute in the project directory.
 * Returns { ok: true } if the runner is available, or { ok: false, error } if not.
 * This is a pre-flight check for blank projects.
 */
export function validateTestRunner(
  cwd: string,
  language: LanguageKey,
): { ok: boolean; error?: string } {
  const cmd = getRunnerValidationCommand(language);
  try {
    execSync(cmd, { cwd, timeout: 15000, stdio: "pipe" });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.stderr || err.stdout || err.message || "Unknown error" };
  }
}

function getRunnerValidationCommand(language: LanguageKey): string {
  switch (language) {
    case "go": return "go version && go env GOROOT";
    case "java": return "mvn --version || gradle --version || echo java-missing";
    case "typescript": return "npx vitest --version || npx tsc --version || echo ts-missing";
    default: return "echo unknown";
  }
}

// --- Public API ---

/**
 * Phase 0 always activates. Every spec benefits from review.
 */
export function shouldActivatePhase0(
  _specText: string,
  _thresholds?: PhaseZeroThresholds,
): { activate: boolean; reasons: string[] } {
  return { activate: true, reasons: ["Phase 0 is the baseline"] };
}

/**
 * Analyze a spec document and return structured findings.
 * Each finding surfaces an ambiguity, missing edge case, or underspecified behavior.
 */
export function analyzeSpec(specText: string): SpecAnalysis {
  const findings: Finding[] = [];
  let findingId = 0;

  findings.push(...findAmbiguousPhrases(specText, () => ++findingId));
  findings.push(...findMissingEdgeCases(specText, () => ++findingId));
  findings.push(...findUnderspecifiedBehavior(specText, () => ++findingId));
  findings.push(...findExampleProseConflicts(specText, () => ++findingId));
  findings.push(...findTypeContractGaps(specText, () => ++findingId));

  const { activate, reasons } = shouldActivatePhase0(specText);
  return { findings, shouldActivatePhase0: activate, reasons };
}

/**
 * Format a single finding into the structured text format.
 */
export function formatFinding(finding: Finding): string {
  const lines = [
    `### Finding ${finding.id}: ${finding.title}`,
    "",
    `**Ambiguity:** ${finding.ambiguity}`,
    "",
  ];

  for (const interp of finding.interpretations) {
    lines.push(`**${interp.label}:** ${interp.description}`);
    for (const tc of interp.testCases) {
      lines.push(`  - Test: \`${tc}\``);
    }
    lines.push("");
  }

  lines.push(`**Recommendation:** ${finding.recommendation}`);
  return lines.join("\n");
}

/**
 * Build the clarification addendum from approved findings.
 */
export function buildClarificationAddendum(
  findings: Finding[],
  clarifications: Clarification[],
): ClarificationAddendum {
  const appliedInterpretations: string[] = [];

  for (const clarification of clarifications) {
    if (clarification.status === "approved" || clarification.status === "modified") {
      const finding = findings.find(f => f.id === clarification.findingId);
      if (finding && clarification.chosenInterpretation) {
        appliedInterpretations.push(clarification.chosenInterpretation);
      }
    }
  }

  return {
    findings,
    clarifications,
    appliedInterpretations,
  };
}

/**
 * Format the full clarification addendum as markdown.
 */
export function formatAddendum(addendum: ClarificationAddendum): string {
  const lines = [
    "---",
    "## Spec Review Addendum",
    "",
  ];

  for (const finding of addendum.findings) {
    const clarification = addendum.clarifications.find(c => c.findingId === finding.id);
    lines.push(formatFinding(finding));

    if (clarification) {
      lines.push("");
      lines.push(`**Status:** ${clarification.status}`);
      if (clarification.chosenInterpretation) {
        lines.push(`**Chosen:** ${clarification.chosenInterpretation}`);
      }
      if (clarification.notes) {
        lines.push(`**Notes:** ${clarification.notes}`);
      }
    }
    lines.push("");
  }

  if (addendum.appliedInterpretations.length > 0) {
    lines.push("### Applied Interpretations");
    lines.push("");
    for (const interp of addendum.appliedInterpretations) {
      lines.push(`- ${interp}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a summary table of findings.
 */
export function buildSummaryTable(findings: Finding[]): string {
  const lines = [
    "### Summary",
    "",
    "| # | Category | Function/Feature | Recommendation |",
    "|---|----------|------------------|----------------|",
  ];

  for (const f of findings) {
    const funcFeature = f.title.replace(new RegExp(`^${escapeRegex(f.category)}\\s*—\\s*`), "");
    lines.push(`| ${f.id} | ${f.category} | ${funcFeature} | ${f.recommendation} |`);
  }

  return lines.join("\n");
}

// --- Threshold helpers ---

function countFunctions(specText: string): number {
  const patterns = [
    /^function\s+\w+/im,
    /^\w+\s*\(.*\)\s*:?\s*\w+/m,
    /`(\w+)\(`/g,
    /- \w+\(/g,
  ];

  const uniqueNames = new Set<string>();
  for (const pattern of patterns) {
    const matches = specText.match(new RegExp(pattern.source, pattern.flags));
    if (matches) {
      for (const match of matches) {
        const name = match.replace(/[^a-zA-Z0-9_$]/g, "").trim();
        if (name.length > 2) uniqueNames.add(name);
      }
    }
  }

  return uniqueNames.size;
}

function mentionsErrors(text: string): boolean {
  const patterns = [/\berror\b/i, /\berrors\b/i, /\bpanic\b/i, /\bfail\b/i];
  return patterns.some(p => p.test(text));
}

function mentionsIO(text: string): boolean {
  const patterns = [/\bI\/O\b/i, /\bfile\b/i, /\bread\b/i, /\bwrite\b/i, /\bstdin\b/i, /\bstdout\b/i];
  return patterns.some(p => p.test(text));
}

function mentionsConcurrency(text: string): boolean {
  const patterns = [/\bconcurrency\b/i, /\bgoroutine\b/i, /\bthread\b/i, /\basync\b/i, /\bparallel\b/i];
  return patterns.some(p => p.test(text));
}

// --- Finding detectors (stubs) ---

function findAmbiguousPhrases(_specText: string, _nextId: () => number): Finding[] {
  return [];
}

function findMissingEdgeCases(_specText: string, _nextId: () => number): Finding[] {
  return [];
}

function findUnderspecifiedBehavior(_specText: string, _nextId: () => number): Finding[] {
  return [];
}

function findExampleProseConflicts(_specText: string, _nextId: () => number): Finding[] {
  return [];
}

function findTypeContractGaps(_specText: string, _nextId: () => number): Finding[] {
  return [];
}

// --- Utility ---

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
