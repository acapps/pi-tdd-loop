// --- Contract tests for Phase 0: Spec Reviewer ---
// Tests every public function, edge case, and business rule from internal/done-phase-0-spec-review.md

import { describe, it, expect } from "vitest";
import {
  shouldActivatePhase0,
  analyzeSpec,
  formatFinding,
  buildClarificationAddendum,
  formatAddendum,
  buildSummaryTable,
  readSpec,
} from "../src/reviewer";
import {
  type Finding,
  type FindingCategory,
  type Interpretation,
  type Clarification,
  type ClarificationAddendum,
  DEFAULT_PHASE_ZERO_THRESHOLDS,
} from "../src/types";

// --- Helpers ---

function makeFinding(overrides = {}): Finding {
  return {
    id: 1,
    category: "Ambiguous phrase" as FindingCategory,
    title: "Ambiguous phrase — Capitalize",
    ambiguity: `"First character" could mean index 0 or first non-whitespace`,
    interpretations: [
      {
        label: "Interpretation A",
        description: "Capitalize the character at index 0",
        testCases: [`Capitalize("hello") → "Hello"`],
      },
      {
        label: "Interpretation B",
        description: "Capitalize the first non-whitespace character",
        testCases: [`Capitalize("  hello") → "  Hello"`],
      },
    ],
    recommendation: "Capitalize the character at index 0 (Interpretation A)",
    ...overrides,
  };
}

function makeClarification(overrides = {}): Clarification {
  return {
    findingId: 1,
    status: "approved",
    chosenInterpretation: "Capitalize the character at index 0",
    notes: undefined,
    ...overrides,
  };
}

// ================================================================
// shouldActivatePhase0
// ================================================================

describe("shouldActivatePhase0", () => {
  it("always activates Phase 0", () => {
    const spec = `
# Add Function
Add(a int, b int) int — returns the sum of a and b.
`;
    const result = shouldActivatePhase0(spec);
    expect(result.activate).toBe(true);
  });

  it("always activates — trivial spec", () => {
    const spec = `Single function.`;
    const result = shouldActivatePhase0(spec);
    expect(result.activate).toBe(true);
  });

  it("always activates — multi-function spec", () => {
    const spec = `
# String Utilities
- Capitalize(s string) string
- Reverse(s string) string
- Trim(s string) string
`;
    const result = shouldActivatePhase0(spec);
    expect(result.activate).toBe(true);
  });

  it("always activates — empty spec", () => {
    const result = shouldActivatePhase0("");
    expect(result.activate).toBe(true);
  });

  it("ignores custom thresholds", () => {
    const result = shouldActivatePhase0("", {
      ...DEFAULT_PHASE_ZERO_THRESHOLDS,
      minFunctions: 999,
    });
    expect(result.activate).toBe(true);
  });

  it("always activates for any spec", () => {
    for (const spec of ["", "   \n\n  ", "x", "Single function", "\n\n\n"]) {
      const result = shouldActivatePhase0(spec);
      expect(result.activate).toBe(true);
    }
  });

  it("ignores thresholds entirely", () => {
    const spec = `Multi-function spec with errors and I/O.`;
    const result = shouldActivatePhase0(spec, {
      ...DEFAULT_PHASE_ZERO_THRESHOLDS,
      minFunctions: 999,
      checkErrorMentions: false,
      checkIoMentions: false,
      checkConcurrencyMentions: false,
    });
    expect(result.activate).toBe(true);
  });
});

// ================================================================
// analyzeSpec
// ================================================================

