// Unit tests for prompts module (language-agnostic + language-specific)

import { describe, it, expect } from "vitest";
import * as GP from "../src/generic-prompts";
import { getLanguageConfig } from "../src/languages";

// Ensure languages are initialized
getLanguageConfig("go");

describe("Phase A prompts (Go)", () => {
  const prompts = getLanguageConfig("go").prompts;

  it("promptTesterPhaseA includes spec path", () => {
    const prompt = prompts.promptTesterPhaseA("path/to/spec.md", "maven");
    expect(prompt).toContain("TESTER");
    expect(prompt).toContain("path/to/spec.md");
    expect(prompt).toContain("*.go");
    expect(prompt).toContain("*_test.go");
  });

  it("promptTesterPhaseARestart delegates to full prompt", () => {
    const restart = prompts.promptTesterPhaseARestart("spec.md", "maven");
    const full = prompts.promptTesterPhaseA("spec.md", "maven");
    expect(restart).toBe(full);
    expect(restart).toContain("spec.md");
    expect(restart).toContain("TESTER");
  });

  it("promptTesterCompileRetry includes error message", () => {
    const prompt = prompts.promptTesterCompileRetry("undefined: type mismatch");
    expect(prompt).toContain("Compilation failed");
    expect(prompt).toContain("type mismatch");
  });
});

describe("Phase A prompts (Java)", () => {
  const prompts = getLanguageConfig("java").prompts;

  it("promptTesterPhaseA includes build file and JUnit references", () => {
    const prompt = prompts.promptTesterPhaseA("path/to/spec.md", "maven");
    expect(prompt).toContain("TESTER");
    expect(prompt).toContain("path/to/spec.md");
    expect(prompt).toContain("pom.xml");
    expect(prompt).toContain("JUnit");
  });

  it("promptTesterPhaseA uses build.gradle for Gradle", () => {
    const prompt = prompts.promptTesterPhaseA("path/to/spec.md", "gradle");
    expect(prompt).toContain("build.gradle");
    expect(prompt).not.toContain("pom.xml");
  });

  it("promptTesterPhaseARestart delegates to full prompt", () => {
    const restart = prompts.promptTesterPhaseARestart("spec.md", "gradle");
    const full = prompts.promptTesterPhaseA("spec.md", "gradle");
    expect(restart).toBe(full);
  });
});

describe("Phase A prompts (TypeScript)", () => {
  const prompts = getLanguageConfig("typescript").prompts;

  it("promptTesterPhaseA includes TypeScript references", () => {
    const prompt = prompts.promptTesterPhaseA("path/to/spec.md", "maven");
    expect(prompt).toContain("TESTER");
    expect(prompt).toContain("path/to/spec.md");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("*.ts");
    expect(prompt).toContain("*.test.ts");
  });

  it("promptTesterPhaseARestart delegates to full prompt", () => {
    const restart = prompts.promptTesterPhaseARestart("spec.md", "maven");
    const full = prompts.promptTesterPhaseA("spec.md", "maven");
    expect(restart).toBe(full);
  });
});

describe("Negotiate prompts (language-agnostic)", () => {
  it("promptWriterNegotiate includes spec path and tool reference", () => {
    const prompt = GP.promptWriterNegotiate("spec.md", "*_test.go");
    expect(prompt).toContain("WRITER");
    expect(prompt).toContain("negotiate_propose");
    expect(prompt).toContain("spec.md");
  });

  it("promptNegotiateProposalForReview includes plan", () => {
    const prompt = GP.promptNegotiateProposalForReview("Use struct-based approach");
    expect(prompt).toContain("Writer proposes");
    expect(prompt).toContain("struct-based approach");
  });

  it("promptNegotiateFeedback includes decision", () => {
    const prompt = GP.promptNegotiateFeedback("Consider an interface instead");
    expect(prompt).toContain("Tester feedback");
    expect(prompt).toContain("interface instead");
  });
});

