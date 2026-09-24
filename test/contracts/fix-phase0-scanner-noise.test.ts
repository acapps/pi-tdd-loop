// ============================================================================
// Contract tests: fix-phase0-scanner-noise
// Spec: internal/fix-phase0-scanner-noise.md
//
// Covers:
//   S1 — buildPhaseZeroPrompt framing line (present iff findings > 0)
//   S2 — CONCEPT_PATTERNS: type/directory patterns require backtick-quoted values
//   S3 — detectFunctionIssues: UTF-8 trigger drops `run`; name-shape + backtick gate
//   S4 — detectMissingErrorHandling scoped to ## Inventory / ## Interface sections
//   S5 — preserved detectors (vague, subjective, missing-test-strategy) unchanged
//   Acceptance Criteria 1–5
//
// `findIssues` is not exported; it is exercised through the exported
// `analyzeSpec` (sole consumer chain: analyzeSpec → findIssues).
// ============================================================================

import { describe, it, expect, vi } from "vitest";
import { analyzeSpec } from "../../src/reviewer";
import { buildPhaseZeroPrompt } from "../../src/commands/loop";
import type { SpecAnalysis, Finding } from "../../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Findings produced by the three detectors fixed in this spec:
 *  - S2 → detectConflictingStatements  (category "Example-prose conflict")
 *  - S4 → detectMissingErrorHandling   (category "Type contract gap")
 *  - S3 → detectFunctionIssues         (categories "Edge case missing" /
 *                                        "Underspecified behavior", titles
 *                                        prefixed with the function name)
 * Structural findings ("Missing section") and the preserved detectors
 * (vague phrases, subjective thresholds, missing test strategy) are NOT
 * in this set. The session fragments are full specs with a Test Strategy
 * section, so only the three fixed detectors can fire on them.
 */
function fixedDetectorFindings(analysis: SpecAnalysis): Finding[] {
  return analysis.findings.filter((f) => {
    if (f.category === "Missing section") return false;
    if (f.category === "Example-prose conflict") return true; // S2
    if (f.category === "Type contract gap") return true; // S4
    if (f.title.includes("Empty input not specified")) return true; // S3
    if (f.title.includes("Invalid UTF-8 not specified")) return true; // S3
    if (f.title.includes("False cases not specified")) return true; // S3
    if (f.title.includes("Case normalization unclear")) return true; // S3
    return false;
  });
}

// ---------------------------------------------------------------------------
// Session-fragment regression fixtures (Q3: inlined, abridged to the
// offending lines — not full session transcripts)
// ---------------------------------------------------------------------------

/**
 * 01a0155a (spec 10) — the lines that fired all 4 heuristic findings:
 *  - "I/O without error handling" (IO keyword in passing prose, no I/O contract)
 *  - "Conflicting directory: string vs change. vs is vs |**Proposed,flaggedforreview.*"
 *  - "Conflicting type: done vs NosignaturechangetoapplyDoneEffect vs Loopcomplete vs"
 *  - "Empty input not specified — promptLoopComplete"
 */
const FRAGMENT_01a0155a = `# 10

## Target

No signature change to apply. The Done effect loop complete is done.
The path: string change. is proposed, flagged for review.

## Behavior

The promptLoopComplete builds a string of text describing loop state.
It writes a summary so the file is read back on the next load.

## Inventory

No file changes; the prompt text is assembled in memory.

## Test Strategy

Unit tests assert the prompt string; verify output formatting.

## Scope lines

- promptLoopComplete: modified

## Acceptance Criteria

1. Prompt text is produced.

## Dependencies

None.

## Findings log

(empty)`;

/**
 * 01a0b7de (fix-session-restart) — the lines that fired all 5 heuristic findings:
 *  - "Conflicting directory: B vs findLastLoopState vs and vs (Q3pin). vs has"
 *  - "Conflicting type:  vs loop"
 *  - "Invalid UTF-8 not specified — Quirks" (UTF-8 word + "round" via /run/i)
 *  - "Empty input not specified — buildResumePrompt"
 *  - "Empty input not specified — sweep"
 */