describe("analyzeSpec", () => {
  it("returns findings array for simple spec", () => {
    const spec = `
# Add
Add(a, b) returns sum.
`;
    const result = analyzeSpec(spec);
    expect(Array.isArray(result.findings)).toBe(true);
  });

  it("returns analysis with all expected fields", () => {
    const spec = `
# Capitalize
Capitalize(s string) string — capitalizes the "first character".

# Reverse
Reverse(s string) string — reverses the string.

# Trim
Trim(s string) string — trims whitespace.
`;
    const result = analyzeSpec(spec);
    expect(result).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect(typeof result.shouldActivatePhase0).toBe("boolean");
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  it("always activates Phase 0", () => {
    const spec = `Single function.`;
    const result = analyzeSpec(spec);
    expect(result.shouldActivatePhase0).toBe(true);
  });

  it("handles empty spec", () => {
    const result = analyzeSpec("");
    expect(result).toBeDefined();
    expect(result.findings.length).toBe(0);
  });

  it("handles spec with special characters", () => {
    const spec = `
# Spec
- Func(a string, b int) — returns "hello & world".
`;
    const result = analyzeSpec(spec);
    expect(result).toBeDefined();
  });
});

// ================================================================
// formatFinding
// ================================================================

describe("formatFinding", () => {
  it("formats a finding with all fields", () => {
    const finding = makeFinding();
    const output = formatFinding(finding);

    expect(output).toContain("### Finding 1:");
    expect(output).toContain("Ambiguous phrase — Capitalize");
    expect(output).toContain("**Ambiguity:**");
    expect(output).toContain("**Interpretation A:**");
    expect(output).toContain("**Interpretation B:**");
    expect(output).toContain("Capitalize(\"hello\") → \"Hello\"");
    expect(output).toContain("**Recommendation:**");
  });

  it("formats finding with single interpretation", () => {
    const finding = makeFinding({
      interpretations: [
        {
          label: "Interpretation A",
          description: "Only one reading",
          testCases: [`Func("x") → "y"`],
        },
      ],
    });
    const output = formatFinding(finding);

    expect(output).toContain("**Interpretation A:**");
    expect(output).not.toContain("**Interpretation B:**");
  });

  it("formats finding with empty interpretations", () => {
    const finding = makeFinding({ interpretations: [] });
    const output = formatFinding(finding);

    expect(output).toContain("### Finding 1:");
    expect(output).toContain("**Ambiguity:**");
  });

  it("formats finding with multiple test cases per interpretation", () => {
    const finding = makeFinding({
      interpretations: [
        {
          label: "Interpretation A",
          description: "Multiple test cases",
          testCases: [
            `Func("") → ""`,
            `Func("a") → "A"`,
            `Func("abc") → "Abc"`,
          ],
        },
      ],
    });
    const output = formatFinding(finding);

    expect(output).toContain(`Func("") → ""`);
    expect(output).toContain(`Func("a") → "A"`);
    expect(output).toContain(`Func("abc") → "Abc"`);
  });

  it("formats finding with empty test cases array", () => {
    const finding = makeFinding({
      interpretations: [
        {
          label: "Interpretation A",
          description: "No test cases listed",
          testCases: [],
        },
      ],
    });
    const output = formatFinding(finding);

    expect(output).toContain("**Interpretation A:**");
    expect(output).toContain("No test cases listed");
  });

  it("preserves finding id in output", () => {
    const finding = makeFinding({ id: 42 });
    const output = formatFinding(finding);

    expect(output).toContain("Finding 42");
  });
});

// ================================================================
// buildClarificationAddendum
// ================================================================

describe("buildClarificationAddendum", () => {
  it("builds addendum with approved finding", () => {
    const findings = [makeFinding()];
    const clarifications = [makeClarification()];
    const addendum = buildClarificationAddendum(findings, clarifications);

    expect(addendum.findings).toBe(findings);
    expect(addendum.clarifications).toBe(clarifications);
    expect(addendum.appliedInterpretations).toContain("Capitalize the character at index 0");
  });

  it("includes modified findings in applied interpretations", () => {
    const findings = [makeFinding()];
    const clarifications = [makeClarification({ status: "modified" })];
    const addendum = buildClarificationAddendum(findings, clarifications);

    expect(addendum.appliedInterpretations.length).toBe(1);
  });

  it("excludes rejected findings from applied interpretations", () => {
    const findings = [makeFinding()];
    const clarifications = [makeClarification({ status: "rejected" })];
    const addendum = buildClarificationAddendum(findings, clarifications);

    expect(addendum.appliedInterpretations.length).toBe(0);
  });

  it("handles empty findings and clarifications", () => {
    const addendum = buildClarificationAddendum([], []);

    expect(addendum.findings.length).toBe(0);
    expect(addendum.clarifications.length).toBe(0);
    expect(addendum.appliedInterpretations.length).toBe(0);
  });

  it("handles approved finding without chosen interpretation", () => {
    const findings = [makeFinding()];
    const clarifications = [{ findingId: 1, status: "approved" as const, chosenInterpretation: undefined }];
    const addendum = buildClarificationAddendum(findings, clarifications);

    expect(addendum.appliedInterpretations.length).toBe(0);
  });

  it("handles multiple approved findings", () => {
    const findings = [
      makeFinding({ id: 1, title: "Ambiguous phrase — Func1" }),
      makeFinding({ id: 2, title: "Edge case missing — Func2" }),
    ];
    const clarifications = [
      { findingId: 1, status: "approved" as const, chosenInterpretation: "Interp A" },
      { findingId: 2, status: "approved" as const, chosenInterpretation: "Interp B" },
    ];
    const addendum = buildClarificationAddendum(findings, clarifications);

    expect(addendum.appliedInterpretations).toContain("Interp A");
    expect(addendum.appliedInterpretations).toContain("Interp B");
  });

  it("skips clarifications for missing finding ids", () => {
    const findings = [makeFinding({ id: 1 })];
    const clarifications = [{ findingId: 99, status: "approved" as const, chosenInterpretation: "X" }];
    const addendum = buildClarificationAddendum(findings, clarifications);

    expect(addendum.appliedInterpretations.length).toBe(0);
  });
});

// ================================================================
// formatAddendum
// ================================================================

describe("formatAddendum", () => {
  it("produces markdown with addendum header", () => {
    const addendum: ClarificationAddendum = {
      findings: [makeFinding()],
      clarifications: [makeClarification()],
      appliedInterpretations: ["Capitalize the character at index 0"],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("---");
    expect(output).toContain("## Spec Review Addendum");
  });

  it("includes finding details", () => {
    const addendum: ClarificationAddendum = {
      findings: [makeFinding()],
      clarifications: [makeClarification()],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("### Finding 1:");
    expect(output).toContain("**Ambiguity:**");
  });

  it("includes clarification status", () => {
    const addendum: ClarificationAddendum = {
      findings: [makeFinding()],
      clarifications: [makeClarification()],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("**Status:** approved");
  });

  it("includes chosen interpretation", () => {
    const addendum: ClarificationAddendum = {
      findings: [makeFinding()],
      clarifications: [makeClarification()],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("**Chosen:**");
  });

  it("includes notes when present", () => {
    const addendum: ClarificationAddendum = {
      findings: [makeFinding()],
      clarifications: [makeClarification({ notes: "This matches our conventions" })],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("**Notes:** This matches our conventions");
  });

  it("skips notes when undefined", () => {
    const addendum: ClarificationAddendum = {
      findings: [makeFinding()],
      clarifications: [makeClarification({ notes: undefined })],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).not.toContain("**Notes:**");
  });

  it("includes applied interpretations section when non-empty", () => {
    const addendum: ClarificationAddendum = {
      findings: [makeFinding()],
      clarifications: [makeClarification()],
      appliedInterpretations: ["Interp 1", "Interp 2"],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("### Applied Interpretations");
    expect(output).toContain("- Interp 1");
    expect(output).toContain("- Interp 2");
  });

  it("omits applied interpretations section when empty", () => {
    const addendum: ClarificationAddendum = {
      findings: [],
      clarifications: [],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).not.toContain("### Applied Interpretations");
  });

  it("handles empty addendum", () => {
    const addendum: ClarificationAddendum = {
      findings: [],
      clarifications: [],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("---");
    expect(output).toContain("## Spec Review Addendum");
  });

  it("formats multiple findings", () => {
    const addendum: ClarificationAddendum = {
      findings: [
        makeFinding({ id: 1, title: "Ambiguous phrase — F1" }),
        makeFinding({ id: 2, title: "Edge case missing — F2" }),
      ],
      clarifications: [
        makeClarification({ findingId: 1 }),
        makeClarification({ findingId: 2 }),
      ],
      appliedInterpretations: [],
    };
    const output = formatAddendum(addendum);

    expect(output).toContain("Finding 1");
    expect(output).toContain("Finding 2");
  });
});

// ================================================================
// buildSummaryTable
// ================================================================

describe("buildSummaryTable", () => {
  it("produces markdown table with header", () => {
    const findings = [makeFinding()];
    const output = buildSummaryTable(findings);

    expect(output).toContain("### Summary");
    expect(output).toContain("| # | Category | Function/Feature | Recommendation |");
    expect(output).toContain("|---|");
  });

  it("produces row for each finding", () => {
    const findings = [
      makeFinding({ id: 1, category: "Ambiguous phrase" as const, title: "Ambiguous phrase — Capitalize" }),
      makeFinding({ id: 2, category: "Edge case missing" as const, title: "Edge case missing — Reverse" }),
    ];
    const output = buildSummaryTable(findings);

    expect(output).toContain("| 1 |");
    expect(output).toContain("Ambiguous phrase");
    expect(output).toContain("Capitalize");
    expect(output).toContain("| 2 |");
    expect(output).toContain("Edge case missing");
    expect(output).toContain("Reverse");
  });

  it("handles empty findings", () => {
    const output = buildSummaryTable([]);

    expect(output).toContain("### Summary");
    expect(output).toContain("|---|");
  });

  it("preserves recommendation text", () => {
    const findings = [makeFinding({ recommendation: "Use Interpretation A" })];
    const output = buildSummaryTable(findings);

    expect(output).toContain("Use Interpretation A");
  });
});

// ================================================================
// Edge cases: empty, undefined, null, single element
// ================================================================

describe("edge cases", () => {
  it("shouldActivatePhase0 with empty string", () => {
    const result = shouldActivatePhase0("");
    expect(result.activate).toBe(true); // always activates
  });

  it("analyzeSpec with empty string", () => {
    const result = analyzeSpec("");
    expect(result.findings).toEqual([]);
  });

  it("formatFinding with minimal finding (no interpretations, no recommendation)", () => {
    const finding: Finding = {
      id: 0,
      category: "Ambiguous phrase" as const,
      title: "Test",
      ambiguity: "",
      interpretations: [],
      recommendation: "",
    };
    const output = formatFinding(finding);
    expect(output).toContain("### Finding 0:");
  });

  it("buildClarificationAddendum with empty arrays", () => {
    const result = buildClarificationAddendum([], []);
    expect(result.appliedInterpretations).toEqual([]);
  });

  it("formatAddendum with empty addendum", () => {
    const addendum = { findings: [], clarifications: [], appliedInterpretations: [] };
    const output = formatAddendum(addendum);
    expect(output).toContain("## Spec Review Addendum");
  });

  it("buildSummaryTable with empty findings", () => {
    const output = buildSummaryTable([]);
    expect(output).toContain("### Summary");
  });

  it("shouldActivatePhase0 with single character spec", () => {
    const result = shouldActivatePhase0("a");
    expect(result.activate).toBe(true); // always activates
  });

  it("analyzeSpec with single word spec", () => {
    const result = analyzeSpec("function");
    expect(result).toBeDefined();
  });

  it("formatFinding with single test case", () => {
    const finding: Finding = {
      id: 1,
      category: "Edge case missing" as const,
      title: "Edge case missing — Func",
      ambiguity: "No edge cases described",
      interpretations: [{
        label: "Interpretation A",
        description: "Handle empty input",
        testCases: [`Func() → error`],
      }],
      recommendation: "Add empty input handling",
    };
    const output = formatFinding(finding);
    expect(output).toContain("Func() → error");
  });
});

// ================================================================
// Finding categories coverage
// ================================================================

describe("finding categories", () => {
  const categories: FindingCategory[] = [
    "Ambiguous phrase",
    "Edge case missing",
    "Underspecified behavior",
    "Example-prose conflict",
    "Type contract gap",
  ];

  it("formatFinding works for all categories", () => {
    for (const category of categories) {
      const finding = makeFinding({ category, title: `${category} — Func` });
      const output = formatFinding(finding);
      expect(output).toContain(category);
    }
  });

  it("buildSummaryTable works for all categories", () => {
    const findings = categories.map((cat, i) =>
      makeFinding({ id: i + 1, category: cat, title: `${cat} — Func${i}` })
    );
    const output = buildSummaryTable(findings);

    for (const cat of categories) {
      expect(output).toContain(cat);
    }
  });
});

// ================================================================
// analyzeSpec — correctness tests (findIssues)
// ================================================================

describe("analyzeSpec — correctness", () => {
  it("detects vague phrases like 'properly'", () => {
    const spec = `# API\n\nParseConfig(config string) Config — parses the config properly.`;
    const result = analyzeSpec(spec);
    expect(result.findings.length).toBeGreaterThan(0);
    const vagueFinding = result.findings.find(f => f.category === "Ambiguous phrase" && f.ambiguity.includes("properly"));
    expect(vagueFinding).toBeDefined();
  });

  it("detects vague phrases like 'correctly'", () => {
    const spec = `# API\n\nValidate(s string) bool — validates the input correctly.`;
    const result = analyzeSpec(spec);
    const vagueFinding = result.findings.find(f => f.category === "Ambiguous phrase" && f.ambiguity.includes("correctly"));
    expect(vagueFinding).toBeDefined();
  });

  it("detects I/O without error handling", () => {
    const spec = `# API\n\nReadFile(path string) string — reads the file and returns its contents.\nWriteFile(path string, data string) — writes data to disk.`;
    const result = analyzeSpec(spec);
    const ioFinding = result.findings.find(f => f.category === "Type contract gap" && f.title.includes("error handling"));
    expect(ioFinding).toBeDefined();
  });

  it("does not flag I/O error handling when errors are mentioned", () => {
    const spec = `# API\n\nReadFile(path string) (string, error) — reads the file. Returns error on failure.`;
    const result = analyzeSpec(spec);
    const ioFinding = result.findings.find(f => f.category === "Type contract gap" && f.title.includes("error handling"));
    expect(ioFinding).toBeUndefined();
  });

  it("detects missing empty-string edge case for string functions", () => {
    // extractFunctions requires ## header to associate description with function
    const spec = `# API\n\n## Capitalize(s string) string\n\nCapitalizes the first character of the input.`;
    const result = analyzeSpec(spec);
    const emptyFinding = result.findings.find(f => f.category === "Edge case missing" && f.title.toLowerCase().includes("empty"));
    expect(emptyFinding).toBeDefined();
  });

  it("does not flag empty-string edge case when spec mentions empty input", () => {
    const spec = `# API\n\n## Reverse(s string) string\n\nReverses the string. Returns empty string for empty input.`;
    const result = analyzeSpec(spec);
    const emptyFinding = result.findings.find(f => f.category === "Edge case missing" && f.title.toLowerCase().includes("empty") && f.title.toLowerCase().includes("reverse"));
    expect(emptyFinding).toBeUndefined();
  });

  it("detects missing false cases for boolean-returning functions", () => {
    // extractFunctions requires ## header; params don't need 'string' here
    const spec = `# API\n\n## IsPalin(s string) bool\n\nReturns true if palindrome.`;
    const result = analyzeSpec(spec);
    const boolFinding = result.findings.find(f => f.category === "Edge case missing" && f.title.toLowerCase().includes("false"));
    expect(boolFinding).toBeDefined();
  });

  it("does not flag false cases when spec mentions false", () => {
    const spec = `# API\n\n## IsPalin(s string) bool\n\nReturns true if palindrome, false otherwise.`;
    const result = analyzeSpec(spec);
    const boolFinding = result.findings.find(f => f.category === "Edge case missing" && f.title.toLowerCase().includes("false") && f.title.toLowerCase().includes("ispalin"));
    expect(boolFinding).toBeUndefined();
  });

  it("detects no test strategy when spec lacks test mentions", () => {
    const spec = `# API\n\nAdd(a int, b int) int — returns the sum.`;
    const result = analyzeSpec(spec);
    const noTestFinding = result.findings.find(f => f.title.includes("test strategy"));
    expect(noTestFinding).toBeDefined();
  });

  it("does not flag missing test strategy when tests are mentioned", () => {
    const spec = `# API\n\nAdd(a int, b int) int — returns the sum.\n\nTests should cover overflow and underflow cases.`;
    const result = analyzeSpec(spec);
    const noTestFinding = result.findings.find(f => f.title.includes("test strategy"));
    expect(noTestFinding).toBeUndefined();
  });

  it("deduplicates findings — same vague phrase only reported once", () => {
    const spec = `# API\n\nDoIt properly. Also handle it properly. The result must be obtained properly.`;
    const result = analyzeSpec(spec);
    const vagueFindings = result.findings.filter(f => f.ambiguity.includes("properly"));
    expect(vagueFindings.length).toBe(1); // deduplicated
  });

  it("has fewer edge case findings for well-specified spec than underspecified", () => {
    // Well-specified: empty, false, UTF-8, normalization all mentioned
    const wellSpec = `
# API

## Capitalize(s string) string

Capitalizes the first character. Returns empty string for empty input.

## IsPalin(s string) bool

Returns true if palindrome, false otherwise. Uses ToLower. Tests cover edge cases.
`;
    // Underspecified: nothing about empty, false, etc.
    const underSpec = `
# API

## Capitalize(s string) string

Capitalize the input.

## IsPalin(s string) bool

Check if palindrome.
`;
    const wellResult = analyzeSpec(wellSpec);
    const underResult = analyzeSpec(underSpec);
    // The well-specified spec should have fewer edge case findings
    const wellEdgeCases = wellResult.findings.filter(f => f.category === "Edge case missing");
    const underEdgeCases = underResult.findings.filter(f => f.category === "Edge case missing");
    expect(wellEdgeCases.length).toBeLessThan(underEdgeCases.length);
  });
});

// ================================================================
// readSpec — path resolution
// ================================================================

describe("readSpec", () => {
  const fs = require("node:fs");
  const os = require("node:os");

  it("reads absolute paths", () => {
    const tmpfile = `${os.tmpdir()}/loop-spec-test-${Date.now()}.md`;
    fs.writeFileSync(tmpfile, "# Test Spec\n\nSome content.");
    try {
      const content = readSpec(tmpfile);
      expect(content).toContain("Test Spec");
    } finally {
      fs.unlinkSync(tmpfile);
    }
  });

  it("returns null for non-existent absolute path", () => {
    const content = readSpec("/nonexistent/path-" + Date.now() + ".md");
    expect(content).toBeNull();
  });

  it("resolves relative path against baseDir", () => {
    const tmpdir = fs.mkdtempSync(`${os.tmpdir()}/loop-test-`);
    fs.writeFileSync(`${tmpdir}/spec.md`, "# Spec in baseDir");
    try {
      const content = readSpec("spec.md", tmpdir);
      expect(content).toContain("Spec in baseDir");
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });
});