describe("promptLoopComplete (spec 10)", () => {
  it("clean-finish branch: exact string with interpolated specPath and disputes", () => {
    expect(GP.promptLoopComplete("internal/07.md", 2, false)).toBe(
      "Loop complete — spec internal/07.md. All phases passed the gate. Disputes raised: 2.",
    );
  });

  it("clean-finish branch: zero disputes reads as a count, not a flag", () => {
    expect(GP.promptLoopComplete("spec.md", 0, false)).toBe(
      "Loop complete — spec spec.md. All phases passed the gate. Disputes raised: 0.",
    );
  });

  it("Phase-C-failed branch: exact string with interpolated specPath and disputes", () => {
    expect(GP.promptLoopComplete("internal/07.md", 2, true)).toBe(
      "Loop complete — spec internal/07.md. Phase C failed; the original code is kept. Disputes raised: 2.",
    );
  });

  it("Phase-C-failed branch: zero disputes", () => {
    expect(GP.promptLoopComplete("spec.md", 0, true)).toBe(
      "Loop complete — spec spec.md. Phase C failed; the original code is kept. Disputes raised: 0.",
    );
  });

  it("single-character spec path interpolates verbatim", () => {
    expect(GP.promptLoopComplete("a.md", 1, false)).toBe(
      "Loop complete — spec a.md. All phases passed the gate. Disputes raised: 1.",
    );
  });
});

describe("Negotiate auto-advance prompts", () => {
  it("Go auto-advance mentions Go conventions", () => {
    const prompt = getLanguageConfig("go").prompts.promptNegotiateAutoAdvance();
    expect(prompt).toContain("without explicit");
    expect(prompt).toContain("errors.Is");
  });

  it("Java auto-advance mentions Java conventions", () => {
    const prompt = getLanguageConfig("java").prompts.promptNegotiateAutoAdvance();
    expect(prompt).toContain("without explicit");
    expect(prompt).toContain("AssertJ");
  });

  it("TypeScript auto-advance mentions TS conventions", () => {
    const prompt = getLanguageConfig("typescript").prompts.promptNegotiateAutoAdvance();
    expect(prompt).toContain("without explicit");
    expect(prompt).toContain("Strict types");
  });
});

describe("Phase B prompts (Go)", () => {
  const prompts = getLanguageConfig("go").prompts;

  it("promptWriterPhaseB mentions implementation", () => {
    const prompt = prompts.promptWriterPhaseB();
    expect(prompt).toContain("Phase B");
    expect(prompt).toContain("Write Go source files");
  });

  it("promptWriterPhaseBContinue shows failures", () => {
    const prompt = prompts.promptWriterPhaseBContinue("fail 1\nfail 2", 2);
    expect(prompt).toContain("Tests failed");
    expect(prompt).toContain("fail 1");
  });

  it("promptWriterPhaseB is used when tests pass", () => {
    const prompt = prompts.promptWriterPhaseB();
    expect(prompt).toContain("Phase B");
    expect(prompt).toContain("Write Go source files");
  });
});

describe("Phase B dispute prompts", () => {
  // The retired filer-addressed dispute prompt pin was REMOVED (spec 09, F-C):
  // the function is deleted with its only caller (the retired retry branch) —
  // reviewer-addressed prompts replace it. Sweep: rg -n "\\bpromptWriterDispute\\b" src/ test/ → 0.

  it("promptWriterDisputeDefended includes defense (unchanged text)", () => {
    const prompt = GP.promptWriterDisputeDefended("The spec clearly states this behavior");
    expect(prompt).toContain("Tester defended");
    expect(prompt).toContain("spec clearly states");
  });

  it("promptTesterReviewWriterDispute is reviewer-addressed with the claim (Table 1, writer filer)", () => {
    const prompt = GP.promptTesterReviewWriterDispute("Test X/edge_case expects nil but spec says return zero-value");
    expect(prompt).toContain("TESTER (dispute review)");
    expect(prompt).toContain("expects nil");
    expect(prompt).toContain("negotiate_review");
    expect(prompt).toContain("you concede");
    expect(prompt).toContain("you defend the test");
    expect(prompt).toContain("Do not write files");
  });

  it("promptWriterDisputeReview is reviewer-addressed with the report (Table 1, tester filer)", () => {
    const prompt = GP.promptWriterDisputeReview("Your refactor broke the retry path");
    expect(prompt).toContain("WRITER (dispute review)");
    expect(prompt).toContain("broke the retry path");
    expect(prompt).toContain("negotiate_review");
    expect(prompt).toContain("you accept the findings");
    expect(prompt).toContain("you defend your implementation");
    expect(prompt).toContain("Do not write files");
  });

  it("promptWriterConcedeFix includes the claim and source-only instruction (Table 3 row 2)", () => {
    const prompt = GP.promptWriterConcedeFix("Your refactor broke the retry path");
    expect(prompt).toContain("WRITER (dispute fix)");
    expect(prompt).toContain("broke the retry path");
    expect(prompt).toContain("Fix the flagged file(s)");
    expect(prompt).toContain("Write source files only");
  });

  it("promptTesterReportRejected includes the defense, no re-dispute option (N1)", () => {
    const prompt = GP.promptTesterReportRejected("The refactor is correct; the report misread the spec.");
    expect(prompt).toContain("TESTER (dispute)");
    expect(prompt).toContain("Your report was rejected");
    expect(prompt).toContain("misread the spec");
    expect(prompt).toContain("Verify the defense");
    // N1: the re-dispute option is deliberately absent (would self-route).
    expect(prompt).not.toContain("raise a new dispute");
    expect(prompt).not.toContain("negotiate_propose");
  });
});

