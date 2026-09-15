// Contract tests for isAgreeProposal.
// Spec: internal/bug-negotiate-confirm-approval-loop.md §1 + session 01a0a668.
//
// Pinned contract: a Writer proposal is a confirmation iff the first word
// (after optional leading fillers like "i", "yes", "ok") is "agree" or
// "agreed". Trailing text is explanation, not a condition.

import { describe, it, expect } from "vitest";
import { isAgreeProposal } from "../src/tools";

describe("isAgreeProposal", () => {
  // --- Core matches ---

  it("lexically 'agree' → true", () => {
    expect(isAgreeProposal("agree")).toBe(true);
  });

  it("any case: 'AGREE', 'Agree' → true", () => {
    expect(isAgreeProposal("AGREE")).toBe(true);
    expect(isAgreeProposal("Agree")).toBe(true);
  });

  it("trimmed: '  agree  ' → true", () => {
    expect(isAgreeProposal("  agree  ")).toBe(true);
  });

  it("'agreed' → true (past tense is still agreement)", () => {
    expect(isAgreeProposal("agreed")).toBe(true);
  });

  it("'agreed — tests match' → true", () => {
    expect(isAgreeProposal("agreed — tests match")).toBe(true);
  });

  // --- Leading fillers ---

  it("'i agree' → true (leading filler stripped)", () => {
    expect(isAgreeProposal("i agree")).toBe(true);
  });

  it("'i agree with the tests' → true", () => {
    expect(isAgreeProposal("i agree with the tests")).toBe(true);
  });

  it("'yes, agree' → true (leading filler + comma)", () => {
    expect(isAgreeProposal("yes, agree")).toBe(true);
  });

  it("'ok, agreed' → true (leading filler)", () => {
    expect(isAgreeProposal("ok, agreed")).toBe(true);
  });

  it("'sure, agree' → true (leading filler)", () => {
    expect(isAgreeProposal("sure, agree")).toBe(true);
  });

  it("'yeah, i agree' → true (double filler)", () => {
    expect(isAgreeProposal("yeah, i agree")).toBe(true);
  });

  // --- Trailing explanation (session 01a0a668) ---

  it("'agree\\n\\nTests match the spec' → true (trailing explanation)", () => {
    expect(isAgreeProposal("agree\n\nTests match the spec. Implementation plan: ...")).toBe(true);
  });

  it("'agree. Tests match' → true (period separator)", () => {
    expect(isAgreeProposal("agree. Tests match")).toBe(true);
  });

  it("'agree, and here is why' → true (comma separator)", () => {
    expect(isAgreeProposal("agree, and here is why")).toBe(true);
  });

  it("'agree: confirmed' → true (colon separator)", () => {
    expect(isAgreeProposal("agree: confirmed")).toBe(true);
  });

  it("'agree — confirmed' (em dash) → true", () => {
    expect(isAgreeProposal("agree — confirmed")).toBe(true);
  });

  // --- Non-matches ---

  it("'agreement reached' → false (different first word)", () => {
    expect(isAgreeProposal("agreement reached")).toBe(false);
  });

  it("a real contract proposal → false", () => {
    expect(isAgreeProposal("Use struct-based approach with interface for the gateway")).toBe(false);
  });

  it("empty string → false (no proposal yet)", () => {
    expect(isAgreeProposal("")).toBe(false);
  });

  it("empty/whitespace-only → false", () => {
    expect(isAgreeProposal("   ")).toBe(false);
  });

  it("'I disagree' → false", () => {
    expect(isAgreeProposal("I disagree")).toBe(false);
  });

  it("'I agree, but only if we change X' → true (filler stripped, 'agree' is first word after)", () => {
    // After stripping "i", the first word is "agree". The "but only if"
    // is a condition, but the Writer is still expressing agreement with
    // the overall direction. The negotiate loop handles conditions via
    // the Tester's review, not via the agree check.
    expect(isAgreeProposal("I agree, but only if we change X")).toBe(true);
  });

  it("case-insensitive: 'AGREED' → true", () => {
    expect(isAgreeProposal("AGREED")).toBe(true);
  });

  it("case-insensitive: 'Yes, AGREE' → true", () => {
    expect(isAgreeProposal("Yes, AGREE")).toBe(true);
  });
});
