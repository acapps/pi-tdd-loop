# bug-gate-signal-integrity

## Problem

Verified current state as of writing (every claim re-checked against the repo before drafting; baseline: `npx tsc --noEmit` clean, `npm test` → 32 files, 1017 tests, 0 failures):

**The gate's pass/fail signal is parsed output, not the exit code.** `src/gates.ts:81-94` (`runTests`) runs the test command and derives `passed`/`allPassed` exclusively from `parseTestOutput` (line 128-129: `const allPassed = failures.length === 0`). The exit code is discarded. `src/baseline.ts:34-37` states the opposite principle for the baseline gate: "The exit code is the gate signal (raw signals, no summarization); parsed failures are for display only." The loop's own gate does not follow it.

**Concrete spurious-green paths (all verified against the code):**

1. **Java/TypeScript: `|| true` swallows the exit code** — `src/gates.ts:98-100`:
   ```ts
   case "java": return "mvn test -q 2>&1 || gradle test 2>&1 || true";
   case "typescript": return "npx vitest run --reporter=verbose 2>&1 || true";
   ```
   `|| true` forces exit 0 for *any* outcome. The only remaining signal is the `^\s*FAIL\s+([\w/.+-]+)` regex in `parseTestOutput` (`src/gates.ts:122-126`). A maven/gradle run that fails to *execute* (missing dependency, OOM, wrong daemon, corrupt lock) emits no `FAIL <id>` line → `failures: []` → `allPassed: true` → **Phase B advances with a red project**.

2. **Go: parse-only pass criteria.** `parseTestOutput` (Go branch, `src/gates.ts:105-118`) records a failure only on JSON lines with `Action === "fail"`. A test binary that panics, a build error in a `_test.go` file, or a vet failure produces exit ≠ 0 with no parseable `fail` line → read as **pass**.

3. **Go attribution:** `currentTest` is set on any `Action === "run"` (line 111) and a package-level `fail` line (`Test: null`) is attributed to the *last* test that ran; a `fail` with no preceding `run` (cached failure) is attributed to the previous test. Display-only today, but the parser is the *only* signal — misattribution corrupts the failure list the Writer is shown.

**Coverage is a dead signal.** `runGates` (`src/gates.ts:43-46`) computes `result.coverage` for phases B/C, but **no transition reads it**: `handlePhaseBTransition` (`src/transitions.ts:192-203`) advances on `gate.compile && gate.allPassed`; `handlePhaseCTransition` (`src/transitions.ts:207-218`) on `gate.tests` only. `state.coverageThreshold` is consumed by exactly one call site (`src/events/agent-settled/gate-transition.ts:70`, passed into `runGates`) and one display site (`src/selectors.ts:26`). The `--coverage N` flag in `/loop` (`src/commands.ts:136`) changes a number that gates nothing.

**The suite runs twice in Phase B/C.** `runGates` calls `runTests` (60s timeout) and, for B/C, `checkCoverage` (`src/gates.ts:134-144`), which re-runs the entire suite (`go test -cover ./...`, `mvn test …`, `npx vitest run --coverage`). The java/ts coverage commands end in `|| echo 'coverage: 0%'` / `|| echo 'coverage: 0%'` (`src/gates.ts:147-151`), so a crashed run reports 0% — which the `if (coverage > 0)` guard (line 44) silently drops.

**The gate is synchronous and blocking inside the settle event.** `runGates` uses `execSync` (`src/gates.ts:55,85,137`) from `handleGateTransition` (`src/events/agent-settled/gate-transition.ts:68`), which is called synchronously from the `agent_settled` dispatcher. Up to ~3 minutes of event-loop block per settle in B/C (30s compile + 60s tests + 60s coverage), longer in practice for cold Java builds. No transitional lock exists: nothing marks the machine as "gate in flight," so a second settle or a concurrent `/loop-continue` (also `async`, reads `state.current` unsynchronized) operates on the pre-gate state.

## Target

