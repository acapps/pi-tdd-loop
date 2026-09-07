# Spec Index

Conventions for specs in this directory: [docs/spec-authoring.md](../docs/spec-authoring.md).

**Status legend:** `open` = ready to implement; `blocked` = has a hard dependency; `done` = implemented and verified (rename file `done-`-prefix).

| Spec | Type | Status | Dependencies (hard → soft) |
|---|---|---|---|
| [refactor-single-commit-point.md](refactor-single-commit-point.md) | refactor | open | hard: bug-gate-signal-integrity (**done** — merged `fc51a53`; dependency satisfied) |
| [bug-negotiate-settle-not-persisted.md](bug-negotiate-settle-not-persisted.md) | bug | blocked | hard: refactor-single-commit-point |
| [bug-dispute-reload-evaporation.md](bug-dispute-reload-evaporation.md) | bug | blocked | hard: refactor-single-commit-point |
| [bug-phase-0-approval-dead-end.md](bug-phase-0-approval-dead-end.md) | bug | open | soft: refactor-single-commit-point |
| [bug-gate-green-stays-green.md](bug-gate-green-stays-green.md) | bug | open | soft: bug-negotiate-drift (**done** — re-review landed `04b9519`; the S1 `skipIf`/30s *contract* fix this spec pins is still outstanding) |
| [bug-gate-verdict-field.md](bug-gate-verdict-field.md) | bug | open | hard: bug-gate-signal-integrity (**done** — `allPassed` semantics in place); sequence after bug-gate-green-stays-green (same fixture) |
| [bug-gate-slow-settle-duplicate.md](bug-gate-slow-settle-duplicate.md) | bug | open | — (filed 2026-09-06: duplicate `agent_settled` while a gate run is in flight double-runs the gate; the `NO_GATE` sentinel is exported but never returned) |
| [bug-baseline-flake.md](bug-baseline-flake.md) | bug | open | — |
| [bug-loop-breaker-repetition-with-mutation.md](bug-loop-breaker-repetition-with-mutation.md) | bug | done (merged at `4aec55d`; file not yet renamed — rename to `done-` prefix) | hard: bug-confirm-approval (merged) |
| [bug-fragile-event-handler-selection.md](bug-fragile-event-handler-selection.md) | bug | done (merged at `4aec55d`; file not yet renamed — rename to `done-` prefix) | — (test-only) |
| [bug-negotiate-drift.md](bug-negotiate-drift.md) | bug | done (implemented — `executeNegotiateReReview` in `src/tools.ts` + `test/tools-negotiate-re-review.test.ts`; file not yet renamed) | — (observed in the bug-gate-signal-integrity run, 2026-08-18) |
| [bug-gate-signal-integrity.md](done-bug-gate-signal-integrity.md) | bug | done (merged at `fc51a53`, branch `gate-coverage`) | — |
| [refactor-state-model-divergence.md](done-refactor-state-model-divergence.md) | refactor | done (merged at `f987e0f`, branch `model-divergence`) | — |
| [bug-negotiate-confirm-approval-loop.md](done-bug-negotiate-confirm-approval-loop.md) | bug | done (merged at `b9bd8db`) | — (observed in the refactor-state-model-divergence run, 2026-09-05; fixes a defect in bug-negotiate-drift's row 2) |
| [bug-slow-gate-signal-tests.md](done-bug-slow-gate-signal-tests.md) | bug | done (resolved 2026-09-06 — hang gone under vitest 4.1.11; 85.71 fixture was a 2-column trap; 13 skips → 0) | — |

## Recommended order of operation

1. **refactor-single-commit-point** — every other persistence fix in this batch (negotiate, dispute, Phase 0) is a *commit point*, not a feature. Without it, each fix would add another ad-hoc `appendEntry` site and the desync class would survive the fixes. Its hard dependency (bug-gate-signal-integrity) is done.
2. **bug-negotiate-settle-not-persisted** — becomes test-only once #1 lands; cheap, and it closes the round-ping-pong desync that is the most likely to bite in daily use (negotiate is the most frequent phase).
3. **bug-dispute-reload-evaporation** — the largest single rewrite (6 flags → 1 status object, 19 counted test flips). Last of the persistence batch because it depends on #1.
4. **bug-gate-green-stays-green** — the `green stays green` regression test is unpassable by construction (test-only Go module → `go build` fails → early return; S1 passes for the wrong reason). The 2026-09-06 probe confirmed the *fix* works (buildable fixture → green passes, S1 red via the test step); the contract-side fixes (fixture, mandatory-dispute prompt line, B-phase dispute flow) are unimplemented. Lands the live-toolchain regression tests that `bug-slow-gate-signal-tests` moved out of the default suite.
5. **bug-gate-slow-settle-duplicate** — small, self-contained, safety: a duplicate settle while a gate run is in flight double-runs the gate and double-prompts. No dependency; can land any time.
6. **bug-phase-0-approval-dead-end** — fully independent; can land any time. Least dangerous (no wrong *progress* — a confusing dead-end a human `/loop-approve` already works around).
7. **bug-gate-verdict-field** — cleanup of the two-field verdict (`tests` + `allPassed`, same value); sequence after #4 (shares its fixture).
8. **bug-baseline-flake** — `runBaseline()` runs a real `go test` from a mock cwd (shared fixture + toolchain contention → transient red at loop start); daily friction, independent.

**What is deliberately NOT in this batch:** the `--skip-review` flag (dead end — removed from docs, not implemented), metrics (dead — deleted), and the `done`-phase display polish.

## Corrections applied 2026-09-06 (index was stale)

- `bug-gate-signal-integrity` was listed `open` but is **done** (merged `fc51a53`); its dependents (`refactor-single-commit-point`, `bug-negotiate-settle-not-persisted`, `bug-dispute-reload-evaporation`, `bug-gate-verdict-field`) unblocked accordingly.
- `refactor-state-model-divergence` was listed `open` but is **done** (merged `f987e0f`; file already `done-`-prefixed).
- `bug-negotiate-drift` was listed `open` but is **done** (`executeNegotiateReReview` in `src/tools.ts`, `test/tools-negotiate-re-review.test.ts` present) — file rename pending.
- `bug-loop-breaker-repetition-with-mutation` + `bug-fragile-event-handler-selection` were listed `open` but are **done** (merged `4aec55d`) — file renames pending.
- `bug-slow-gate-signal-tests` was listed `open` with 13 skipped tests; **resolved** (hang gone under vitest 4.1.11, fixture trap fixed, all skips re-enabled; 1165 passed / 0 skipped / 8.6s).
- New: `bug-gate-slow-settle-duplicate` (filed 2026-09-06 from the gate-signal-integrity verification: the `NO_GATE` duplicate-settle lock the contract file promised was never written — reproduced with a concurrent-settle probe).