describe("Dispute fix prompts", () => {
  it("Go dispute fix mentions *_test.go", () => {
    const prompt = getLanguageConfig("go").prompts.promptTesterDisputeFix();
    expect(prompt).toContain("Conceded dispute");
    expect(prompt).toContain("*_test.go");
  });

  it("Java dispute fix mentions *Test.java", () => {
    const prompt = getLanguageConfig("java").prompts.promptTesterDisputeFix();
    expect(prompt).toContain("Conceded dispute");
    expect(prompt).toContain("*Test.java");
  });

  it("TypeScript dispute fix mentions *.test.ts", () => {
    const prompt = getLanguageConfig("typescript").prompts.promptTesterDisputeFix();
    expect(prompt).toContain("Conceded dispute");
    expect(prompt).toContain("*.test.ts");
  });
});

describe("Phase C prompts (Go)", () => {
  const prompts = getLanguageConfig("go").prompts;

  it("promptCleanerPhaseC mentions refactoring rules", () => {
    const prompt = prompts.promptCleanerPhaseC();
    expect(prompt).toContain("Cleaner");
    expect(prompt).toContain("No method over 200 lines");
    expect(prompt).toContain("Return early");
  });

  it("promptCleanerRestart delegates to full prompt", () => {
    const restart = prompts.promptCleanerRestart();
    const full = prompts.promptCleanerPhaseC();
    expect(restart).toBe(full);
  });

  it("promptCleanerRetry mentions broken tests", () => {
    const prompt = prompts.promptCleanerRetry("fail A", 1);
    expect(prompt).toContain("Refactoring broke 1 test");
    expect(prompt).toContain("fail A");
  });
});

describe("Phase C prompts (Java)", () => {
  const prompts = getLanguageConfig("java").prompts;

  it("promptCleanerPhaseC mentions Java-specific rules", () => {
    const prompt = prompts.promptCleanerPhaseC();
    expect(prompt).toContain("Cleaner");
    expect(prompt).toContain("50 lines"); // Java methods should be shorter
    expect(prompt).toContain("Records");
  });
});

describe("Phase C prompts (TypeScript)", () => {
  const prompts = getLanguageConfig("typescript").prompts;

  it("promptCleanerPhaseC mentions TS-specific rules", () => {
    const prompt = prompts.promptCleanerPhaseC();
    expect(prompt).toContain("Cleaner");
    expect(prompt).toContain("30 lines"); // TS functions should be shorter
    expect(prompt).toContain("const");
  });
});

describe("Enforcement refusal messages", () => {
  it("Go negotiation refusal", () => {
    const msg = getLanguageConfig("go").refusalMessage.negotiate;
    expect(msg).toContain("Negotiation");
  });

  it("Go phase A refusal", () => {
    const msg = getLanguageConfig("go").refusalMessage.phaseA;
    expect(msg).toContain("Phase A");
  });

  it("Java negotiation refusal", () => {
    const msg = getLanguageConfig("java").refusalMessage.negotiate;
    expect(msg).toContain("Negotiation");
  });
});

describe("Language detection", () => {
  it("detects go from go.mod", () => {
    const lang = getLanguageConfig("go");
    expect(lang.key).toBe("go");
    expect(lang.isTestFile("handler_test.go")).toBe(true);
    expect(lang.isTestFile("handler.go")).toBe(false);
  });

  it("detects java test files", () => {
    const lang = getLanguageConfig("java");
    expect(lang.key).toBe("java");
    expect(lang.isTestFile("VehicleTest.java")).toBe(true);
    expect(lang.isTestFile("Vehicle.java")).toBe(false);
  });

  it("detects typescript test files", () => {
    const lang = getLanguageConfig("typescript");
    expect(lang.key).toBe("typescript");
    expect(lang.isTestFile("vehicle.test.ts")).toBe(true);
    expect(lang.isTestFile("vehicle.spec.ts")).toBe(true);
    expect(lang.isTestFile("vehicle.ts")).toBe(false);
  });
});
