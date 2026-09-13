// --- execSync error handling ---
// child_process.execSync throws an Error carrying the process output; this
// types that shape so callers never need `err: any`.

/** The error shape thrown by child_process.execSync on a non-zero exit. */
export interface ExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

/**
 * Human-readable message from an execSync failure: prefer stderr, then
 * stdout, then the error message.
 */
export function execErrorMessage(err: unknown): string {
  const e = err as Partial<ExecError>;
  const parts = [e.stderr, e.stdout, e.message].filter(
    (p): p is string | Buffer => typeof p === "string" || Buffer.isBuffer(p),
  );
  const joined = parts.join("\n");
  return joined.trim() || "Unknown error";
}
