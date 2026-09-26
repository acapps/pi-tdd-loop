# Fix: Scope-check flags pre-existing untracked files as out-of-scope

## Bug

**Failure class:** B (silent no-op / false failure)

**Observed in:** Session `01a0d6aa-7bec-7142-b0a0-6cdc452da027` (spec: fix-negotiated-resolution-dropped, 2026-09-25)

**Symptom:** Phase B gate failed 5 consecutive rounds because `prompt-evolution/` and `prompt-forge/behavior-test.ts` (untracked files from earlier prompt-evolution work, Sep 23–24) were flagged as out-of-scope. The spec started Sep 25. The scope-check cannot distinguish pre-existing untracked files from files created by the Writer during the spec.

**Root cause:** `src/scope-check.ts:getGitDirtyFiles()` returns ALL dirty files from `git status --porcelain`, including untracked (`??`) files. `checkScope()` flags ANY file not in the spec's Inventory as out-of-scope. There is no baseline — the check doesn't know what the dirty set was when the spec started.

**Impact:** Any user with untracked files in their working tree (from other work, experiments, development artifacts) will have their gate blocked unless those files are in the current spec's Inventory. The loop is unusable in real-world repositories with multiple workstreams.

## Fix

Capture the git dirty set at spec start (in `cmdLoop`, before `createInitialState`) and store it in `LoopState` as `baselineDirtyFiles?: string[]`. At gate time, `checkScope()` receives the baseline and only flags files that are in the **current** dirty set but **not** in the **baseline** dirty set.

### Design decisions

1. **Baseline = untracked files only (`??`).** Captured in `cmdLoop` after `runPhase0Baseline` via `getGitUntrackedFiles` (not `getGitDirtyFiles`). Only untracked files go into the baseline — modified tracked files (`M`) are excluded because their dirty state is meaningful (content changed) and they must still be checked against the Inventory at gate time. This closes the gap where a Writer could modify a file that was dirty at spec start and outside the Inventory without being flagged.

2. **Baseline is optional.** If absent (e.g., session restored from an old state file), the scope-check behaves as before (flags all dirty files not in Inventory). This is backward-compatible.

3. **Baseline is cleared on Phase B reset.** `resetForPhaseB` clears `baselineDirtyFiles` — the baseline is only relevant for the first Phase B/C run. Subsequent runs (dispute → re-run Phase B) re-capture the baseline in the gate handler if it's missing.

4. **The gate handler re-captures the baseline if missing.** If `state.baselineDirtyFiles` is `undefined` at gate time (e.g., restored session), the gate handler captures it on the first Phase B/C gate and stores it. This ensures the fix works for restored sessions too.

## Inventory

- `src/types.ts` — add `baselineDirtyFiles?: string[]` field
- `src/state-validation.ts` — field spec (optional array of strings, absent → undefined on restore)
- `src/commands/loop.ts` — capture baseline in `cmdLoop` after `runPhase0Baseline`
- `src/scope-check.ts` — `checkScope` accepts optional `baseline` param; filter current dirty set against baseline
- `src/events/agent-settled/gate-transition.ts` — pass `state.baselineDirtyFiles` to `checkScope`; re-capture if missing
- `test/scope-check.test.ts` — extend: baseline filtering tests
- `test/commands/loop.test.ts` — extend: baseline capture test

## Interface

```typescript
// src/types.ts
interface LoopState {
  // ... existing fields ...
  /** Git dirty set at spec start — baseline for scope-check. */
  baselineDirtyFiles?: string[];
}

// src/scope-check.ts
function checkScope(
  cwd: string,
  specPath: string,
  specText: string | null,
  baseline?: string[],  // NEW: dirty set at spec start
): ScopeCheckResult;
```

## Program

The fix is a 3-part change:

1. **Capture:** In `cmdLoop`, after `runPhase0Baseline` succeeds, run `git status --porcelain` and store the result in `state.baselineDirtyFiles`.

2. **Filter:** In `checkScope`, after getting the current dirty set, filter out any files that are in the baseline. Only the remaining files (new since spec start) are checked against the Inventory.

3. **Re-capture:** In `handleGateTransition`, if `state.baselineDirtyFiles` is `undefined` and the phase is B or C, capture the current dirty set as the baseline (first-run behavior for restored sessions).

## Effect

- `state.baselineDirtyFiles` is set at spec start and cleared in `resetForPhaseB`
- `checkScope` returns only files that are dirty NOW but were not dirty at spec start
- Pre-existing untracked files no longer block the gate

## Test Strategy

- Unit: `checkScope` with baseline — pre-existing untracked files are filtered out, new untracked files are still flagged
- Unit: `checkScope` without baseline — backward-compatible behavior (all dirty files checked)
- Unit: `cmdLoop` captures baseline after `runPhase0Baseline`
- Unit: `resetForPhaseB` clears `baselineDirtyFiles`
- Regression: the exact session 01a0d6aa scenario — `prompt-evolution/` and `prompt-forge/behavior-test.ts` in baseline, 5 modified files in Inventory → scope check passes

## Acceptance Criteria

- [ ] `baselineDirtyFiles` field in `types.ts` (optional, `string[]`)
- [ ] `state-validation.ts` handles the field (absent → undefined)
- [ ] `cmdLoop` captures baseline after `runPhase0Baseline`
- [ ] `checkScope` accepts optional `baseline` and filters current dirty set against it
- [ ] `gate-transition.ts` passes `state.baselineDirtyFiles` to `checkScope`
- [ ] `gate-transition.ts` re-captures baseline if missing (restored session)
- [ ] `resetForPhaseB` clears `baselineDirtyFiles`
- [ ] Unit tests: baseline filtering, backward compatibility, capture, clear
- [ ] Regression test: session 01a0d6aa scenario passes scope check
- [ ] All existing tests pass
