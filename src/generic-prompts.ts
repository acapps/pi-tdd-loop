// --- Language-agnostic prompts ---
// Negotiation, dispute, and generic flow prompts shared across all languages.
// Language-specific patterns are injected via parameters.

// --- Negotiate ---

export function promptWriterNegotiate(specPath: string, testFilePattern: string): string {
  return `WRITER (negotiation).

Read ${specPath}. Then review ${testFilePattern} — understand all test cases.
Find contradictions or ambiguities: conflicting rules, undifferentiated errors, weak assertions.
Surface these in your proposal — do not silently pick an interpretation.

Use negotiate_propose: 'agree' if tests match spec, or describe your approach (types, functions, behavior).
Do NOT write files. Tester reviews via negotiate_review.`;
}

export function promptNegotiateProposalForReview(plan: string): string {
  return `Writer proposes:

${plan}

Review. "approve" to accept, or suggest changes via negotiate_review.`;
}

export function promptNegotiateFeedback(decision: string): string {
  return `Tester feedback:

${decision}

Revise and propose again via negotiate_propose. Do NOT write files.`;
}

export function promptNegotiateRepromptWriter(): string {
  return `Must use negotiate_propose. Do NOT write files.

Call negotiate_propose now:
  - plan='agree' if tests match spec, OR
  - plan='your approach'`;
}

export function promptNegotiateRepromptTester(): string {
  return `Must use negotiate_review. Do NOT write files.

Call negotiate_review now:
  - decision='approve' if accept, OR
  - decision='feedback'`;
}

// --- Dispute ---

export function promptWriterDispute(claim: string): string {
  return `Tests still fail. You filed this dispute:

${claim}

Use negotiate_review to proceed:
  - decision='approve' → escalate: you insist the test is wrong, Tester must fix it
  - decision='I will fix my code' → concede: you'll rewrite your implementation to pass the test

Do not write files. Call negotiate_review now.`;
}

export function promptWriterDisputeDefended(decision: string): string {
  return `Tester defended the test:

${decision}

Fix your implementation or raise a new dispute with evidence.`;
}
