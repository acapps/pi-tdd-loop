# bug-gate-verdict-field

## Problem

Verified current state as of writing (re-checked against the repo; runtime evidence: session `01a0167f-f4b0-719a-ab7e-ed9e975d65b7`, 2026-08-18):

**The gate's pass/fail verdict is stored in a field (`tests`) whose name means something else, and three different consumers read three different fields — so the log, the transition, and the debug trail can disagree about the same gate run.**

1. `runGates` (`src/gates.ts:44-50`) sets `result.tests = test.exitCode === 0` (the exit-code signal) and `result.allPassed = test.exitCode === 0` — **two fields, same value, different names**. `GateResult` (`src/types.ts:60-68`) carries both. The spec (`internal/bug-gate-signal-integrity.md`, Interface) redefined `allPassed` to mean "test process exited 0" and left `tests` untouched — a two-field verdict for one fact.
2. The consumers disagree on which field is the verdict:
   - **Phase B transition** (`src/transitions.ts:226`): advances on `gate.compile && gate.allPassed`.
   - **Phase C transition** (`src/transitions.ts:257`): retries/dones on `!gate.tests` — never reads `allPassed`.
   - **Dispute-fix transition** (`src/transitions.ts:210`): retries on `!gate.tests`.
   - **The debug log** (`src/events/agent-settled/gate-transition.ts:67`): `Gate ${gate.tests ? "pass" : "fail"}...` — the Writer's in-session edit changed this line *from* `gate.allPassed` *to* `gate.tests` to satisfy a test that pins the log string (`test/events/agent-settled/gate-transition.test.ts:202`, `retry debug trace — verbatim sequence`). The log now asserts `tests` is the verdict while Phase B's advance decision asserts `allPassed` is the verdict.
3. **Observed consequence (session evidence):** at 22:17 the gate logged `Gate pass [compile=true tests=true cov=0%]` and the loop advanced to Done. At 22:32 (session restart, state restored to Phase B round 1) the same gate path reported **8 failing test files** in the Writer's restart prompt (`baseline`, `extension`, `gate-signal-integrity`, `gates`, `selectors`, `effect-applicator`, `gate-transition`, `index` — from the restart message at session line 646). A `tests: true` verdict and an 8-file-failing suite ~15 minutes apart means the verdict field and the suite state were not the same fact — exactly the spurious-green class `bug-gate-signal-integrity.md` was written to kill. (The exact mechanism of the 22:32 failure set is not fully pinned here — the session's Writer turn then edited 45 files — but the *contract* that allows a `tests=true` log line to coexist with a red suite is pinned: two fields, three readers, no single source of truth.)
4. The log string also embeds the verdict word before the evidence: `Gate pass ... [tests=true]` — a reader of the log (human or the Writer agent, which reads these lines when debugging) sees "pass" and the `tests=true` token, and there is no token for the field the *transition* actually used. When the two fields ever diverge (a parser bug, a future partial-pass mode), the log cannot show which one decided.

**Why this is a loop bug:** the gate is the loop's only objective signal. Its verdict must be *one* field, *one* name, read identically by the transition, the log, and any debug trail. Today it is a two-field struct with reader-dependent meaning — the same shape of bug (signal ≠ field) that the exit-code fix addressed for the *command*, one layer up.

## Target