After this fix: (1) **exit code is the gate signal** for tests and coverage; parsed failures are display-only — matching the principle `baseline.ts` already states; (2) no `|| true` / `|| echo` fallbacks — a tool that cannot run is a gate *error*, surfaced to the Writer, never a pass; (3) `runGates` is `async` and the machine is in an explicit transitional state while it runs, so a duplicate settle or concurrent command cannot double-advance; (4) the test suite runs **once** per settle in B/C (one command yielding both signal and coverage); (5) `coverageThreshold` either gates or is removed (decision in Interface; default: gates — a below-threshold run is a retry, not a pass).

## Interface

```ts
// src/gates.ts
export interface GateOutcome {
  kind: "result" | "error";
  result?: GateResult;   // present when kind === "result"
  error?: string;        // present when kind === "error" — tool could not run
}

export async function runGates(
  cwd: string,
  coverageThreshold: number,
  language: LanguageKey,
  buildTool: BuildTool,
  phase: Phase,
): Promise<GateOutcome>;
```

- `GateResult` (`src/types.ts:60-68`) gains no fields; `allPassed` is **redefined** to mean "test process exited 0" (was: "parser found no failure lines"). `failures` remains display-only.
- Test command (single invocation, B/C):
  - go: `go test -json -cover ./...` — exit code is the signal; coverage parsed per the pattern below.
  - java: `mvn test -Djacoco.skip=false` (or `gradle test`) — no `|| true`; exit code is the signal; coverage parsed per the pattern below.
  - typescript: `npx vitest run --coverage` — no `|| true`; exit code is the signal; coverage parsed per the pattern below.

**Coverage parse patterns (clarification 2, 2025-08-18 review — pinned, deterministic, per language):**

Since the `|| echo 'coverage: 0%'` fallbacks are removed, each pattern must find a number in *real* tool output or the sub-check is skipped (row 6). One attempt per language, last match wins, all matches are `Number(...)`-coerced and must be finite and in `[0, 100]` to count:

| Language | Command | Parse pattern (applied to combined stdout+stderr) | Real-output example it must match |
|---|---|---|---|
| go | `go test -json -cover ./...` | `cover:\s+(\d+(?:\.\d+)?)%\s+of\s+statements` (JSON lines are `Action:"output"` lines of the test binary; the cover summary is plain text on stderr) | `ok  \texample.com/foo\t0.012s\tcoverage: 82.5% of statements` |
| java (maven) | `mvn test` | `Total,\s+(\d+(?:\.\d+)?)%` (JaCoCo summary line; requires the project to have the JaCoCo plugin — if the line is absent, row 6 applies: skip, debug note) | `Total, 1234, 56, 78, 9, 10, 11, 82.5% ...` |
| java (gradle) | `gradle test` | same as maven (JaCoCo test-report output) | same |
| typescript | `npx vitest run --coverage` | `All files\s+\|\s+\d+\s+\|\s+(\d+(?:\.\d+)?)` (vitest coverage table header row; the 3rd column is % Coverage) | `All files          |  85.71 | ...` |

**Unparseable = unavailable = skip (pinned):** a tool that ran but whose output matches no pattern (JaCoCo not configured, vitest coverage provider missing, go test caching a package with no cover line) takes row 6 — `result.coverage: 0`, debug note `coverage: no parseable total in <tool> output`, coverage sub-check skipped. This is an environment fact, not a code failure (pinned in Interface). **Never** a fabricated 0 that fails the threshold: the old `|| echo 'coverage: 0%'` turned "tool unavailable" into "0% coverage" — that conflation is the bug this row exists to prevent.

