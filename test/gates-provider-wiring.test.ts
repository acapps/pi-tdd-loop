// Contract tests — ts-gate-coverage-provider (runGates wiring)
// Spec: internal/ts-gate-coverage-provider.md
//
// This file is the mocked `runGates` wiring home (Phase 0 finding 1): the
// sibling file test/gate-signal-integrity.test.ts runs the REAL toolchain in
// temp cwds (S1/S2 regression tests), so it must NOT receive a file-level
// vi.mock("node:child_process"). One vi.mock per file applies to the whole
// file — hence these cases live here, with file-level mocks of both the
// process boundary (node:child_process) and the module-resolution boundary
// (node:module). No real vitest, no real go, no real npx — per CLAUDE.md
// TEST SPEED RULE.
//
// What this file pins:
//  - runGates passes { cwd } into getTestCommand (the single call site),
//    so the provider probe runs against the GATED project, not the unit's
//    own module scope.
//  - Provider present  → test step invoked as `vitest run --coverage`.
//  - Provider absent   → test step invoked as `vitest run` (no --coverage),
//    and a green plain run yields tests=true, allPassed=true, coverage 0
//    (the coverage sub-check is skipped — unavailable = environment fact,
//    never a failure; internal/bug-gate-signal-integrity.md row 6).
//  - The probe runs exactly once per gate, before the test step.
//  - The probe never throws out of runGates: even a probe that throws a
//    non-Error, runGates completes and degrades to the plain run.

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the module-resolution boundary (the probe) ---------------------
// The spec pins: `import { createRequire } from "node:module"` at the top of
// src/gates.ts, probe body `createRequire(join(cwd, "package.json")).resolve(
// "@vitest/coverage-v8")` in try/catch. Only the surface gates.ts uses.
vi.mock("node:module", () => ({
  createRequire: vi.fn(),
}));

// --- Mock the process boundary (no real toolchain) ------------------------
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { runGates } from "../src/gates";
import type { GateOutcome } from "../src/gates";

const mockCreateRequire = vi.mocked(createRequire);
const mockExecFile = vi.mocked(execFile);

// --- execFile harness ------------------------------------------------------
// Mirrors node's execFile callback contract: (error, stdout, stderr) where
// error.code is the numeric exit code for non-zero exits, and a string code
// ('ENOENT') for spawn failures.

interface ExecCall {
  file: string;
  args: string[];
  opts: { cwd: string; timeout: number; maxBuffer: number };
}

interface ExecStep {
  file: string;
  exitCode?: number; // default 0
  stdout?: string;
  stderr?: string;
  spawnError?: string; // string error.code → gate kind "error"
  // Last step of the plan: consumed on every call for this file (handles
  // retry loops / repeated invocations of the same binary).
  sticky?: boolean;
  consumed?: boolean;
}

let steps: ExecStep[] = [];
const calls: ExecCall[] = [];

function planExecFile(steps_: ExecStep[]): void {
  steps = [...steps_];
  calls.length = 0;
  (mockExecFile as unknown as { mockImplementation(fn: unknown): void }).mockImplementation(
    (file: string, args: readonly string[] | null | undefined, opts: unknown, cb?: ((error: Error | null, stdout: string, stderr: string) => void) | null): void => {
      const argList = Array.isArray(args) ? [...args] : [];
      calls.push({ file, args: argList, opts: opts as ExecCall["opts"] });
      if (!cb) return;
      const callback = cb;
      // First unconsumed step for this file wins; a sticky step is reused.
      const idx = steps.findIndex((s) => s.file === file && !s.consumed);
      if (idx === -1) {
        callback(new Error(`unexpected execFile: ${file} ${argList.join(" ")}`), "", "");
        return;
      }
      const step = steps[idx];
      if (!step.sticky) step.consumed = true;
      if (step.spawnError) {
        const e = new Error(`spawn ${file} failed`) as NodeJS.ErrnoException;
        e.code = step.spawnError;
        callback(e, "", "");
        return;
      }
      const code = step.exitCode ?? 0;
      if (code === 0) {
        callback(null, step.stdout ?? "", step.stderr ?? "");
      } else {
        const e = new Error(`Command failed: ${file}`) as NodeJS.ErrnoException;
        (e as { code: number | string }).code = code;
        callback(e, step.stdout ?? "", step.stderr ?? "");
      }
    },
  );
}

// --- probe harness ----------------------------------------------------------

function mockProviderPresent(): void {
  const fakeResolve = { resolve: vi.fn(() => "/fake/node_modules/@vitest/coverage-v8/index.js") };
  mockCreateRequire.mockReturnValue(fakeResolve as never);
}

function mockProviderAbsent(): void {
  const err = new Error("Cannot find module '@vitest/coverage-v8'") as NodeJS.ErrnoException;
  err.code = "MODULE_NOT_FOUND";
  const fakeResolve = { resolve: vi.fn(() => { throw err; }) };
  mockCreateRequire.mockReturnValue(fakeResolve as never);
}