const FRAGMENT_01a0b7de = `# fix-session-restart

## Target

The sweep has a resume path B. findLastLoopState and (Q3pin). has no resume path.
The type vs loop is the interface of the loop.

## Behavior

Quirks: round 1 of the restart sweep builds a string of text and
handles UTF-8 input. The buildResumePrompt assembles text from state.

## Inventory

- src/events/session-start.ts: modified

## Test Strategy

Unit tests assert the resume prompt; verify the sweep output.

## Scope lines

- session-start: modified

## Acceptance Criteria

1. Resume prompt is built.

## Dependencies

None.

## Findings log

(empty)`;

// ---------------------------------------------------------------------------
// Acceptance Criteria 1 & 2 — session fragments yield zero fixed-detector findings
// ---------------------------------------------------------------------------

describe("session-fragment regression (core)", () => {
  it("01a0155a fragment: 0 findings from the three fixed detectors", () => {
    const analysis = analyzeSpec(FRAGMENT_01a0155a);
    expect(fixedDetectorFindings(analysis)).toEqual([]);
  });

  it("01a0155a fragment: no 'Conflicting type' / 'Conflicting directory' finding", () => {
    const analysis = analyzeSpec(FRAGMENT_01a0155a);
    expect(analysis.findings.find((f) => f.title.startsWith("Conflicting type"))).toBeUndefined();
    expect(analysis.findings.find((f) => f.title.startsWith("Conflicting directory"))).toBeUndefined();
  });

  it("01a0155a fragment: no 'I/O without error handling' finding", () => {
    const analysis = analyzeSpec(FRAGMENT_01a0155a);
    expect(analysis.findings.find((f) => f.title.includes("error handling"))).toBeUndefined();
  });

  it("01a0155a fragment: no 'Empty input not specified' finding", () => {
    const analysis = analyzeSpec(FRAGMENT_01a0155a);
    expect(analysis.findings.find((f) => f.title.includes("Empty input not specified"))).toBeUndefined();
  });

  it("01a0b7de fragment: 0 findings from the three fixed detectors", () => {
    const analysis = analyzeSpec(FRAGMENT_01a0b7de);
    expect(fixedDetectorFindings(analysis)).toEqual([]);
  });

  it("01a0b7de fragment: no 'Invalid UTF-8' finding (round no longer fires)", () => {
    const analysis = analyzeSpec(FRAGMENT_01a0b7de);
    expect(analysis.findings.find((f) => f.title.includes("Invalid UTF-8"))).toBeUndefined();
  });

  it("01a0b7de fragment: no 'Empty input' findings for prose fragments (sweep/buildResumePrompt)", () => {
    const analysis = analyzeSpec(FRAGMENT_01a0b7de);
    const emptyFindings = analysis.findings.filter((f) => f.title.includes("Empty input not specified"));
    expect(emptyFindings).toEqual([]);
  });

  it("both fragments: full analyzeSpec returns zero findings (structural complete, heuristics all suppressed)", () => {
    expect(analyzeSpec(FRAGMENT_01a0155a).findings).toEqual([]);
    expect(analyzeSpec(FRAGMENT_01a0b7de).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S2 — CONCEPT_PATTERNS: backtick-quoted values only
// ---------------------------------------------------------------------------

describe("S2 — conflicting statements (type/directory patterns)", () => {
  it("prose 'type' with no backticks does not fire", () => {
    const spec = specShell(
      "The type vs loop is the interface of the loop. " +
        "No signature change to apply. The return is done."
    );
    expect(analyzeSpec(spec).findings.filter((f) => f.category === "Example-prose conflict")).toEqual([]);
  });

  it("prose 'path: X' with no backticks does not fire", () => {
    const spec = specShell("The path: string change. is proposed. The dir: B is used.");
    expect(analyzeSpec(spec).findings.filter((f) => f.category === "Example-prose conflict")).toEqual([]);
  });

  it("backtick-quoted type stated twice with different values still fires", () => {
    const spec = specShell(
      "The type `Foo` is used in one place. " +
        "The type `Bar` is used in another."
    );
    const analysis = analyzeSpec(spec);
    const conflict = analysis.findings.find((f) => f.title.startsWith("Conflicting type"));
    expect(conflict).toBeDefined();
    expect(conflict!.title).toContain("Foo");
    expect(conflict!.title).toContain("Bar");
  });

  it("backtick-quoted directory stated twice with different values still fires", () => {
    const spec = specShell(
      "The path: `src/a` is the first location. " +
        "The path: `src/b` is the second location."
    );
    const analysis = analyzeSpec(spec);
    const conflict = analysis.findings.find((f) => f.title.startsWith("Conflicting directory"));
    expect(conflict).toBeDefined();
  });

  it("backtick-quoted type stated twice with the SAME value does not fire", () => {
    const spec = specShell(
      "The type `Foo` is used in one place. " +
        "The type `Foo` is used in another."
    );
    expect(analyzeSpec(spec).findings.filter((f) => f.category === "Example-prose conflict")).toEqual([]);
  });

  it("single backtick-quoted type mention (1 match) does not fire", () => {
    const spec = specShell("The type `Foo` is the only mention.");
    expect(analyzeSpec(spec).findings.filter((f) => f.category === "Example-prose conflict")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S3 — detectFunctionIssues tightening
// ---------------------------------------------------------------------------

describe("S3 — per-function issues (UTF-8 trigger + name gate)", () => {
  // NOTE: the S3 name-shape + backtick gate depends on extractFunctions
  // actually extracting these entries. If the extractor misses a backticked
  // signature line, the Writer must align extractFunctions output with this
  // contract (the gate filters entries; it does not create them).
  it("backtick-quoted function with string param and no empty mention still fires", () => {
    const spec = specShell(
      "The `buildResumePrompt(state string) string` assembles the resume text. " +
        "It is the entry point of the restart flow."
    );
    const analysis = analyzeSpec(spec);
    const empty = analysis.findings.find(
      (f) => f.title.includes("Empty input not specified") && f.title.includes("buildResumePrompt")
    );
    expect(empty).toBeDefined();
  });

  it("prose function name NOT backtick-quoted does not fire empty-input", () => {
    const spec = specShell(
      "The buildResumePrompt(state string) assembles the resume text. " +
        "It is the entry point of the restart flow."
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("Empty input not specified"))).toBeUndefined();
  });

  it("'round' alone (no UTF-8/unicode/multi-byte word) does not fire", () => {
    const spec = specShell(
      "The `sweep(state string) string` builds text. " +
        "It runs in round 1 of the restart."
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("Invalid UTF-8"))).toBeUndefined();
  });

  it("backtick-quoted function with unicode + no invalid mention still fires", () => {
    const spec = specShell(
      "The `decode(data string) string` converts unicode bytes. " +
        "It is the core of the pipeline."
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("Invalid UTF-8 not specified"))).toBeDefined();
  });

  it("backtick-quoted function with UTF-8 + invalid-mention does not fire", () => {
    const spec = specShell(
      "The `decode(data string) string` converts UTF-8 bytes. " +
        "Invalid input is rejected."
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("Invalid UTF-8 not specified"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// S4 — detectMissingErrorHandling scoped to ## Inventory / ## Interface
// ---------------------------------------------------------------------------

describe("S4 — I/O error handling scoping", () => {
  it("IO keyword in Inventory section with no error mention fires", () => {
    const spec = specShell(
      "Behavior prose only. The function formats a value.",
      "- src/io.ts: writes the file to disk"
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("error handling"))).toBeDefined();
  });

  it("IO keyword in Inventory with error mention anywhere does not fire", () => {
    const spec = specShell(
      "Behavior prose only. On error the function returns a fallback.",
      "- src/io.ts: writes the file to disk"
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("error handling"))).toBeUndefined();
  });

  it("IO keyword in ## Interface section fires when Inventory has none", () => {
    const spec = specShell(
      "Behavior prose only. The function formats a value.",
      "- src/format.ts: modified\n\n## Interface\n\n`load(config string) Config` — reads the file from disk."
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("error handling"))).toBeDefined();
  });

  it("IO keyword only in passing Behavior prose (no Inventory/Interface hit) does not fire", () => {
    const spec = specShell(
      "The prompt builds a value; it writes a summary so the file is read back.",
      "No file changes; the value is assembled in memory."
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("error handling"))).toBeUndefined();
  });

  it("no IO keyword anywhere does not fire", () => {
    const spec = specShell(
      "The function formats a string of text.",
      "- src/format.ts: modified"
    );
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("error handling"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// S5 — preserved detectors unchanged
// ---------------------------------------------------------------------------

describe("S5 — preserved detectors still fire on canonical inputs", () => {
  it("vague phrase 'properly' fires", () => {
    const analysis = analyzeSpec(specShell("The parser handles input properly."));
    expect(analysis.findings.find((f) => f.ambiguity.includes("properly"))).toBeDefined();
  });

  it("subjective threshold 'within 3 rounds' fires", () => {
    const analysis = analyzeSpec(specShell("The loop must settle within 3 rounds."));
    expect(analysis.findings.find((f) => f.title.includes("within 3 round"))).toBeDefined();
  });

  it("missing test strategy fires when no test/assert/verify/expect mention", () => {
    // Structurally complete except the Test Strategy section, and no
    // test/assert/verify/expect words anywhere in the prose.
    const spec = `# t\n\n## Target\nDo a thing.\n\n## Behavior\nIt works.\n\n## Inventory\n- f\n\n## Scope lines\n- f\n\n## Acceptance Criteria\n- done\n\n## Dependencies\nNone.\n\n## Findings log\n(empty)`;
    const analysis = analyzeSpec(spec);
    expect(analysis.findings.find((f) => f.title.includes("test strategy"))).toBeDefined();
  });

  it("missing test strategy does NOT fire when tests are mentioned", () => {
    const analysis = analyzeSpec(specShell("It works.", "Unit tests assert the output."));
    expect(analysis.findings.find((f) => f.title.includes("test strategy"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test Strategy item 1 — clean specs unchanged
// ---------------------------------------------------------------------------

describe("clean spec — no heuristic findings", () => {
  it("spec with no heuristic triggers yields zero findings", () => {
    const analysis = analyzeSpec(specShell("The function formats the given value."));
    expect(analysis.findings).toEqual([]);
  });

  it("session fragments: each required section header present (structural findings empty)", () => {
    for (const fragment of [FRAGMENT_01a0155a, FRAGMENT_01a0b7de]) {
      expect(analyzeSpec(fragment).findings.filter((f) => f.category === "Missing section")).toEqual([]);
    }
  });

  it("empty spec yields zero findings", () => {
    expect(analyzeSpec("").findings).toEqual([]);
  });

  it("whitespace-only spec yields zero findings", () => {
    expect(analyzeSpec("   \n  ").findings).toEqual([]);
  });

  it("single-word spec yields no findings from the three fixed detectors", () => {
    expect(fixedDetectorFindings(analyzeSpec("nothing"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S1 — buildPhaseZeroPrompt framing line
// ---------------------------------------------------------------------------

// buildPhaseZeroPrompt renders findings via buildSummaryTable/formatFinding;
// stub them so the S1 framing tests don't depend on the full Finding shape.
vi.mock("../../src/reviewer", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/reviewer")>();
  return {
    ...mod,
    buildSummaryTable: vi.fn(() => "STUB_TABLE"),
    formatFinding: vi.fn(() => "STUB_FINDING"),
  };
});

const S1_LINE =
  "Auto-generated findings below are heuristic candidates, not verified defects: verify each against the spec text; if a candidate is a false positive, reject it in a single negotiate_propose call (plan='reject-findings: <per-finding rationale>') before approving.";

describe("S1 — buildPhaseZeroPrompt framing line", () => {
  it("0 findings → framing line absent; output byte-identical to pre-change", () => {
    const out = buildPhaseZeroPrompt("SPEC", { findings: [], reasons: ["always"] });
    expect(out).toBe(
      "Phase 0: Spec Review\n\n" +
        "The spec meets the threshold for review: always\n\n" +
        "Review the spec below and check for ambiguities, missing edge cases, or underspecified behavior.\n\n" +
        "Use negotiate_propose to approve (plan='approve') or provide feedback on findings.\n\n" +
        "Spec content (0 potential findings):\n\n" +
        "SPEC"
    );
    expect(out).not.toContain("heuristic candidates");
  });

  it(">0 findings → framing line present verbatim", () => {
    const out = buildPhaseZeroPrompt("S", { findings: [{ title: "F1" } as Finding], reasons: ["always"] });
    expect(out).toContain(S1_LINE);
  });

  it("framing line sits between the negotiate_propose line and the Spec content line", () => {
    const out = buildPhaseZeroPrompt("S", { findings: [{ title: "F1" } as Finding], reasons: ["always"] });
    const approveIdx = out.indexOf("Use negotiate_propose to approve");
    const framingIdx = out.indexOf("Auto-generated findings below");
    const contentIdx = out.indexOf("Spec content (1 potential findings):");
    expect(approveIdx).toBeGreaterThan(-1);
    expect(framingIdx).toBeGreaterThan(approveIdx);
    expect(contentIdx).toBeGreaterThan(framingIdx);
  });

  it("existing pinned lines unchanged when findings > 0", () => {
    const out = buildPhaseZeroPrompt("S", { findings: [{ title: "F1" } as Finding], reasons: ["always"] });
    expect(out).toContain("Phase 0: Spec Review");
    expect(out).toContain("The spec meets the threshold for review: always");
    expect(out).toContain("Review the spec below and check for ambiguities, missing edge cases, or underspecified behavior.");
    expect(out).toContain("Use negotiate_propose to approve (plan='approve') or provide feedback on findings.");
    expect(out).toContain("Spec content (1 potential findings):");
    expect(out).toContain("S");
  });

  it("framing line appears exactly once", () => {
    const out = buildPhaseZeroPrompt("S", { findings: [{ title: "F1" } as Finding, { title: "F2" } as Finding], reasons: ["always"] });
    const matches = out.match(/Auto-generated findings below/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty, undefined-ish, single element
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("buildPhaseZeroPrompt with empty spec text and 0 findings", () => {
    const out = buildPhaseZeroPrompt("", { findings: [], reasons: ["always"] });
    expect(out).not.toContain("heuristic candidates");
    expect(out).toContain("Spec content (0 potential findings):");
  });

  it("buildPhaseZeroPrompt with exactly 1 finding renders framing line once", () => {
    const out = buildPhaseZeroPrompt("S", { findings: [{ title: "F1" } as Finding], reasons: [] });
    const matches = out.match(/Auto-generated findings below/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("analyzeSpec with empty string returns empty analysis (no crash)", () => {
    const analysis = analyzeSpec("");
    expect(analysis.findings).toEqual([]);
    expect(Array.isArray(analysis.reasons)).toBe(true);
  });

  it("analyzeSpec with a spec containing only a title", () => {
    const analysis = analyzeSpec("# title only");
    expect(Array.isArray(analysis.findings)).toBe(true);
  });

  it("fixedDetectorFindings helper returns [] for a clean analysis", () => {
    expect(fixedDetectorFindings(analyzeSpec(specShell("It works.")))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixture helper — a structurally-complete spec (no structural findings)
// with overridable Behavior and Inventory section bodies. The Test Strategy
// section always mentions "Unit tests" so the missing-test-strategy detector
// stays quiet unless a test overrides by supplying its own full spec.
// ---------------------------------------------------------------------------

function specShell(
  behavior = "The function formats the given value.",
  inventory = "- src/format.ts: modified"
): string {
  return [
    "# t",
    "",
    "## Target",
    "Do a thing.",
    "",
    "## Behavior",
    behavior,
    "",
    "## Inventory",
    inventory,
    "",
    "## Test Strategy",
    "Unit tests assert the output.",
    "",
    "## Scope lines",
    "- src/format.ts: modified",
    "",
    "## Acceptance Criteria",
    "- tsc clean",
    "",
    "## Dependencies",
    "None.",
    "",
    "## Findings log",
    "(empty)",
  ].join("\n");
}
