// Unit tests for src/exec-error.ts — execErrorMessage.
//
// Contract (as implemented in exec-error.ts):
//   - execErrorMessage renders a human-readable message from the error shape
//     thrown by child_process.execSync.
//   - It concatenates stderr, stdout, then the error message IN THAT ORDER,
//     keeping only string or Buffer fields (anything else is dropped). The
//     "prefer" wording in the doc comment means concatenation order, not
//     "take stderr only".
//   - The surviving parts are joined with "\n" and trimmed; when nothing
//     survives it returns "Unknown error".
//
// No vi.mock: the function is pure, operating on plain error-shaped objects.

import { describe, it, expect } from "vitest";
import { execErrorMessage } from "../src/exec-error";
import type { ExecError } from "../src/exec-error";

function err(overrides: Partial<ExecError> = {}): ExecError {
  // Only set message when explicitly provided, so stderr/stdout-only cases
  // don't pick up a default "boom" message.
  const e = (overrides.message !== undefined
    ? new Error(overrides.message)
    : new Error()) as ExecError;
  if (overrides.stderr !== undefined) e.stderr = overrides.stderr;
  if (overrides.stdout !== undefined) e.stdout = overrides.stdout;
  return e;
}

describe("execErrorMessage — concatenation order (stderr, stdout, message)", () => {
  it("lists all three fields in order when all are present", () => {
    const msg = execErrorMessage(err({
      stderr: "STDERR text",
      stdout: "STDOUT text",
      message: "ERR message",
    }));
    expect(msg).toBe("STDERR text\nSTDOUT text\nERR message");
  });

  it("omits stderr but keeps stdout then message when stderr is absent", () => {
    const msg = execErrorMessage(err({
      stdout: "STDOUT text",
      message: "ERR message",
    }));
    expect(msg).toBe("STDOUT text\nERR message");
  });

  it("uses only the message when stderr and stdout are absent", () => {
    expect(execErrorMessage(err({ message: "the message" }))).toBe("the message");
  });
});

describe("execErrorMessage — filtering and joining", () => {
  it("joins stderr and stdout with a newline when both are strings", () => {
    const msg = execErrorMessage(err({ stderr: "line-a", stdout: "line-b" }));
    expect(msg).toBe("line-a\nline-b");
  });

  it("includes Buffer fields (Buffer.isBuffer) alongside strings", () => {
    const msg = execErrorMessage(err({
      stderr: Buffer.from("buf-err"),
      stdout: Buffer.from("buf-out"),
    }));
    expect(msg).toBe("buf-err\nbuf-out");
  });

  it("drops non-string, non-Buffer fields (undefined, numbers, objects)", () => {
    const msg = execErrorMessage({
      stderr: "kept",
      stdout: undefined,
      code: 1 as unknown as string | Buffer,
      detail: { nested: true } as unknown as string | Buffer,
      message: "ignored-message",
    } as unknown as ExecError);
    expect(msg).toBe("kept\nignored-message");
  });

  it("trims only the leading/trailing whitespace of the whole joined result", () => {
    // .trim() operates on the whole string, not per-line: the internal
    // whitespace between parts is preserved.
    const msg = execErrorMessage(err({ stderr: "  padded  ", stdout: "\t tabby \n" }));
    expect(msg).toBe("padded  \n\t tabby");
  });
});

describe("execErrorMessage — empty / recoverable input", () => {
  it("returns 'Unknown error' when every field is empty", () => {
    const msg = execErrorMessage(err({ stderr: "", stdout: "", message: "" }));
    expect(msg).toBe("Unknown error");
  });

  it("returns 'Unknown error' when the message is only whitespace", () => {
    expect(execErrorMessage(err({ message: "   \n\t " }))).toBe("Unknown error");
  });

  it("returns 'Unknown error' for a plain object with no error-shaped fields", () => {
    expect(execErrorMessage({ foo: "bar" } as unknown as ExecError)).toBe("Unknown error");
  });

  it("returns 'Unknown error' for a string or number (no error shape, but no throw)", () => {
    expect(execErrorMessage("a plain string")).toBe("Unknown error");
    expect(execErrorMessage(42)).toBe("Unknown error");
  });
});

// --- Regression: null/undefined must yield "Unknown error", not throw ---
// execErrorMessage's signature is (err: unknown) and it exists to always
// produce a readable message, so null/undefined must return "Unknown error"
// rather than throwing TypeError when reading a property. See the fix in
// src/exec-error.ts.
describe("execErrorMessage — null/undefined recovery", () => {
  it("returns 'Unknown error' for null instead of throwing", () => {
    expect(execErrorMessage(null)).toBe("Unknown error");
  });

  it("returns 'Unknown error' for undefined instead of throwing", () => {
    expect(execErrorMessage(undefined)).toBe("Unknown error");
  });
});
