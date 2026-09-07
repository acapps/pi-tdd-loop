// Contract tests for promptNegotiateRepromptWriter (new shape) and the
// promptNegotiateContractReReview trailing sentence.
// Spec: internal/bug-negotiate-confirm-approval-loop.md §2, §3.
//
// Pinned contract:
//  - §3: the reprompt carries the current round and the last proposal
//    (truncated to 200 chars + ellipsis). Empty-proposal edge pinned: the
//    trailing period belongs to the empty clause slot ("round 3.").
//  - §2: the re-review prompt ends with the pinned advance sentence.

import { describe, it, expect } from "vitest";
import * as GP from "../src/generic-prompts";

describe("promptNegotiateRepromptWriter (fix-negotiate-confirm-approval-loop §3)", () => {
  it("round + non-empty proposal → 'Current state: negotiate round N; last proposal: X.'", () => {
    const prompt = GP.promptNegotiateRepromptWriter(3, "plan X");
    expect(prompt).toContain("Must use negotiate_propose. Do NOT write files.");
    expect(prompt).toContain("Current state: negotiate round 3; last proposal: plan X.");
    expect(prompt).toContain("plan='agree' if tests match spec");
    expect(prompt).toContain("plan='your approach'");
  });

  it("exact full shape (pinned)", () => {
    expect(GP.promptNegotiateRepromptWriter(2, "plan X")).toBe(
      `Must use negotiate_propose. Do NOT write files.\n\nCurrent state: negotiate round 2; last proposal: plan X....\nCall negotiate_propose now:\n  - plan='agree' if tests match spec, OR\n  - plan='your approach'`,
    );
  });

  it("empty proposal → the trailing period belongs to the empty clause slot ('round 3.')", () => {
    const prompt = GP.promptNegotiateRepromptWriter(3, "");
    expect(prompt).toContain("Current state: negotiate round 3.");
    expect(prompt).not.toContain("last proposal");
    expect(prompt).toBe(
      `Must use negotiate_propose. Do NOT write files.\n\nCurrent state: negotiate round 3.\nCall negotiate_propose now:\n  - plan='agree' if tests match spec, OR\n  - plan='your approach'`,
    );
  });

  it("long proposal is truncated to 200 chars + ellipsis (201st char not visible)", () => {
    const long = "a".repeat(201);
    const prompt = GP.promptNegotiateRepromptWriter(1, long);
    expect(prompt).toContain("a".repeat(200) + "...");
    expect(prompt).not.toContain("a".repeat(201) + "...");
  });

  it("proposal of exactly 200 chars is shown in full (no early cut)", () => {
    const exact = "b".repeat(200);
    const prompt = GP.promptNegotiateRepromptWriter(1, exact);
    expect(prompt).toContain(`last proposal: ${exact}...`);
  });
});

describe("promptNegotiateContractReReview trailing sentence (fix-negotiate-confirm-approval-loop §2)", () => {
  it("ends with the pinned advance sentence (Go pattern)", () => {
    const prompt = GP.promptNegotiateContractReReview("*_test.go");
    expect(prompt).toContain("You are the TESTER (contract re-review)");
    expect(prompt).toContain("Read *_test.go.");
    expect(prompt).toContain("No file writes.");
    expect(prompt).toBe(
      `You are the TESTER (contract re-review). The Writer's proposal was accepted. Verify the contract file matches the agreement.\nRead *_test.go. Use negotiate_review: 'approve' only if the file matches; otherwise feedback naming each drifted item.\nNo file writes.\nAn 'approve' here advances the loop to Phase B.`,
    );
  });

  it("the advance sentence is the LAST line", () => {
    const prompt = GP.promptNegotiateContractReReview("src/**/*.test.ts");
    const lines = prompt.split("\n");
    expect(lines[lines.length - 1]).toBe("An 'approve' here advances the loop to Phase B.");
  });
});
