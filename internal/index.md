# Spec Index

Conventions for specs in this directory: [docs/spec-authoring.md](../docs/spec-authoring.md).

**Status legend:** `open` = ready to implement; `blocked` = has a hard dependency; `done` = implemented and verified (rename file `done-`-prefix).

| Spec | Type | Status | Dependencies (hard → soft) |
|---|---|---|---|
| [bug-gate-signal-integrity.md](bug-gate-signal-integrity.md) | bug | open | — |
| [refactor-single-commit-point.md](refactor-single-commit-point.md) | refactor | open | hard: bug-gate-signal-integrity |
| [refactor-state-model-divergence.md](refactor-state-model-divergence.md) | refactor | open | — (must land before bug-dispute-reload-evaporation) |
| [bug-negotiate-settle-not-persisted.md](bug-negotiate-settle-not-persisted.md) | bug | blocked | hard: refactor-single-commit-point; soft: bug-gate-signal-integrity |
| [bug-dispute-reload-evaporation.md](bug-dispute-reload-evaporation.md) | bug | blocked | hard: refactor-single-commit-point; soft: bug-gate-signal-integrity, refactor-state-model-divergence |
| [bug-phase-0-approval-dead-end.md](bug-phase-0-approval-dead-end.md) | bug | open | soft: refactor-single-commit-point |
| [bug-negotiate-drift.md](bug-negotiate-drift.md) | bug | open | — (observed in the bug-gate-signal-integrity run, 2026-08-18) |
| [bug-gate-green-stays-green.md](bug-gate-green-stays-green.md) | bug | open | soft: bug-negotiate-drift (shares the S1 skipIf fix) |
| [bug-gate-verdict-field.md](bug-gate-verdict-field.md) | bug | blocked | hard: bug-gate-signal-integrity (assumes its allPassed semantics); sequence after bug-gate-green-stays-green (same fixture) |

## Recommended order of operation

1. **bug-gate-signal-integrity** — the spurious-green gate is the most dangerous single defect: it can advance Phase B→C on a red project, and every later unit's "persist the gate result" work is worthless if the result is wrong. It also changes the settle dispatcher's structure, so landing it first keeps every downstream diff clean.
2. **refactor-single-commit-point** — every other persistence fix in this batch (negotiate, dispute, Phase 0) is a *commit point*, not a feature. Without it, each fix would add a 15th/16th/17th ad-hoc `appendEntry` site and the desync class would survive the fixes.
3. **refactor-state-model-divergence** — independent of the persistence chain, but must land before the dispute spec so the validator's shape check includes the new `dispute` field in one pass. Also the biggest green-suite shrink (~520 dead tests), so landing it early shrinks the surface every later spec's test strategy has to reason about.
4. **bug-negotiate-settle-not-persisted** — becomes test-only once #2 lands; cheap, and it closes the round-ping-pong desync that is the most likely to bite in daily use (negotiate is the most frequent phase).
5. **bug-dispute-reload-evaporation** — the largest single rewrite (6 flags → 1 status object, 19 counted test flips). Last of the persistence batch because it depends on both #2 and #3, and its redelivery-on-settle is only idempotent with commits in place.
6. **bug-phase-0-approval-dead-end** — fully independent; can land any time. Placed last because it is the least dangerous (no wrong *progress* — just a confusing dead-end that a human `/loop-approve` already works around) and its Phase 0 transition is cleanest to write after the commit mechanism exists.

**Why not parallelize 1+3?** They touch disjoint files except `src/types.ts` (gate spec: none; divergence spec: field removals) — they *could* run in parallel, but both land in the same review window and both change the test-file count, so serial keeps the acceptance greps unambiguous.

**What is deliberately NOT in this batch:** the `--skip-review` flag (dead end — removed from docs in #3, not implemented), metrics (dead — deleted in #3), and the `done`-phase display polish (no user-facing defect beyond what #2's commit fixes).
