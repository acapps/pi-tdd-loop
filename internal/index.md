# Spec Index

Conventions for specs in this directory: [docs/spec-authoring.md](../docs/spec-authoring.md).

**Status legend:** `open` = ready to implement; `blocked` = has a hard dependency; `done` = implemented and verified (rename file `done-`-prefix).

## Active specs

| Spec | Type | Status | Dependencies (hard → soft) |
|---|---|---|---|
| [done-refactor-commands-split.md](done-refactor-commands-split.md) | refactor | **done** | Split `src/commands.ts` (824 lines) into `src/commands/` directory (6 modules) + `src/state-helpers.ts`. |
| [done-refactor-tools-split.md](done-refactor-tools-split.md) | refactor | **done** | Split `src/tools.ts` (549 lines) into `src/tools/` directory (7 modules). Pure file reorganization, no behavioral change. |
| [done-bug-advance-effect-dual-path.md](done-bug-advance-effect-dual-path.md) | bug | **done** | Two appliers apply the same `advance` effect (agent-settled `applyAdvanceEffect` + tool-call `applyTransitionEffect`) and diverged — the tool-call path never sent the Phase B prompt, stalling the loop in two live sessions. Consolidated prompt delivery into `deliverAdvancePrompt` helper. Also widened `isAgreeProposal` to word-boundary regex (session 01a0a668: Writer sent "agree\n\nTests match..." which the old prefix-set check missed). |
| [done-spec-format-validation.md](done-spec-format-validation.md) | feature | **done** (2026-09-10) | `validateSpecStructure` in `reviewer.ts`; structural findings (missing sections) prepended to heuristic findings; `"Missing section"` category; 12 new tests. |
| [done-loop-completion-report.md](done-loop-completion-report.md) | feature | **done** (2026-09-10) | `formatReport` + live metrics singleton in `metrics.ts`; `promptLoopReport` replaces `promptLoopComplete`; accumulation wired into gate/phase/turn/dispute events; 26 new tests. |
| [done-loop-config-file.md](done-loop-config-file.md) | feature | **done** (2026-09-10) | `loop.config.json` project-level defaults; `loadLoopConfig` + `mergeLoopArgs` in `selectors.ts`; CLI overrides config; 6 new optional fields on `LoopArgs`; 10 new tests. |
| [done-loop-spec-patch-resume.md](done-loop-spec-patch-resume.md) | feature | **done** (2026-09-10) | `/loop-patch` command; re-read spec, reset round, record `loop-spec-patch` entry, send "spec was patched" prompt; 11 new tests. |
| [done-spec-decomposition.md](done-spec-decomposition.md) | feature | **done** (2026-09-10) | `/loop-decompose` command; LLM-driven spec splitting into sub-specs; stateless (no loop state change); 6 new tests. |
| [bug-dispute-reload-evaporation.md](done-bug-dispute-reload-evaporation.md) | bug | **done** (merged 2026-09-06) — 6 dispute flags → 1 `DisputeState` status object; `migrateDispute` in session-start; `clearTransientFlags` no longer touches dispute; budget at resolution not filing; 4 handlers rewritten; 19+ test flips across 8 files; 1170 tests passing. |
| [bug-gate-green-stays-green.md](done-bug-gate-green-stays-green.md) | bug | **done** (merged 2026-09-06) — `makeGoCwd` fixture now writes `main.go` (buildable Go module); Writer prompt mandates `negotiate_propose` exit path for unpassable tests; "green stays green" live-toolchain regression added to `test/gate-signal-integrity.test.ts`. |
| [bug-gate-slow-settle-duplicate.md](done-bug-gate-slow-settle-duplicate.md) | bug | **done** (merged 2026-09-06) — module-local `gateInFlight` lock in `handleGateTransition` (check + `try/finally` clear); duplicate settle returns the now-live `NO_GATE` sentinel; 3 regression tests (concurrent drop / no-wedge / wedge-on-throw) in `test/events/agent-settled/gate-transition.test.ts`, red-verified. |
| [bug-gate-verdict-field.md](done-bug-gate-verdict-field.md) | bug | **done** (merged 2026-09-06) — `GateResult.tests` deleted; `allPassed` is the single verdict field; 11 src files + 28 test files updated; T4 regression red-verified. |
| [done-bug-baseline-flake.md](done-bug-baseline-flake.md) | bug | **done** (2026-09-06) | `vi.mock("node:child_process")` in `test/extension.test.ts` (no real `go test`/`go version`); shared `/tmp/test-project` → `mkdtemp` per test; `git-workflow.test.ts` default cwd → `os.tmpdir()`. TEST SPEED RULE compliance. |
| [done-loop-continue-runner.md](done-loop-continue-runner.md) | feature | **done** (2026-09-09) | Status file (`.pi/loop-status`) written in `commit()` when `PI_LOOP_RUNNER=1`; `bin/run-loop.sh` wraps `pi --continue --print` in a loop; uses existing `/loop-continue` command. 12 regression tests. |
| [done-fix-print-mode-session-replacement.md](done-fix-print-mode-session-replacement.md) | bug | **done** (2026-09-09) | `sendPrompt()` adapts to runner mode: writes prompt to status file instead of `pi.sendUserMessage`. All 18+ call sites updated. `pi.appendEntry` wrapped in try-catch. 9 new regression tests. |
| [done-bug-breaker-notice-triggers-turn.md](done-bug-breaker-notice-triggers-turn.md) | bug | **done** (2026-09-09) | `sendUserMessage` → `sendMessage({ triggerTurn: false })` in breaker notice. Mock captures `sentCustomMessages`. |
| [done-loop-pause-command.md](done-loop-pause-command.md) | feature | **done** (2026-09-09) | `/loop-stop` command: sets phase to `escalated`, commits, notifies. No `sendUserMessage`. |
| [done-remove-dead-metrics.md](done-remove-dead-metrics.md) | cleanup | **done** (2026-09-09) | **Invalid spec** — `src/metrics.ts` is used by `test/golden/runner.ts` and `test/e2e/runner.ts`. Not dead code. No change. |
| [done-gate-timeout-config.md](done-gate-timeout-config.md) | feature | **done** (2026-09-09) | `--timeout <N>` flag on `/loop`; `gateTimeoutSec` in `LoopState`; threaded through `runGates` → `execCommand`. 27 test fixtures updated. |
| [done-loop-status-command.md](done-loop-status-command.md) | feature | **done** (2026-09-09) | Enhanced existing `/loop-status`: phase/round/turns/disputes/spec/language snapshot. Idle/done/escalated branches. |
| [done-bug-golden-baseline-cwd.md](done-bug-golden-baseline-cwd.md) | bug | **done** (merged `03fb45c`) | Golden project baseline runs in workspace root; `sendUserMessage` → `deliverAs: "followUp"`; 33 test assertions updated. |
| [done-phase0-auto-approve.md](done-phase0-auto-approve.md) | feature | **done** (merged `4437904`) | Phase 0 auto-advance when review is clean (no feedback, no dispute); `--no-auto-approve` opt-out; 5-row decision table in `handleReviewSettled`; `lang` param becomes live. 14 tests in review.test.ts (was 3). |
| [done-bug-phase-0-approval-dead-end.md](done-bug-phase-0-approval-dead-end.md) | bug | **done** | Phase × Tool policy matrix; Phase 0 approve/feedback handlers; `/loop-restart` extended. |
| [done-bug-dispute-block-trap.md](done-bug-dispute-block-trap.md) | bug | **done** | Rule 2 only blocks on `"filed"` (filer's turn ending), not `"in-review"` (reviewer active). Reviewer gets read/bash/negotiate_review access. |
| [bug-dispute-fix-redundant-turn.md](bug-dispute-fix-redundant-turn.md) | bug | **open** | `handleDisputeFix` fires on `"conceded"` + writer-filed even if the Tester already fixed the test in the same turn. Needs a "work already done" check. |
| [done-bug-phase-restart-on-reload.md](done-bug-phase-restart-on-reload.md) | bug | **done** (superseded by `done-fix-session-restart.md`, `46236a4`) | Mid-phase reload resume via `justTransitioned` + `buildResumePrompt`. File kept as historical record. |
| [done-bug-phase0-scanner-noise.md](done-bug-phase0-scanner-noise.md) | bug | **done** (2026-09-23, `fix-phase0-scanner-noise`) | Backtick-gated CONCEPT_PATTERNS, contract-scoped IO detection, S1 framing line. 43 contract tests in `test/contracts/`. |
| [bug-role-context-mismatch.md](bug-role-context-mismatch.md) | bug | **open** (rewritten 2026-09-23, `fix-b-phase-role-context`) | Phase B loop-context dispatches on phase only — the Tester's dispute-review turn and the Writer's tester-filed concede-fix turn both get the bare Writer context. Rewritten against the template against the current `dispute: DisputeState` shape (the original draft keyed off retired flat fields). 0 Phase 0 findings. |
| [fix-negotiated-resolution-dropped.md](fix-negotiated-resolution-dropped.md) | bug | **open** (2026-09-24, `fix-negotiated-resolution-dropped`) | Negotiate tool-call advance (`transitionToPhaseB` → `promptWriterPhaseB`) carries no resolution, so a test-touching agreed resolution is silently dropped — the Writer is barred from editing `*.test.ts`, the gate goes green, the loop reports done (session 01a0d128). Capture the Tester's concession in `state.negotiateResolution`, append it to the Phase B prompt via `buildAdvancePrompt` with boundary + no-false-done language. |
| [bug-coverage-noop-ts.md](bug-coverage-noop-ts.md) | bug | **open** (partial) | TS row closed (degrade to plain `vitest run`). Java/jacoco named-reason row still open. |

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
| [done-vitest5-upgrade.md](done-vitest5-upgrade.md) | reference doc | **done** (decision: do not upgrade) | Vitest 5.0 migration guide (vendored), **not** a loop spec. Installed vitest is **4.1.11**. Decision: stay on 4.x. |

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
