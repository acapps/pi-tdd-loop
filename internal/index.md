# Spec Index

Conventions for specs in this directory: [docs/spec-authoring.md](../docs/spec-authoring.md).

**Status legend:** `open` = ready to implement; `blocked` = has a hard dependency; `done` = implemented and verified (rename file `done-`-prefix).

## Active specs

| Spec | Type | Status | Dependencies (hard → soft) |
|---|---|---|---|
| [bug-dispute-reload-evaporation.md](done-bug-dispute-reload-evaporation.md) | bug | **done** (merged 2026-09-06) — 6 dispute flags → 1 `DisputeState` status object; `migrateDispute` in session-start; `clearTransientFlags` no longer touches dispute; budget at resolution not filing; 4 handlers rewritten; 19+ test flips across 8 files; 1170 tests passing. |
| [bug-gate-green-stays-green.md](done-bug-gate-green-stays-green.md) | bug | **done** (merged 2026-09-06) — `makeGoCwd` fixture now writes `main.go` (buildable Go module); Writer prompt mandates `negotiate_propose` exit path for unpassable tests; "green stays green" live-toolchain regression added to `test/gate-signal-integrity.test.ts`. |
| [bug-gate-slow-settle-duplicate.md](done-bug-gate-slow-settle-duplicate.md) | bug | **done** (merged 2026-09-06) — module-local `gateInFlight` lock in `handleGateTransition` (check + `try/finally` clear); duplicate settle returns the now-live `NO_GATE` sentinel; 3 regression tests (concurrent drop / no-wedge / wedge-on-throw) in `test/events/agent-settled/gate-transition.test.ts`, red-verified. |
| [bug-gate-verdict-field.md](done-bug-gate-verdict-field.md) | bug | **done** (merged 2026-09-06) — `GateResult.tests` deleted; `allPassed` is the single verdict field; 11 src files + 28 test files updated; T4 regression red-verified. |
| [done-bug-baseline-flake.md](done-bug-baseline-flake.md) | bug | **done** (2026-09-06) | `vi.mock("node:child_process")` in `test/extension.test.ts` (no real `go test`/`go version`); shared `/tmp/test-project` → `mkdtemp` per test; `git-workflow.test.ts` default cwd → `os.tmpdir()`. TEST SPEED RULE compliance. |
| [loop-continue-runner.md](loop-continue-runner.md) | feature | **open** | External runner for non-interactive loop execution. Status file (`.pi/loop-status`) written in `commit()`; `bin/run-loop.sh` wraps `pi --continue --print` in a loop; uses existing `/loop-continue` command. No changes to `agent_settled` handlers. |
| [bug-golden-baseline-cwd.md](bug-golden-baseline-cwd.md) | bug | **open** | Golden project baseline runs in `ctx.cwd` instead of workspace root; `sendUserMessage` used deprecated `triggerTurn` instead of `deliverAs`; golden project missing `go.mod` seed. Found via RPC-mode golden loop test. |
| [done-bug-phase-0-approval-dead-end.md](done-bug-phase-0-approval-dead-end.md) | bug | **done** | Phase × Tool policy matrix; Phase 0 approve/feedback handlers; `/loop-restart` extended. |

## Feature specs (not bug-specs)

| Spec | Type | Status | Notes |
|---|---|---|---|
| [spec-command.md](spec-command.md) | feature | **done** (file not renamed) | `/spec` Author command — `src/spec-command.ts` (`cmdSpec`) registered at `index.ts:57`; `test/spec-command.test.ts` present. |
| [log-bug-spec.md](log-bug-spec.md) | feature | **done** (file not renamed) | `/loop-debug --log-bug <name>` — arg parsing + `writeBugSpec` in `src/commands.ts:354-420`; `test/bug-spec.test.ts` + `test/extension.test.ts`. |
| [ts-gate-coverage-provider.md](ts-gate-coverage-provider.md) | feature | **done** (file not renamed) | `hasVitestCoverageProvider` probe (`src/gates.ts:126`) + conditional `getTestCommand` (`:133`); `test/gates-provider-wiring.test.ts`. Java/jacoco named-reason row stays open (out of scope here). |
| [done-golden-workspace-fix.md](done-golden-workspace-fix.md) | feature | **done** | `isGoldenProject`/`getWorkspaceRoot`/`isWorkspacePath` in `src/types.ts`; `blockWorkspaceWrite` Rule 1 in `src/events/tool-call.ts`; gates run in workspace root in `gate-transition.ts`; all prompts accept `workspaceRoot` param. 14 regression tests. |
| [writer-dispute-concede.md](done-writer-dispute-concede.md) | feature | **done** (merged 2026-09-06) — `isConcession` + `executeWriterConcedeDispute` in `src/tools.ts`; Phase B `negotiate_propose("agree")` is a concession (closes dispute, no count, no entry); 6 prompt lines added (3 languages × 2 prompts); 7 new tests in `test/extension.test.ts` + 6 prompt pins in `test/prompts.test.ts`. |
| [done-spec-archive-rename-failure-test.md](done-spec-archive-rename-failure-test.md) | test | **done** (2026-09-06) | Option B: injectable `rename` param in `archiveSpecFile`; 2 new tests (throw → null; default uses `fs.renameSync`); red-verified; 1197 passed. |

