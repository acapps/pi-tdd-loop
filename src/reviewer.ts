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
  const findings = findIssues(specText);
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
    const funcFeature = f.title.replace(new RegExp(`^${f.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*—\\s*`), "");
    lines.push(`| ${f.id} | ${f.category} | ${funcFeature} | ${f.recommendation} |`);
  }

  return lines.join("\n");
}

// --- Threshold helpers ---


function mentionsErrors(text: string): boolean {
  const patterns = [/\berror\b/i, /\berrors\b/i, /\bpanic\b/i, /\bfail\b/i];
  return patterns.some(p => p.test(text));
}



// --- Finding detectors ---

interface SpecFunc {
  name: string;
  params: string;
  returnType: string;
  description: string;
}

/**
 * Extract function signatures from the spec. Matches common patterns:
 *   ## `Reverse(s string) string`
 *   - Capitalize(s) → string
 *   - `Run(args string) error`
 */
function extractFunctions(specText: string): SpecFunc[] {
  const results: SpecFunc[] = [];
  // Match: `FuncName(params) return` or `FuncName(params) → return`
  const sigRegex = /`?(\w+)\s*\(([^)]*)\)\s*(?:→|:?)\s*([`\w\[\],\/\s]+)`?/g;
  let m;
  while ((m = sigRegex.exec(specText)) !== null) {
    const name = m[1];
    if (name.length > 1 && !/^(function|if|for|return|const|var|let|interface|type|export|import)/.test(name)) {
      results.push({ name, params: m[2], returnType: m[3].replace(/`/g, ""), description: "" });
    }
  }

  // Associate each function with the text that follows its heading
  const lines = specText.split("\n");
  let currentFunc: SpecFunc | null = null;
  const descLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,6}\s+`?(\w+)\s*\(([^)]*)\)/);
    if (headerMatch) {
      if (currentFunc) {
        const found = results.find(f => f.name === currentFunc!.name);
        if (found) found.description = descLines.join("\n").trim();
      }
      currentFunc = { name: headerMatch[1], params: headerMatch[2], returnType: "", description: "" };
      descLines.length = 0;
    } else if (currentFunc) {
      descLines.push(line);
    }
  }
  if (currentFunc) {
    const found = results.find(f => f.name === currentFunc!.name);
    if (found) found.description = descLines.join("\n").trim();
  }

  return results;
}

/**
 * Scan a spec for common ambiguities, missing edge cases, and underspecified behavior.
 * Returns a deduplicated list of findings.
 */
function findIssues(specText: string): Finding[] {
  if (!specText.trim()) return [];

  const findings: Finding[] = [];
  let id = 0;
  const add = (f: Omit<Finding, "id">) => findings.push({ ...f, id: ++id });
  const seen = new Set<string>();
  const unique = (key: string, f: Omit<Finding, "id">) => {
    if (!seen.has(key)) { seen.add(key); add(f); }
  };

  const funcs = extractFunctions(specText);
  const ioKeywords = ["file", "read", "write", "disk", "persist", "save", "load", "I/O", "network", "http"];
  const vaguePhrases = ["properly", "correctly", "obviously", "straightforward", "obvious", "complementary", "clean refactor"];

  // 1. Vague design phrases
  for (const phrase of vaguePhrases) {
    const regex = new RegExp(`\\b${phrase}\\b`, "i");
    const match = specText.match(regex);
    if (match) {
      const context = extractContext(specText, match[0]);
      unique(`vague-${phrase}`, {
        category: "Ambiguous phrase",
        title: `Vague phrase: "${phrase}"`,
        ambiguity: `"${phrase}" in: ${context}`,
        interpretations: [
          { label: "Broad", description: "No specific criteria, implementer decides", testCases: [] },
          { label: "Constrained", description: "Should have measurable acceptance criteria", testCases: [] },
        ],
        recommendation: `Replace "${phrase}" with measurable criteria`,
      });
    }
  }

  // 2. Subjective thresholds ("within N rounds", "on first attempt")
  const subjectivePatterns = [
    /within\s*[\d\-]+\s*round/i,
    /on first attempt/i,
    /should\s+always/i,
    /must\s+converge/i,
  ];
  for (const pattern of subjectivePatterns) {
    const match = specText.match(pattern);
    if (match) {
      unique(`subjective-${match[0]}`.replace(/\s/g, "-"), {
        category: "Underspecified behavior",
        title: `Subjective threshold: "${match[0]}"`,
        ambiguity: `"${match[0]}" — subjective, not testable as written`,
        interpretations: [
          { label: "Optimistic", description: "Best-case scenario, may not hold in practice", testCases: [] },
          { label: "Hard limit", description: "Treat as a strict requirement with escalation on failure", testCases: [] },
        ],
        recommendation: `Specify what happens when the threshold is not met (escalation, retry)`,
      });
    }
  }

  // 3. Missing error handling for I/O functions
  if (ioKeywords.some(kw => specText.includes(kw))) {
    if (!mentionsErrors(specText)) {
      unique("io-no-error", {
        category: "Type contract gap",
        title: "I/O without error handling",
        ambiguity: "Spec describes file/disk/network operations but no error handling mentioned",
        interpretations: [
          { label: "Errors ignored", description: "Fail silently, log only", testCases: [] },
          { label: "Errors returned", description: "Functions return (result, error) or throw", testCases: [] },
        ],
        recommendation: "Specify error handling: return types, retry policy, or failure behavior",
      });
    }
  }

  // 4. Conflicting statements — same concept, different values
  const conceptPatterns: Record<string, RegExp> = {
    "directory": /(?:directory|dir|path|location|folder)[:\s]+([`'"\w\/\.\-]+|[^\n]+)/gi,
    "type": /(?:type|interface|return)[\s:]+([`'"\w{}\[\]<>,\s\|:]+)/gi,
    "format": /(?:format|file format|storage)[\s:]+([`'"\w\/\.\-]+|[^\n]+)/gi,
  };
  for (const [concept, pattern] of Object.entries(conceptPatterns)) {
    const matches: string[] = [];
    let m;
    while ((m = pattern.exec(specText)) !== null) matches.push(m[1]?.trim().replace(/[`'"\s]/g, ""));
    if (matches.length >= 2) {
      const uniqueValues = [...new Set(matches)];
      if (uniqueValues.length > 1) {
        unique(`conflict-${concept}`, {
          category: "Example-prose conflict" as const,
          title: `Conflicting ${concept}: ${uniqueValues.join(" vs ")}`,
          ambiguity: `Spec mentions ${concept} with different values: ${uniqueValues.join(", ")}`,
          interpretations: uniqueValues.map(v => ({
            label: v,
            description: `Use "${v}" as the standard`,
            testCases: [],
          })),
          recommendation: `Consolidate to a single ${concept} specification`,
        });
      }
    }
  }

  // 5. Per-function checks
  for (const func of funcs) {
    const block = func.description.toLowerCase();

    // String params without empty-string mention
    if (/string|str|text|text.*input/i.test(func.params) && !block.includes("empty")) {
      unique(`empty-${func.name}`, {
        category: "Edge case missing",
        title: `Empty input not specified — ${func.name}`,
        ambiguity: `"${func.name}" takes string input but doesn't specify behavior for empty string"`,
        interpretations: [
          { label: "Returns zero", description: `Empty input returns zero/default value`, testCases: [`${func.name}("") → default` ] },
          { label: "Returns error", description: `Empty input is treated as error/invalid`, testCases: [`${func.name}("") → error` ] },
        ],
        recommendation: `Specify behavior for empty string input to ${func.name}`,
      });
    }

    // Boolean returns without explicit false cases
    if (/bool/i.test(func.returnType) && !block.includes("false")) {
      unique(`bool-${func.name}`, {
        category: "Edge case missing",
        title: `False cases not specified — ${func.name}`,
        ambiguity: `"${func.name}" returns bool but doesn't specify when it returns false`,
        interpretations: [
          { label: "Default false", description: `Returns false for all unspecified cases`, testCases: [`${func.name}("unspecified") → false` ] },
          { label: "Error on ambiguous", description: `Should error instead of returning false for ambiguous cases`, testCases: [] },
        ],
        recommendation: `Specify explicit false-case inputs for ${func.name}`,
      });
    }

    // Case-insensitive without specifying normalization
    if (/case.?insensitive|fold|normalize/i.test(block) && !/normali/.test(block)) {
      unique(`case-${func.name}`, {
        category: "Underspecified behavior",
        title: `Case normalization unclear — ${func.name}`,
        ambiguity: `"${func.name}" mentions case-insensitivity but not how to normalize (lower, upper, or locale-aware)`,
        interpretations: [
          { label: "ToLower", description: `Normalize with lower-case`, testCases: [] },
          { label: "Locale-aware", description: `Use locale-specific folding`, testCases: [] },
        ],
        recommendation: `Specify normalization strategy for ${func.name}`,
      });
    }

    // UTF-8 mention without invalid-UTF-8 behavior
    if (/utf.?8|unicode|multi.?byte|run/i.test(block) && !/invalid|malformed|bad/u.test(block)) {
      unique(`utf8-${func.name}`, {
        category: "Underspecified behavior",
        title: `Invalid UTF-8 not specified — ${func.name}`,
        ambiguity: `"${func.name}" mentions UTF-8/unicode but not behavior for invalid/malformed input`,
        interpretations: [
          { label: "Pass through", description: `Treat invalid bytes as-is, no special handling`, testCases: [`${func.name}("\\xFF") → pass-through` ] },
          { label: "Error", description: `Invalid UTF-8 is a hard error`, testCases: [`${func.name}("\\xFF") → error` ] },
        ],
        recommendation: `Specify behavior for invalid UTF-8 input to ${func.name}`,
      });
    }
  }

  // 6. Whole-spec: no mention of test strategy
  if (!/test|assert|verify|expect/i.test(specText)) {
    unique("no-test-strategy", {
      category: "Underspecified behavior",
      title: "No test strategy mentioned",
      ambiguity: "Spec describes behavior but doesn't mention test approach or acceptance criteria",
      interpretations: [
        { label: "Tester decides", description: "Tester agent determines appropriate test strategy", testCases: [] },
        { label: "Spec should include", description: "Spec should include example test cases or acceptance criteria", testCases: [] },
      ],
      recommendation: "Add example test cases or acceptance criteria to the spec",
    });
  }

  return findings;
}

/**
 * Extract surrounding context around a match for readable error messages.
 */
function extractContext(text: string, word: string, radius = 40): string {
  const idx = text.toLowerCase().indexOf(word.toLowerCase());
  if (idx < 0) return word;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + word.length + radius);
  let ctx = text.slice(start, end).trim();
  if (start > 0) ctx = "…" + ctx;
  if (end < text.length) ctx = ctx + "…";
  return ctx.replace(/\n/g, " ");
}