**Pinned for test determinism:** the parse functions are pure (`parseCoverage(output: string, language: LanguageKey): number | null`), exported from `src/gates.ts`, and the tests above assert against the *example strings* in this table verbatim — no live tool execution in unit tests.
- **Coverage decision:** `coverageThreshold` gates in B/C: `result.tests && coverage < threshold` → retry effect (new retry prompt key, see Behavior). If the coverage tool reports unavailable (no `coverage:` match), the coverage sub-check is *skipped with a debug note*, not failed — pinned, not a quirk, because a missing coverage tool is an environment fact, not a code failure.
- `handleGateTransition` (`src/events/agent-settled/gate-transition.ts`) becomes `async`, returns `Promise<GateHandlerOutput>`; `GateHandlerOutput` unchanged in shape.
- Transitional lock: `LoopState` gains **no** new field. The lock is a module-local `let gateInFlight = false` in `gate-transition.ts` (single-instance extension; see Scope). A settle arriving while `gateInFlight` is true is logged (`debug("gate already running — dropping duplicate settle")`) and returns `{ state, gateResult: state.lastGateResult ?? NO_GATE, applied: false }` without mutating state. `finally` clears the flag. (A state field would persist across reloads and deadlock a restored session; module-local is the minimal honest lock.)

## Behavior

Decision table for `runGates` (evaluation order, first match wins):

| # | Condition | Outcome |
|---|---|---|
| 1 | compile exit ≠ 0 | `result`: `compile: false`, `compileError` = stderr (pinned: current behavior, `src/gates.ts:55-61`) |
| 2 | test process exit ≠ 0 | `result`: `tests: false`, `allPassed: false`, `failures` = parsed (display-only) |
| 3 | test process exit 0 | `result`: `tests: true`, `allPassed: true`, `failures` = parsed (may be non-empty — parser noise; display-only) |
| 4 | test/compile *command cannot start* (spawn error) | `kind: "error"`, `error` = message — **never** a `GateResult` |
| 5 | B/C, **test process exited 0** (rows 2-3 outcome), coverage parse yields a number | `result.coverage` set; below-threshold handled by the transition (row T2) |
| 6 | B/C, **test process exited 0**, coverage parse yields no number | `result.coverage` stays 0; debug note; coverage sub-check skipped |

**Row ordering pin (clarification 1, 2025-08-18 review):** "first match wins" is evaluated **sequentially, not as independent predicates**: rows 5-6 are coverage *sub-checks* that execute only after row 3 has matched (test exit 0) in a B/C phase. If row 2 matches (test exit ≠ 0), the coverage sub-check **does not run at all** — `result.coverage` stays 0, no coverage debug note, and the transition sees `tests: false` and takes the existing retry/escalation rows (T3). In other words: a red run never reports a coverage number, and a coverage parse failure can never *cause* a red run — it can only skip the sub-check on an otherwise-green run. (Row 4, spawn error, short-circuits everything: no test run, no coverage run, `kind: "error"`.)

Transition rows added to `computeTransition` (in `src/transitions.ts`, evaluated inside the existing phase handlers):

