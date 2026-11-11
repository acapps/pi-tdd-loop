# bug-phase-a-zero-test-gate

## Problem

The Phase A gate passes when `compile=true` and `allPassed=true`, even when the Tester wrote zero new test files. The gate cannot distinguish "all tests pass" from "no tests exist for this spec."

**Runtime evidence:** Session `01a0f4db` (2026-10-01):

Phase A gate: `Gate pass [compile=true allPassed=true cov=0%]`

The Tester was supposed to write `test/state/phase0-state-check.test.ts`. Instead it wrote `src/state/checkpoint.go` (a Go source file, bypassed via bash heredoc). No new test file was created. The gate ran the existing 1780 tests (all green), confirmed compilation, and advanced to negotiate.

**Consequence:** The entire TDD contract is empty. Phase B (Writer) has no tests to implement against. The Writer must write the tests itself, violating the role separation. The "adversarial" design (Tester writes contract, Writer implements) is silently skipped.

## Target

After this fix, the Phase A gate requires at least one new or modified test file in the spec's scope. If no new tests exist, the gate fails with a specific error: "Phase A produced no test files."

## Interface

In `src/gates.ts` (or the Phase A gate runner):

1. **Track the baseline test file set:** At Phase 0 entry, record `git ls-files '*.test.ts'` (or equivalent) as the pre-Phase-A test set.
2. **At Phase A gate:** Compare current test files to baseline. If the set is unchanged (no new files, no modified files), fail the gate.
3. **Error message:** `"Phase A gate: no new or modified test files detected. The Tester must write at least one test before advancing."`

**Alternative (simpler):** Check if any file matching `test/**/*.test.ts` has a modification time newer than the Phase A start timestamp. This is less robust (mtime is unreliable) but simpler.

**Recommended:** Git-based diff. `git diff --name-only HEAD -- '*.test.ts'` + `git ls-files --others --exclude-standard -- '*.test.ts'` (untracked new files). If the union is empty, fail.

## Tests

- `test/gates/phase-a-zero-test.test.ts`:
  - Phase A gate with 0 new test files → fails with "no new or modified test files"
  - Phase A gate with 1 new test file → passes
  - Phase A gate with 1 modified test file → passes
  - Phase A gate with new test file in wrong directory (not `test/`) → fails (or warns)

## Acceptance Criteria

1. A Phase A that produces no new/modified test files fails the gate.
2. The error message is specific and actionable.
3. The gate still passes when tests exist and are green.
4. No false failures when the spec is a refactor (no new tests, but existing tests modified).

## Notes

- This is a **signal integrity** issue (same family as `done-bug-gate-signal-integrity.md`). The gate says "pass" when the contract is empty.
- Related: the Writer in Phase B should also be gated — if the Tester's tests are the contract, the Writer should not be able to modify them (currently blocked by tool policy, but bypassable via bash — see `bug-bash-heredoc-gate-bypass.md`).