After this fix: `GateResult` has exactly one verdict field, named `allPassed` (the spec's defined name: "test process exited 0"). `tests` is deleted. Every consumer — Phase B/C/dispute-fix transitions, the gate log, the effect-applicator's `gateResult` payload — reads `allPassed`. The log line prints the field it reports, so the trail and the decision are the same token.

## Interface

```ts
// src/types.ts — GateResult
export interface GateResult {
  compile: boolean;
  compileError: string;
  allPassed: boolean;   // THE verdict: test process exited 0 (spec: bug-gate-signal-integrity)
  coverage: number;
  failures: FailingTest[]; // display-only
}
// `tests` removed. No new fields.
```

- `runGates` (`src/gates.ts`): sets `result.allPassed = test.exitCode === 0` only; the `result.tests = ...` line is deleted. Initializer: `tests: false` deleted.
- `computeTransition` consumers (`src/transitions.ts`): `!gate.tests` → `!gate.allPassed` at the Phase C (`:257`) and dispute-fix (`:210`) sites. Phase B (`:226`) unchanged (already `allPassed`).
- Gate log (`src/events/agent-settled/gate-transition.ts:67`): verbatim pin (new, replaces the current line):
  `Gate ${gate.allPassed ? "pass" : "fail"}${gate.failures.length > 0 || !gate.allPassed ? ` (${gate.failures.length} failures)` : ""} [compile=${gate.compile} tests=${gate.allPassed} cov=${gate.coverage}%]`
  — the bracket token is renamed `tests=` → `allPassed=` so the log names the field:
  `Gate ${gate.allPassed ? "pass" : "fail"}${gate.failures.length > 0 || !gate.allPassed ? ` (${gate.failures.length} failures)` : ""} [compile=${gate.compile} allPassed=${gate.allPassed} cov=${gate.coverage}%]`
- `effect-applicator.ts`: the `gateResult` payload passes `GateResult` through — no field access, 0 changes (verified: it assigns the object, `src/events/agent-settled/effect-applicator.ts`).
- `src/baseline.ts`: `BaselineResult` is a separate shape (`ok`, not `tests`) — untouched.

## Behavior

Decision table: field reads after the change (closed list — grep `gate.tests` / `.tests` on `GateResult` must return 0):

| # | Site | Before | After |
|---|------|--------|-------|
| 1 | `src/transitions.ts:226` (Phase B advance) | `gate.compile && gate.allPassed` | unchanged |
| 2 | `src/transitions.ts:257` (Phase C) | `!gate.tests` | `!gate.allPassed` |
| 3 | `src/transitions.ts:210` (dispute-fix) | `!gate.tests` | `!gate.allPassed` |
| 4 | `src/events/agent-settled/gate-transition.ts:67` (log) | `gate.tests` ×3 | `gate.allPassed` ×3 + token rename |
| 5 | `src/gates.ts:49-50` (set) | `result.tests = ...; result.allPassed = ...` | `result.allPassed = test.exitCode === 0` |
| 6 | `src/types.ts:60-68` (shape) | both fields | `allPassed` only |

- Verbatim pins: the log string in row 4 (above); the test in `test/events/agent-settled/gate-transition.test.ts:202-206` that pins the log (`retry debug trace — verbatim sequence`) is rewritten to the new string — the *sequence* (gate log → arrow → retry) is the contract, the token is renamed with it.
- Side-effect contract: `state.current.lastGateResult` carries the slimmed shape; any persisted session state from before the change contains `tests` — the state reader must tolerate it (see Persisted state).
- Persisted state: `loop-state` entries on disk may carry `lastGateResult.tests` (pre-change sessions). Strategy: optional-tolerant read — `state-migration.ts` / the state validator must not reject an unknown/extra field (`tests`) on `lastGateResult`; the field is simply ignored. Precedent: `state-migration.ts` already extends older shapes with optional fields (grep `justTransitioned` for the pattern). Do NOT rewrite stored entries.
- Ownership: `src/gates.ts` owns the set; `src/transitions.ts` + `gate-transition.ts` own the reads; `test/gates.test.ts`, `test/transitions.test.ts`, `test/events/agent-settled/gate-transition.test.ts` assert.

Quirks list:
- `handlePhaseCTransition` (`src/transitions.ts:257-268`) does `markDone` with `"Phase C failed, keeping original code. Loop complete."` when `!gate.tests` at `maxC` — i.e. a *failed* cleaner can still end the loop "done". Current behavior, do not fix — but the field rename must preserve the branch exactly (row 2).
- The `failures.length > 0 || !gate.tests` log condition (`:67`) prints `(N failures)` even when N is 0 but tests failed (the `|| !gate.tests` makes `(0 failures)` appear — visible in the session log: `Gate fail (0 failures) [compile=false ...]`). Current behavior, do not fix; the rename keeps the condition, only the field.

Intended shifts:
- Any code (none, grep-proven) that read `gate.tests` expecting "did the test step run" rather than "did it pass" — `tests` was *always* the exit-code boolean since `bug-gate-signal-integrity.md` landed; no "did it run" consumer exists (a run that cannot start is `kind: "error"`, no `GateResult` at all). Before/after: identical behavior, one name.

## Inventory

- Files:
  - `src/types.ts`: `GateResult.tests` deleted (caller-count evidence: rows 1–6 above are the complete read list; `grep -n "\.tests\b" src/` → the 6 sites + initializers).
  - `src/gates.ts`: 2 lines (initializer + set).
  - `src/transitions.ts`: 2 sites.
  - `src/events/agent-settled/gate-transition.ts`: 1 line.
  - `test/gates.test.ts`: fixture objects drop `tests` (count: grep `tests:` in the file — each `GateResult` literal).
  - `test/transitions.test.ts`: same fixture treatment.
  - `test/events/agent-settled/gate-transition.test.ts`: log-string assertion rewritten (1 `it`).
  - `test/events/agent-settled/index.test.ts`: fixture treatment.
- Imports: none changed.
- Call sites: rows 1–6 are the closed list.
- Exports: none changed.

## Test Strategy

- **Baseline:** `npx vitest run` — count the `GateResult` fixtures at run time (grep `tests: ` across `test/`); all pass as of writing.
- **Flips (counted):** 1 assertion (the verbatim log string in `gate-transition.test.ts`); every fixture literal loses one key (mechanical, no assertion flip — the assertions read `allPassed`/`compile`/`coverage`, not `tests`; verify by grep: `expect(.*\.tests` → 0 hits outside the log-string test).
- **New tests:** 1 — "the log line and the Phase B decision read the same field": a gate with `compile: true, allPassed: false, failures: []` must log `Gate fail (0 failures) ... allPassed=false` AND take the retry transition (not advance) — pins row 4 and row 1 against divergence.
- **Untouched:** `src/baseline.ts`, `src/selectors.ts`, `src/events/agent-settled/effect-applicator.ts` (passes the object through — mechanism: no field access, grep `gateResult.tests` → 0 hits).

## Scope lines

- `src/types.ts`: 1 field removed.
- `src/gates.ts`: 2 lines.
- `src/transitions.ts`: 2 sites.
- `src/events/agent-settled/gate-transition.ts`: 1 line.
- 4 test files: fixture-key removal + 1 string + 1 new test.
- Everything else: untouched.

## Acceptance Criteria

1. `npm test` green, full `vitest run`.
2. `npx tsc --noEmit` clean (this is the checker that catches any remaining `.tests` read — the test run alone would not, since fixtures are the tests' own).
3. Grep sweeps (each names its needle):
   - `\.tests\b` in `src/` → 0 hits.
   - `tests: ` in `src/types.ts` → 0 hits; `allPassed:` → exactly 1.
   - `allPassed=` in `src/events/agent-settled/gate-transition.ts` → exactly 1 (the log token).
4. The new divergence test (Test Strategy) passes and fails on the pre-change code (run it against `git stash` state to verify — it reads `gate.tests` there).
5. Restored pre-change session state (a `loop-state` entry containing `lastGateResult.tests`) loads without validation error (manual: drop a saved entry from a pre-change session into the state dir, start pi, check the `session_start` debug line).

## Dependencies

- `bug-gate-signal-integrity.md`: implemented (uncommitted) — this spec assumes its `allPassed`-as-exit-code semantics are the current one. Must land in the same commit or immediately after; landing `bug-gate-signal-integrity.md` *without* this spec leaves the two-field struct in place.
- `bug-gate-green-stays-green.md`: independent, but both touch `test/gate-signal-integrity.test.ts` fixtures — sequence: green-stays-green first (it changes the fixture's *files*), this one after (it changes the fixture's *keys*), to avoid a double-edit of the same literals.

## Findings log

| # | Severity | Finding | Disposition |
|---|-----------|---------|-------------|
| 1 | blocker | The 22:17 `Gate pass [tests=true]` → 22:32 "8 failing files" gap is not fully mechanistically pinned (the session's Writer turn edited 45 files in between; the exact gate input at 22:32 is not in the log) | Accepted as partial: the *contract* defect (two fields, three readers) is pinned and is a necessary condition for the observed divergence; the full mechanism is tracked as a follow-up question in the spec's Problem, not asserted as proven |
| 2 | needs-doc | `handlePhaseCTransition` can end a red loop as "done" at maxC | Rejected as in-scope here (quirk, pinned); candidate for its own spec if the "done (cleaner failed)" outcome should ever be distinguishable in the completion report |
| 3 | needs-doc | The in-session Writer edit changed the log from `allPassed` to `tests` to satisfy a string-pinning test — the test pinned a *field choice*, not a string | Accepted — the log-string test is rewritten to the new string; the lesson (pin the decision, name the field) is folded into the new divergence test |
