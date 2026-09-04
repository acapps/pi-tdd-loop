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
