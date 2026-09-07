// S2 simulation — the gate must spawn `npx vitest run --coverage` for
// typescript projects. We assert the spawn contract (command, args, cwd,
// callback semantics) with a mocked execFile; we do NOT actually run npx,
// which would resolve/download vitest into a bare temp dir and take
// tens of seconds per run.
// NOTE (2026-07-21): all tests it()'d pending
// internal/bug-slow-gate-signal-tests.md — the file hangs the whole suite
// indefinitely under vitest 4.1.10 + node 26 (even with a fully mocked
// execFile). The spawn contract is covered by test/gates.test.ts (fast).
// Re-enable after the bug spec is resolved.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

// Provider probe boundary: resolve the coverage provider so the command
// carries --coverage (the S2 simulation pins the full spawn contract).
vi.mock("node:module", () => ({
  createRequire: vi.fn(() => ({ resolve: () => "/fake/node_modules/@vitest/coverage-v8/index.js" })),
}));

// vi.mock replaces execFile with a controllable fake for this file only.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { getTestCommand, runGates } from "../src/gates";

const mockCreateRequire = vi.mocked(createRequire);

describe("nested vitest spawn (S2 simulation)", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    mockCreateRequire.mockReturnValue({ resolve: () => "/fake/node_modules/@vitest/coverage-v8/index.js" } as never);
  });

  it("typescript gate command is exactly `npx vitest run --coverage`", () => {
    expect(getTestCommand("typescript")).toBe("npx vitest run --coverage");
  });

  it("runGates spawns npx vitest run --coverage (no shell, correct cwd)", async () => {
    execFileMock.mockReset();
    // Compile step (`npx tsc --noEmit`) exits 0; test step exits 0 with a
    // coverage table row.
    execFileMock.mockImplementation(
      (file: string, args: string[], opts: { cwd: string }, cb: Function) => {
        if (file === "npx" && args[0] === "tsc") return cb(null, "", "");
        if (file === "npx" && args[0] === "vitest") {
          expect(args).toEqual(["vitest", "run", "--coverage"]);
          expect(opts.cwd).toBe("/tmp/fake-ts-cwd");
          return cb(null, "All files | 120 | 85.71 |\n", "");
        }
        throw new Error(`unexpected execFile: ${file} ${args.join(" ")}`);
      },
    );

    const outcome = await runGates("/tmp/fake-ts-cwd", 0, "typescript", "maven", "B");
    expect(outcome.kind).toBe("result");
    expect(outcome.result?.tests).toBe(true);
    expect(outcome.result?.allPassed).toBe(true);
    expect(outcome.result?.coverage).toBe(85.71);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("non-zero exit surfaces as error.code → red gate (the signal)", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (file: string, args: string[], _opts: unknown, cb: Function) => {
        if (file === "npx" && args[0] === "tsc") return cb(null, "", "");
        const err = new Error("Command failed") as NodeJS.ErrnoException;
        // Node sets error.code to the numeric exit code for non-zero exits;
        // the cast widens the string-typed property for the mock.
        (err as { code: number | string }).code = 1;
        cb(err, "", "Test Files  1 failed\n");
      },
    );

    const outcome = await runGates("/tmp/fake-ts-cwd", 0, "typescript", "maven", "B");
    expect(outcome.kind).toBe("result");
    expect(outcome.result?.tests).toBe(false);
    expect(outcome.result?.allPassed).toBe(false);
  });
});
