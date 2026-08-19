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

// Spec 10: the run's last word — delivered by applyDoneEffect into the
// conversation transcript (the toast/status bar stay as-is).
export function promptLoopComplete(
  specPath: string,
  disputes: number,
  cleanerFailed: boolean,
): string {
  if (cleanerFailed) {
    return `Loop complete — spec ${specPath}. Phase C failed; the original code is kept. Disputes raised: ${disputes}.`;
  }
  return `Loop complete — spec ${specPath}. All phases passed the gate. Disputes raised: ${disputes}.`;
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

// Spec 09 (F-C): the retired filer-addressed dispute prompt was deleted with its retry-branch
// caller — reviewer-addressed prompts below replace it.

export function promptTesterReviewWriterDispute(claim: string): string {
  return `TESTER (dispute review). The Writer disputed a test:

${claim}

Use negotiate_review to proceed:
  - decision='approve' → you concede: the test is wrong; you will fix it
  - decision='<your rebuttal>' → you defend the test; the Writer must fix the code

Do not write files. Call negotiate_review now.`;
}

export function promptWriterDisputeReview(claim: string): string {
  return `WRITER (dispute review). The Tester reported:

${claim}

Use negotiate_review to proceed:
  - decision='approve' → you accept the findings; you will fix the flagged file(s)
  - decision='<your rebuttal>' → you defend your implementation; the report is rejected

Do not write files. Call negotiate_review now.`;
}

export function promptWriterConcedeFix(claim: string): string {
  return `WRITER (dispute fix). You accepted the Tester's report:

${claim}

Fix the flagged file(s) to resolve it. Write source files only.
When done, stop producing tool calls.`;
}

export function promptTesterReportRejected(decision: string): string {
  return `TESTER (dispute). Your report was rejected. The Writer's defense:

${decision}

Verify the defense against the spec and the code, then continue Phase B.
When done, stop producing tool calls.`;
}

export function promptWriterDisputeDefended(decision: string): string {
  return `Tester defended the test:

${decision}

Fix your implementation or raise a new dispute with evidence.`;
}

// --- Gate error / coverage (bug-gate-signal-integrity) ---

export function promptGateError(error: string): string {
  return `Gate could not run: ${error}. Fix the environment and retry.`;
}

export function promptCoverageBelowThreshold(coverage: number, threshold: number): string {
  return `Coverage ${coverage}% is below the ${threshold}% threshold.`;
}