function mockProbeThrowingNonError(value: unknown): void {
  const fakeResolve = { resolve: vi.fn(() => { throw value; }) };
  mockCreateRequire.mockReturnValue(fakeResolve as never);
}

function resolveCalls(): Array<{ anchor: string; spec: string }> {
  const req = mockCreateRequire.mock.results[0]?.value as { resolve: (s: string) => unknown } | undefined;
  if (!req || !req.resolve) return [];
  return (req.resolve as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (c) => ({ anchor: mockCreateRequire.mock.calls[0]?.[0] as string, spec: c[0] as string }),
  );
}

// TS compile step (`npx tsc --noEmit`) exits 0 in every wiring case.
function tsCompileStep(): ExecStep {
  return { file: "npx", stdout: "" };
}

beforeEach(() => {
  mockExecFile.mockReset();
  mockCreateRequire.mockReset();
  steps = [];
  calls.length = 0;
});

// ================================================================
// runGates wiring — provider present (decision-table row 1)
// ================================================================

describe("runGates wiring — provider present (row 1)", () => {
  it("invokes vitest with args ['run', '--coverage'] and reports the parsed coverage", async () => {
    mockProviderPresent();
    planExecFile([
      tsCompileStep(),
      { file: "npx", exitCode: 0, stdout: "All files   |  92 |  85.71 |\n", sticky: true },
    ]);

    const outcome: GateOutcome = await runGates("/fake/ts-project", 80, "typescript", "maven", "B");

    expect(outcome.kind).toBe("result");
    expect(outcome.result?.tests).toBe(true);
    expect(outcome.result?.allPassed).toBe(true);
    expect(outcome.result?.coverage).toBe(85.71);

    // Two steps: compile, then the single merged test run.
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const testCall = calls.find((c) => c.args[0] === "vitest");
    expect(testCall).toBeDefined();
    expect(testCall?.args).toEqual(["vitest", "run", "--coverage"]);
    // The probe ran against the gated project, not the unit's own scope.
    expect(testCall?.opts.cwd).toBe("/fake/ts-project");
  });
});

// ================================================================
// runGates wiring — provider absent (decision-table row 2)
// ================================================================

describe("runGates wiring — provider absent (row 2)", () => {
  it("invokes vitest with args ['run'] only (no --coverage)", async () => {
    mockProviderAbsent();
    planExecFile([
      tsCompileStep(),
      { file: "npx", exitCode: 0, stdout: "Test Files  3 passed (3)\n", sticky: true },
    ]);

    const outcome = await runGates("/fake/ts-project", 80, "typescript", "maven", "B");

    expect(outcome.kind).toBe("result");
    const testCall = calls.find((c) => c.args[0] === "vitest");
    expect(testCall).toBeDefined();
    expect(testCall?.args).toEqual(["vitest", "run"]);
    expect(testCall?.args).not.toContain("--coverage");
    expect(outcome).toBeDefined(); // runGates completed; no probe leak
  });

  it("green plain run → tests=true, allPassed=true, coverage stays 0 (sub-check skipped, never a failure)", async () => {
    mockProviderAbsent();
    planExecFile([
      tsCompileStep(),
      { file: "npx", exitCode: 0, stdout: "Test Files  3 passed (3)\n", sticky: true },
    ]);

    const outcome = await runGates("/fake/ts-project", 80, "typescript", "maven", "B");

    expect(outcome.kind).toBe("result");
    expect(outcome.result?.compile).toBe(true);
    expect(outcome.result?.tests).toBe(true);
    expect(outcome.result?.allPassed).toBe(true);
    expect(outcome.result?.coverage).toBe(0);
    expect(outcome.result?.failures).toEqual([]);
  });

  it("red plain run (exit ≠ 0) → tests=false, allPassed=false, coverage stays 0 (exit code is the signal)", async () => {
    mockProviderAbsent();
    planExecFile([
      tsCompileStep(),
      { file: "npx", exitCode: 1, stdout: "Test Files  1 failed (1)\n", stderr: "FAIL  src/fail.test.ts\n", sticky: true },
    ]);

    const outcome = await runGates("/fake/ts-project", 80, "typescript", "maven", "B");

    expect(outcome.kind).toBe("result");
    expect(outcome.result?.tests).toBe(false);
    expect(outcome.result?.allPassed).toBe(false);
    expect(outcome.result?.coverage).toBe(0);
    // The FAIL line is parsed for display — but the verdict came from the exit code.
    expect(outcome.result?.failures).toHaveLength(1);
  });

  it("probe runs exactly once per gate, before the test step", async () => {
    mockProviderAbsent();
    planExecFile([
      tsCompileStep(),
      { file: "npx", exitCode: 0, stdout: "Test Files  1 passed (1)\n", sticky: true },
    ]);

    await runGates("/fake/ts-project", 80, "typescript", "maven", "B");

    expect(mockCreateRequire).toHaveBeenCalledTimes(1);
    // Anchor file lives inside the gated cwd (spec-pinned probe form).
    const anchor = mockCreateRequire.mock.calls[0]?.[0];
    expect(typeof anchor).toBe("string");
    expect(anchor).toContain("/fake/ts-project");
    // The probe resolves the v8 provider specifically.
    const specs = resolveCalls().map((c) => c.spec);
    expect(specs).toEqual(["@vitest/coverage-v8"]);
    // execFile was never called before the probe resolved: the probe is a
    // pure module-resolution read (no spawn, no shell) — assert the first
    // execFile call is the compile step, i.e. the probe itself spawned nothing.
    expect(calls[0]?.args).toEqual(["tsc", "--noEmit"]);
  });

  it("probe throwing a non-Error never escapes runGates — degrades to the plain run", async () => {
    mockProbeThrowingNonError("a string, not an Error");
    planExecFile([
      tsCompileStep(),
      { file: "npx", exitCode: 0, stdout: "Test Files  1 passed (1)\n", sticky: true },
    ]);

    let outcome: GateOutcome | undefined;
    await expect(runGates("/fake/ts-project", 80, "typescript", "maven", "B")).resolves.toSatisfy(
      (o) => {
        outcome = o;
        return true;
      },
    );

    expect(outcome?.kind).toBe("result");
    const testCall = calls.find((c) => c.args[0] === "vitest");
    expect(testCall?.args).toEqual(["vitest", "run"]); // degraded: no --coverage
    expect(outcome?.result?.tests).toBe(true);
  });
});