| # | Phase | Condition | Effect |
|---|---|---|---|
| T1 | B | `gate.compile && gate.allPassed && (coverage unavailable \|\| coverage >= threshold)` | advance to C (existing) |
| T2 | B | `gate.compile && gate.allPassed && coverage < threshold` | retry, new prompt key `coverage_below_threshold` (see quirk Q3) |
| T3 | B | `!gate.compile \|\| !gate.allPassed` | existing escalation/retry rows (unchanged) |
| T4 | C | `!gate.tests` | existing retry/done rows (unchanged) — coverage is a B-only gate, pinned |
| T5 | any | `GateOutcome.kind === "error"` | **new**: retry effect with `prompt: "gate_error"`; notify `Gate could not run: <error>. Fix the environment and retry.`; round increments; escalation at phase max (same budget as the phase's existing retry) |

**Verbatim pins (new user-visible strings):**
- `gate_error` retry notify: `Gate could not run: ${error}. Fix the environment and retry.` (level `warning`)
- `coverage_below_threshold` retry notify: `Coverage ${coverage}% is below the ${threshold}% threshold.` (level `warning`)
- duplicate-settle debug: `gate already running — dropping duplicate settle`

**Side-effect contract:**
- `handleGateTransition` awaits `runGates`; on `kind: "error"` it does NOT call `T.computeTransition` with a fabricated `GateResult` — it builds the T5 effect directly (or via a `computeGateErrorTransition(state, error)` pure helper in `transitions.ts` — pinned: helper lives in `transitions.ts`, keeps the effect union closed).
- `state.current.lastGateResult` is written only for `kind: "result"` (current behavior preserved; an error must not poison the `/loop-status` display with a fake all-false result).
- `turnsThisPhase` reset behavior unchanged (effect-applicator owns it).

**Quirks list (odd-but-current, do not fix in this unit):**
- Q1: `formatFailures` prints `(unknown failures)` for an empty list (`src/gates.ts:158`) — display quirk, untouched.
- Q2: `gateStatus` (`src/events/agent-settled/gate-transition.ts:47-52`) labels a `tests: true, allPassed: false` state "pass" — unreachable after this fix (the two fields become equal), pinned for the transition period, removed in the same unit.
- Q3: Phase C ignores coverage entirely — pinned (row T4); the `--coverage` flag is documented as a Phase B gate in README/SPEC (doc update in Scope).

**Intended shifts (accepted, named):**
- S1: a Go run that previously parsed green but exited non-zero (panic/vet) is now **red**. Before: advance; after: retry. This is the fix, not a regression.
- S2: a Java/TS run that previously emitted no `FAIL` line now fails on exit code. Before: advance; after: retry.
- S3: a below-threshold coverage run in Phase B is now a retry. Before: silently advanced; after: Writer sees the coverage number in the retry prompt.

**Ownership:** `src/gates.ts` owns signal extraction; `src/transitions.ts` owns the T2/T5 rows; `src/events/agent-settled/gate-transition.ts` owns the async wrapper and the lock. Tests: `test/gates.test.ts` (signal extraction), `test/transitions.test.ts` (T2/T5 rows), `test/extension.test.ts` (duplicate-settle drop).

## Inventory

**Files touched (closed list — 6):**
1. `src/gates.ts` — `runGates` → async `GateOutcome`; `runTests`/`checkCoverage` → `execFile`-based async; commands rewritten (no `|| true`); `parseTestOutput` kept (display-only), Go attribution unchanged.
2. `src/transitions.ts` — T2/T5 rows; `computeGateErrorTransition` helper; new `RETRY_PROMPTS` keys.
3. `src/constants.ts` — `RETRY_PROMPTS` gains `COVERAGE_BELOW_THRESHOLD: "coverage_below_threshold"`, `GATE_ERROR: "gate_error"`.
4. `src/events/agent-settled/gate-transition.ts` — async wrapper, lock, error branch.
5. `src/events/agent-settled/index.ts` — `handlePhaseSettled` awaits the gate handler (dispatcher already async).
6. `src/generic-prompts.ts` — `promptGateError(error: string)` and `promptCoverageBelowThreshold(coverage: number, threshold: number)` builders.

**Call sites of `runGates` (closed, grep-proven):** one — `src/events/agent-settled/gate-transition.ts:68`. `baseline.ts` has its own `runBaselineTests` and is untouched.

**`appendEntry`/`sendUserMessage` sites touched:** none added or removed by this unit (persistence is refactor-1's scope).

## Test Strategy

- **Baseline:** 32 files / 1017 tests green (verified 2025-08-18).
- **Flips (counted):** `test/gates.test.ts` — 0 flips; it imports only `parseTestOutput`/`formatFailures` (line 4), both of whose signatures are unchanged. `test/transitions.test.ts` — 0 flips: T2/T5 are new rows; existing rows' conditions are unchanged for `kind: "result"` inputs. `test/extension.test.ts` — the settle-path tests mock `runGates`; the mock must change from sync to `Promise.resolve(...)` — this is a test-harness flip, counted: every `vi.mock("../../src/gates")` in `test/extension.test.ts` (grep: 1 mock block) is updated; assertions unchanged.
- **New tests:**
  - `test/gates.test.ts`: exit-0 + no-FAIL-lines → `allPassed: true`; exit-1 + no-FAIL-lines → `allPassed: false` (the spurious-green regression, named); spawn-error → `kind: "error"`; `go test -json -cover` single-invocation command shape (assert the command string, pinned); `parseCoverage` — one test per language against the verbatim example strings in the Coverage parse patterns table (4 tests: go 82.5, maven 82.5, gradle 82.5, vitest 85.71) + one test per language for the no-match → `null` case (4 tests) + one test that a red test run (exit ≠ 0) leaves `result.coverage === 0` with no coverage debug note (row-ordering pin, 1 test).
  - `test/transitions.test.ts`: T2 (coverage below → retry with the pinned notify); T5 (error → retry, escalation at maxB); T1 with coverage unavailable → advance (skip, not fail).
  - `test/extension.test.ts`: second settle while gate in flight → no state mutation, `applied: false`, debug line emitted.
- **Untouched:** `src/baseline.ts`, `src/selectors.ts`, all prompt files except `generic-prompts.ts` additions. Mechanism: `GateResult` shape unchanged, so every existing fixture stays valid.

## Scope lines

- `src/gates.ts`: `getTestCommand`/`getCoverageCommand` **merged** into one `getTestCommand` (B/C) + `getTestCommandPhaseA` (A: no coverage); `COVERAGE_UNAVAILABLE` constant deleted (caller-count evidence: 2 sites, both in this file); `checkCoverage` removed, coverage folded into the single test run.
- `src/transitions.ts`: kept + T2/T5/helper.
- `src/events/agent-settled/gate-transition.ts`: kept + async + lock.
- `src/events/agent-settled/index.ts`: one-line await change.
- `README.md` / `SPEC.md`: `--coverage` documented as a Phase B gate (doc update required by the intended shift S3).

## Acceptance Criteria

1. `npm test` green, 32 files; the two named spurious-green regression tests (S1, S2) fail on the pre-fix code and pass after.
2. `npx tsc --noEmit` clean.
3. Grep sweep: needle `|| true` — 0 hits in `src/gates.ts` (was 2). Needle `execSync` — 0 hits in `src/gates.ts` (was 3).
4. Grep sweep: `runGates(` — exactly 1 production call site (`gate-transition.ts`), confirmed async (needle: `await runGates`).
5. `coverageThreshold` has a transition consumer: grep `coverageThreshold` in `src/transitions.ts` ≥ 1 hit (was 0).
6. One test invocation per settle in B/C: grep `go test` in `src/gates.ts` — exactly 1 command string (was 2: `go test -json ./...` + `go test -cover ./...`).

## Dependencies

None upstream. **Must land before** `refactor-single-commit-point` (the commit point persists whatever the gate produced; a spurious-green commit is worse than no commit) and before `bug-negotiate-settle-not-persisted` (the negotiate path shares the dispatcher; the async gate changes the dispatcher's await structure).

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | `src/state-validation.ts` rule 1 (`done ⇒ round 0`) and rule 3 (`escalated ⇒ lastPhase ∈ {B,C}`) contradict the live machine (`markDone` keeps round; `escalateTo` is reachable from A and negotiate) — the dead validator would reject valid live states if ever wired in | Rejected as in-scope here; tracked in `refactor-state-model-divergence.md` |
| 2 | needs-doc | `bug-phase-0-approval-dead-end.md` and this spec both touch `src/gates.ts`-adjacent signal semantics but different files; no shared code | Accepted — independent units, no coordination needed |
| 3 | needs-doc | 2025-08-18 Phase 0 review: findings 1-4 rejected as false positives (auto-scan artifacts); two clarifications accepted — (1) rows 5-6 evaluate only after test exit 0, (2) per-language coverage parse patterns pinned with verbatim example strings | Accepted — both clarifications folded into the decision table and Interface; `parseCoverage` is now a named pure export with deterministic test fixtures |
