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

  it("'i agree' (not starting with the token) → false", () => {
    expect(isAgreeProposal("i agree")).toBe(false);
  });

  it("case-insensitive tail form: 'AGREE: yes' → true", () => {
    expect(isAgreeProposal("AGREE: yes")).toBe(true);
  });

  // Session 01a0a668: Writer sent "agree\n\nTests match the spec..." —
  // trailing explanation, not a condition. Must be treated as agree.
  it("'agree\\n\\nTests match the spec' → true (trailing explanation)", () => {
    expect(isAgreeProposal("agree\n\nTests match the spec. Implementation plan: ...")).toBe(true);
  });

  it("'agree. Tests match' → true (period separator)", () => {
    expect(isAgreeProposal("agree. Tests match")).toBe(true);
  });

  it("'agree, and here is why' → true (comma separator)", () => {
    expect(isAgreeProposal("agree, and here is why")).toBe(true);
  });

  it("'agreed' → false (word boundary: 'e' after 'agree')", () => {
    expect(isAgreeProposal("agreed")).toBe(false);
  });

  it("'agreement' → false (word boundary)", () => {
    expect(isAgreeProposal("agreement")).toBe(false);
  });
});
