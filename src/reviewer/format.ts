// --- Phase 0: Spec Reviewer — formatting (pure functions; src/reviewer.ts split, step 1) ---

import type {
  Finding,
  Clarification,
  ClarificationAddendum,
} from "../types";

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
    "| # | Severity | Category | Function/Feature | Recommendation |",
    "|---|----------|----------|------------------|----------------|",
  ];

  for (const f of findings) {
    const funcFeature = f.title.replace(new RegExp(`^${f.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*—\\s*`), "");
    const sev = f.severity ?? "";
    lines.push(`| ${f.id} | ${sev} | ${f.category} | ${funcFeature} | ${f.recommendation} |`);
  }

  return lines.join("\n");
}