## Reference / non-implementable

| File | Kind | Note |
|---|---|---|
| [vitest5-upgrade.md](vitest5-upgrade.md) | reference doc | Vitest 5.0 migration guide (vendored), **not** a loop spec. Installed vitest is **4.1.11** (verified 2026-09-06) — a real upgrade would be its own spec. |

## Done

| Spec | Type | Status |
|---|---|---|
| [done-refactor-single-commit-point.md](done-refactor-single-commit-point.md) | refactor | **done** (merged `90e6f24`) — dispatcher commits once per settle (end of `handlePhaseSettled`) + escalated at production; S2 turn counter, negotiate settle, gate settle all persist. |
| [done-bug-negotiate-settle-not-persisted.md](done-bug-negotiate-settle-not-persisted.md) | bug | **done** (subsumed by `90e6f24`) — negotiate settle commits the advanced round + cleared markers; regression `test/negotiate-persist.test.ts` (5 reload rows, red-verified). |
| [08-clear-dispute-flags.md](08-clear-dispute-flags.md) | bug | **done** (file not renamed) — all state builders + direct-mutation sites now clear `awaitDisputeFix`/`awaitDisputeReview` at every phase boundary (`src/transitions.ts:285-327`); regression `test/extension.test.ts:1764` (sites 6-11). Verified 2026-09-06. |
| [09-wire-dispute-review.md](09-wire-dispute-review.md) | bug | **done** (file not renamed) — `handleDisputeReview` (`src/events/agent-settled/dispute.ts:43`) schedules the reviewer turn (Table 1), returns `handled:true`; `handleDisputeDefend`/`handleWriterConcedeFix` (Table 3); retired `applyRetryEffect` dispute branch + `GP.promptWriterDispute` + `sendContextMessage` all deleted (verified 2026-09-06). |
| [10-report-loop-completion.md](10-report-loop-completion.md) | bug | **done** (file not renamed) — `applyDoneEffect` → `reportDone` (`src/events/agent-settled/effect-applicator.ts:144`) sends `GP.promptLoopComplete` in-transcript (`sendUserMessage`, `triggerTurn`); pinned `test/events/agent-settled/effect-applicator.test.ts:190`. Verified 2026-09-06. |
| [bug-negotiate-drift.md](bug-negotiate-drift.md) | bug | **done** (file not renamed) — `executeNegotiateReReview` in `src/tools.ts` + `test/tools-negotiate-re-review.test.ts`. |
| [bug-loop-breaker-repetition-with-mutation.md](bug-loop-breaker-repetition-with-mutation.md) | bug | **done** (merged `4aec55d`; file not renamed) — skeleton keying in `src/events/tool-call/index.ts`; regression `test/events/tool-call-breaker.test.ts`. |
| [bug-fragile-event-handler-selection.md](bug-fragile-event-handler-selection.md) | bug | **done** (merged `4aec55d`; file not renamed) — `findEventHandler` predicate; test-only. |
| [done-bug-gate-signal-integrity.md](done-bug-gate-signal-integrity.md) | bug | **done** (merged `fc51a53`, branch `gate-coverage`). |
| [done-refactor-state-model-divergence.md](done-refactor-state-model-divergence.md) | refactor | **done** (merged `f987e0f`, branch `model-divergence`). |
| [done-bug-negotiate-confirm-approval-loop.md](done-bug-negotiate-confirm-approval-loop.md) | bug | **done** (merged `b9bd8db`) — fixes a defect in bug-negotiate-drift's row 2. |
| [done-bug-slow-gate-signal-tests.md](done-bug-slow-gate-signal-tests.md) | bug | **done** (resolved 2026-09-06 — hang gone under vitest 4.1.11; 85.71 fixture was a 2-column trap; 13 skips → 0). |
| [done-bug-gate-slow-settle-duplicate.md](done-bug-gate-slow-settle-duplicate.md) | bug | **done** (2026-09-06) — `gateInFlight` module lock in `handleGateTransition`; duplicate settle → `NO_GATE` (no double gate run / double prompt); `finally` clear prevents wedges on a throwing gate; 3 regression tests, red-verified. |
| [done-bug-dispute-reload-evaporation.md](done-bug-dispute-reload-evaporation.md) | bug | **done** (2026-09-06) — 6 dispute flags → 1 `DisputeState` status object; `migrateDispute` in session-start; `clearTransientFlags` no longer touches dispute; budget at resolution not filing; 4 handlers rewritten; 19+ test flips across 8 files; 1170 tests passing. |
| [done-bug-gate-green-stays-green.md](done-bug-gate-green-stays-green.md) | bug | **done** (2026-09-06) — `makeGoCwd` fixture now writes `main.go` (buildable Go module); Writer prompt mandates `negotiate_propose` exit path for unpassable tests; "green stays green" live-toolchain regression added to `test/gate-signal-integrity.test.ts`. |
| [done-bug-gate-verdict-field.md](done-bug-gate-verdict-field.md) | bug | **done** (2026-09-06) — `GateResult.tests` deleted; `allPassed` is the single verdict field; 11 src files + 28 test files updated; T4 regression red-verified. |
| [done-writer-dispute-concede.md](done-writer-dispute-concede.md) | feature | **done** (2026-09-06) — Phase B `negotiate_propose("agree")` is a concession (closes dispute, no count, no entry); `isConcession` + `executeWriterConcedeDispute` in `src/tools.ts`; 6 prompt lines added; 7 new tests + 6 prompt pins. |