// ================================================================
// runGates wiring — other languages do not consult the probe
// ================================================================

describe("runGates wiring — go/java never probe", () => {
  it("go: invokes `go test -json -cover ./...` and createRequire is never called", async () => {
    planExecFile([
      { file: "go", stdout: "" }, // go build ./... exits 0
      { file: "go", exitCode: 0, stdout: "", sticky: true }, // go test -json -cover ./...
    ]);

    const outcome = await runGates("/fake/go-project", 80, "go", "go", "B");

    expect(outcome.kind).toBe("result");
    const testCall = calls.find((c) => c.args[0] === "test");
    expect(testCall?.args).toEqual(["test", "-json", "-cover", "./..."]);
    expect(mockCreateRequire).not.toHaveBeenCalled();
  });

  it("java/maven: invokes `mvn test -Djacoco.skip=false` and createRequire is never called", async () => {
    planExecFile([
      { file: "mvn", stdout: "" }, // mvn compile -q exits 0
      { file: "mvn", exitCode: 0, stdout: "BUILD SUCCESS\n", sticky: true },
    ]);

    const outcome = await runGates("/fake/java-project", 80, "java", "maven", "B");

    expect(outcome.kind).toBe("result");
    const testCall = calls.find((c) => c.args[0] === "test");
    expect(testCall?.args).toEqual(["test", "-Djacoco.skip=false"]);
    expect(mockCreateRequire).not.toHaveBeenCalled();
  });

  it("java/gradle: invokes `gradle test` and createRequire is never called", async () => {
    planExecFile([
      { file: "gradle", stdout: "" }, // gradle compileJava exits 0
      { file: "gradle", exitCode: 0, stdout: "BUILD SUCCESSFUL\n", sticky: true },
    ]);

    const outcome = await runGates("/fake/java-project", 80, "java", "gradle", "B");

    expect(outcome.kind).toBe("result");
    const testCall = calls.find((c) => c.args[0] === "test");
    expect(testCall?.args).toEqual(["test"]);
    expect(mockCreateRequire).not.toHaveBeenCalled();
  });
});

// ================================================================
// runGates wiring — gate-error paths are untouched by the probe
// ================================================================

describe("runGates wiring — error paths", () => {
  it("compile spawn failure → kind 'error', test step never runs, probe never runs", async () => {
    mockProviderAbsent();
    planExecFile([
      { file: "npx", spawnError: "ENOENT" },
    ]);

    const outcome = await runGates("/fake/ts-project", 80, "typescript", "maven", "B");

    expect(outcome.kind).toBe("error");
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toBeTruthy();
    expect(mockExecFile).toHaveBeenCalledTimes(1); // no test step
    expect(mockCreateRequire).not.toHaveBeenCalled();
  });

  it("test spawn failure → kind 'error', never a fabricated GateResult", async () => {
    mockProviderAbsent();
    planExecFile([
      tsCompileStep(),
      { file: "npx", spawnError: "ENOENT" },
    ]);

    const outcome = await runGates("/fake/ts-project", 80, "typescript", "maven", "B");

    expect(outcome.kind).toBe("error");
    expect(outcome.result).toBeUndefined();
  });
});
