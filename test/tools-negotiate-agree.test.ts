// Contract tests for isAgreeProposal.
// Spec: internal/bug-negotiate-confirm-approval-loop.md §1 (Behavior §1).
//
// Pinned contract: a Writer proposal is a confirmation iff it is lexically
// "agree" (any case, trimmed) or starts with one of the closed tail forms
// "agree:" / "agree —" (em dash) / "agree -" (ASCII dash). Word-boundary:
// "agreement reached" is NOT a match.

import { describe, it, expect } from "vitest";
import { isAgreeProposal } from "../src/tools";

describe("isAgreeProposal", () => {
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

  it("'agree: confirmed' → true (closed tail form, colon)", () => {
    expect(isAgreeProposal("agree: confirmed")).toBe(true);
  });

  it("'agree — confirmed' (em dash) → true", () => {
    expect(isAgreeProposal("agree — confirmed")).toBe(true);
  });

  it("'agree - confirmed' (ASCII dash) → true", () => {
    expect(isAgreeProposal("agree - confirmed")).toBe(true);
  });

  it("'agreement reached' → false (word boundary — the bug case)", () => {
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

  it("'agreed' (past tense, not in the closed set) → false", () => {
    expect(isAgreeProposal("agreed")).toBe(false);
  });

  it("'i agree' (not starting with the token) → false", () => {
    expect(isAgreeProposal("i agree")).toBe(false);
  });

  it("case-insensitive tail form: 'AGREE: yes' → true", () => {
    expect(isAgreeProposal("AGREE: yes")).toBe(true);
  });
});