## Recommended order of operation

1. **bug-baseline-flake** — done (`vi.mock("node:child_process")` in `test/extension.test.ts`; `mkdtemp` per test; `git-workflow.test.ts` cwd → `os.tmpdir()`).
2. **bug-phase-0-approval-dead-end** — done (Phase × Tool policy matrix; Phase 0 approve/feedback handlers).
3. **golden-workspace-fix** — **done** (2026-09-06).
4. **spec-archive-rename-failure-test** — done (Option B: injectable rename param; 2 new tests; red-verified).

**Deliberately NOT in the batch:** the `--skip-review` flag (dead end — removed from docs, not implemented), metrics (dead — deleted), the `done`-phase display polish, and the Vitest 5 upgrade (reference doc only; installed vitest is 4.1.11).

## Corrections applied 2026-09-06 (index was stale)

**Verified-done, previously listed open/inconsistent:**
- `08-clear-dispute-flags`, `09-wire-dispute-review`, `10-report-loop-completion` were listed **open** but are **done** — verified against the live tree (state builders clear both flags at every boundary; `handleDisputeReview` schedules the reviewer turn + Tables 3 wired + retired branch/prompts deleted; `reportDone` sends `promptLoopComplete` in-transcript). Files not yet renamed to `done-` prefix.
- `spec-command`, `log-bug-spec`, `ts-gate-coverage-provider` were **missing from the index entirely** — verified done (`cmdSpec` registered `index.ts:57`; `/loop-debug --log-bug` in `src/commands.ts`; `hasVitestCoverageProvider` probe + conditional `getTestCommand`).
- `bug-negotiate-drift`, `bug-loop-breaker-repetition-with-mutation`, `bug-fragile-event-handler-selection` were listed **open** but are **done** (files not renamed).

**Added to the index (were untracked):**
- `golden-workspace-fix` (done), `writer-dispute-concede` (done), `spec-archive-rename-failure-test` (done), `vitest5-upgrade` (reference doc, not a loop spec).

**Confirmed still open (re-verified against the live tree):**
- `bug-baseline-flake` — `runBaselineTests` runs a real `execSync(go test …)`.

**Resolved in the same session:**
- `bug-gate-green-stays-green` — `makeGoCwd` fixture now writes `main.go`; Writer prompt mandates dispute exit path; "green stays green" regression added.
- `bug-gate-verdict-field` — `GateResult.tests` deleted; `allPassed` is the single verdict field; 11 src + 28 test files updated; T4 regression red-verified.

**Prior corrections (kept):** `bug-gate-signal-integrity` done (`fc51a53`); `refactor-state-model-divergence` done (`f987e0f`); `bug-slow-gate-signal-tests` resolved (13 skips → 0); `bug-gate-slow-settle-duplicate` filed 2026-09-06, **resolved the same day** (module-local `gateInFlight` lock + `NO_GATE` live + 3 red-verified regression tests; full suite 1173 passed).
