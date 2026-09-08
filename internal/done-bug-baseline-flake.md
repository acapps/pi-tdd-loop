# bug-baseline-flake

## Problem

`/loop` refused to start with:

```
Baseline check failed: the existing test suite is not green, so the loop cannot continue.
- FAIL test/extension.test.ts
```

but the suite is actually green — reproduced 3× in isolation (69/69) and 2× full
run (1117 passed). The failure is **transient**, not a real red test.

## Root cause (suspected)

1. **Real process spawn hidden in the unit suite.** `test/extension.test.ts` →
   `/loop` handler → `runBaseline()` (`src/baseline.ts:53`) runs a real
   `execSync("go test -json ./...")` in the mock cwd `/tmp/test-project`.
   First run compiles + builds the `testproject` binary; if the Go toolchain is
   busy (concurrent vitest runs, cold build cache), `execSync` can time out or
   error → `evaluateBaseline` classifies a red baseline → `test/extension.test.ts`
   "fails" → `/loop` refuses to start. Violates the TEST SPEED RULE (unit tests
   must mock the process boundary).
2. **Shared `/tmp/test-project` fixture.** `test/extension.test.ts` and
   `test/git-workflow.test.ts` both hardcode the same path → cross-file races.
3. **Precedent.** `bug-slow-gate-signal-tests.md` documents vitest 4.1.10 +
   node 26 hangs on process-boundary tests on this machine — same flake class.

## Fix (when picked up)

- `vi.mock("node:child_process")` in `test/extension.test.ts` for the
  `runBaseline` path (CLAUDE.md: `vi.spyOn` on ESM node builtins does not
  work). Pure `evaluateBaseline` is already covered in `test/baseline.test.ts`,
  so nothing is lost.
- Move the shared `/tmp/test-project` fixture to `mkdtemp` per test file in
  both `test/extension.test.ts` and `test/git-workflow.test.ts`.
- Delete stray untracked `diag.mjs` (debug file, CLAUDE.md rule).
- No SPEC.md/README.md change needed — behavior and API unchanged.

## Status

2026-09-03: diagnosed; not yet fixed. Workaround: re-run `/loop` (suite is
green; the baseline flake is transient).

## Resolution (2026-09-06)

**Fix applied:**
1. `test/extension.test.ts`: Added file-level `vi.mock("node:child_process")` — `execSync` returns `""` (green baseline), `execFile` fails with ENOENT (gates red). No real `go test`, no real `go version`, no real `mvn`/`npx` in the unit suite.
2. `test/extension.test.ts`: Replaced shared `/tmp/test-project` fixture with `mkdtemp` per test (per-test temp dir, cleaned up in `afterEach`).
3. `test/git-workflow.test.ts`: Changed default `makeMockCtx` cwd from `/tmp/test-project` to `os.tmpdir()` (no real file I/O in this file — `execFile` is already mocked; the shared path was a latent cross-file race).

**Why no red-test regression:** The flake is environmental (toolchain contention, cold build cache), not a deterministic failure. The pre-fix tests pass in a clean run but violate the TEST SPEED RULE (real `execSync` in unit tests). The fix is a rule-compliance change, not a bug fix with a red/green cycle.

**Verification:**
- `npx tsc --noEmit`: clean
- `npx vitest run`: 1197 passed / 0 failed (16s)
- Mock verified: `execSync` is intercepted (no real process spawn)
- No cross-file `/tmp/test-project` references remain in `test/extension.test.ts` or `test/git-workflow.test.ts`
