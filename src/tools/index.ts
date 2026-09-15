// Stub — the Writer replaces this with the real re-exports.
// Public API (internal/refactor-tools-split.md): negotiatePropose,
// negotiateReview, isAgreeProposal.

export async function negotiatePropose(
  state: unknown,
  pi: unknown,
  debug: unknown,
): Promise<unknown> {
  throw new Error("not implemented");
}

export async function negotiateReview(
  state: unknown,
  pi: unknown,
  debug: unknown,
): Promise<unknown> {
  throw new Error("not implemented");
}

export function isAgreeProposal(lastProposal: string): boolean {
  void lastProposal;
  throw new Error("not implemented");
}
