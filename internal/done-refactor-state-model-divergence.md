# refactor-state-model-divergence

## Problem

Verified current state as of writing (baseline: `npx tsc --noEmit` clean; `npm test` → 32 files, 1017 tests, 0 failures):

**A second, dead state model exists and has diverged from the live one.** The live machine runs on the flat `LoopState` (`src/types.ts:5-43`). The "Target Architecture" from `done-loop-state-refactor.md` lives in five modules that **no production code imports** (grep-proven: zero imports of `state-validation`, `state-factory`, `state-migration`, `transient-flags` from anywhere in `src/` or `index.ts`; their only consumers are their own test files):

| Module | Exports | Production importers |
|---|---|---|
| `src/state-types.ts` | `LoopState` (sub-structure), `LoopIdentity`, `PhaseMachine`, `NegotiationState`, `DisputeState`, `GateState`, `PhaseZeroState`, `LoopSubStructures` | 0 (only `state-validation.ts`, `state-factory.ts`, `state-migration.ts`, `transient-flags.ts` — all dead) |
| `src/state-validation.ts` | `validateState` | 0 |
| `src/state-factory.ts` | `createInitialState` (sub-structure shape) | 0 — note the **name collision** with the live `createInitialState` in `src/commands.ts:96` (flat shape) |
| `src/state-migration.ts` | `toSubStructures`, `applySubStructures` | 0 |
| `src/transient-flags.ts` | `clearTransientFlags` (sub-structure shape) | 0 — the **live** `clearTransientFlags` is a different function, local to `src/events/session-start.ts:41` (flat shape) |

**The dead validator contradicts the live machine (three concrete conflicts, all verified):**

1. `state-validation.ts:30-32` — Rule 1: `done ⇒ round must be 0`. The live `markDone` (`src/transitions.ts:277`) deliberately keeps `round` (it is the round the loop finished on, surfaced by `/loop-status` and `promptLoopComplete`). A *normal* completed loop would fail validation.
2. `state-validation.ts:35-38` — Rule 3: `escalated ⇒ lastPhase ∈ {B, C}`. The live machine escalates from **Phase A** (`handleTesterCompileFail`, `src/transitions.ts:143-148` — `escalateTo(state, "A")`) and from **negotiate** (`computeNegotiateTransition`, `src/transitions.ts:59-62` — `escalateTo(state, "negotiate")`, where `lastPhase` is whatever the pre-negotiate phase was, typically `"A"`). Both are valid live transitions the validator rejects.
3. `state-validation.ts:50-52` — Rule 5: `non-done ⇒ turnsThisPhase >= 1`. The live initial state (`index.ts:33`) has `turnsThisPhase: 0` in phase `idle` — and `idle` is non-done. The validator rejects the machine's own starting state.

**Consequence:** the team has 18k+ lines of tests (`test/state-validation.test.ts`, `test/state-factory.test.ts`, `test/state-migration.test.ts`, `test/state-types.test.ts`, `test/transient-flags.test.ts` — 5 files, ~520 tests) asserting invariants that the running product does not enforce. The green suite is a false guarantee.

**Related dead weight in the same family:**
- `src/metrics.ts` — 0 production importers (grep-proven). Its `LoopMetrics` interface **collides by name** with the live `LoopMetrics` in `src/types.ts:45-55` and **diverges from it** (the dead one has `specPath`, `startTime`, `turnsByPhase`, `disputesConceeded`, `finalized`; the live one has `totalGates`, `roundsByPhase`, `filesBlocked`, `coverage`). `test/metrics.test.ts` (25KB) tests the dead shape.
- `src/types.ts:42` — `skipPhase0?: boolean` is written by `createInitialState` (`src/commands.ts:122`) and read by **no code** (grep-proven: 0 reads). `state-migration.ts:20` documents it as dead. The `/loop` usage string advertises `--skip-review` (`src/commands.ts:139`) but `parseLoopArgs` (`src/selectors.ts`) **does not parse it** — the flag is silently ignored (verified: the parser handles only `--coverage` and `--language`).
- `src/reviewer.ts:84-90` — `shouldActivatePhase0` is a hardcoded `return { activate: true, reasons: ["Phase 0 is the baseline"] }`; its `_thresholds` parameter and the `PhaseZeroThresholds`/`DEFAULT_PHASE_ZERO_THRESHOLDS` types (`src/types.ts:88-100`) are dead. `DEFAULT_PHASE_ZERO_THRESHOLDS` has 0 production readers (grep-proven).

## Target

After this refactor: **one state model** — the flat `LoopState` — with its invariants expressed in one live validator that runs at the two points that matter (commit and restore). The five dead sub-structure modules, the dead metrics module, and the dead Phase-0 threshold surface are **deleted**, not reconciled. The `--skip-review` flag is either implemented or removed from the usage string (decision: removed — Phase 0 is a baseline per `shouldActivatePhase0`'s own doc comment, and adding a skip path is a feature, not a cleanup; if wanted, it gets its own spec). No behavior change to the live machine beyond the validator actually running.

## Interface

```ts
// src/state-validation.ts — REWRITTEN (flat shape; the sub-structure version is deleted)
import type { LoopState, Phase, LanguageKey, BuildTool } from "./types";

export const PHASES: readonly Phase[] = ["review", "A", "negotiate", "B", "C", "done", "escalated", "idle"];

export function validateLoopState(data: unknown): data is LoopState {
  // shape check (supersedes the shape-only validateRestoredState proposed in
  // refactor-single-commit-point.md — that function is folded into this one):
  //   - object, non-null
  //   - phase ∈ PHASES; language ∈ {"go","java","typescript"}; buildTool ∈ {"maven","gradle","go"}
  //   - round, turnsThisPhase, maxA, maxNegotiate, maxB, maxC, maxDispute,
  //     maxTurnsPerPhase, coverageThreshold, disputeCount: number
  //   - disputeMode, justTransitioned, negotiateReprompted, awaitDisputeFix,
  //     awaitDisputeReview: boolean (negotiateProposed?, negotiateFeedback?: optional)
  //   - specPath, lastProposal: string
  // invariant check (the live machine's actual invariants — see Behavior):
  //   - escalated ⇒ lastPhase ∈ {"A", "negotiate", "B", "C"}   (was: {B,C} — WRONG)
  //   - done ⇒ lastPhase ∈ {"A", "negotiate", "B", "C"}        (NEW — done is only reachable via markDone from B/C; pinned)
  //   - round >= 1 in all non-idle phases                        (was: "non-done" — idle included, WRONG)
  //   - turnsThisPhase >= 0 everywhere; >= 1 in non-idle, non-escalated phases
  //     (was: "non-done >= 1" — rejected the live initial idle state, WRONG)
  //   - disputeCount <= maxDispute
  // Returns false, never throws.
}
```

**Call sites (closed list — 2):**
1. `src/commit.ts:commit` (`refactor-single-commit-point.md`) — validate before `appendEntry`; on failure, debug `commit: state failed validation — ${errors}` and **still persist** (a broken state persisted is recoverable via quarantine-on-restore; a broken state *not* persisted is silently lost — pinned decision, see quirk Q1).
2. `src/events/session-start.ts:handleSessionStart` — validate the restored entry; on failure, quarantine (pinned strings from `refactor-single-commit-point.md`: status `state corrupted — run /loop to restart`, debug `session_start: restored entry failed validation — quarantining`).

**Deletions (closed list — 8 files + 1 test file per module):**
- `src/state-types.ts` — deleted (0 production importers; the `DisputeState` name collision with `bug-dispute-reload-evaporation.md` is resolved in that spec's favor — the live flat `LoopState` gains the field, no sub-structure).
- `src/state-factory.ts` — deleted (name collision with `commands.ts:createInitialState`; the live factory is the one in `commands.ts`).
- `src/state-migration.ts` — deleted (its `toSubStructures`/`applySubStructures` have 0 callers).
- `src/transient-flags.ts` — deleted (the live `clearTransientFlags` is the local one in `session-start.ts`; this module's sub-structure version has 0 callers).
- `src/state-validation.ts` — **rewritten** per Interface (not deleted — it becomes the live validator).
- `src/metrics.ts` — deleted (0 production importers; the live `LoopMetrics` in `types.ts` is also unused by production code — grep-proven: `LoopMetrics` has 0 production readers; it is deleted from `types.ts` too, pinned: the interface stays only if a future metrics feature re-adds it with a consumer).
- `src/types.ts:42` — `skipPhase0` field deleted; `src/commands.ts:122` (its only writer) deleted; the usage string at `src/commands.ts:134,139` loses `--skip-review`; `SPEC.md`'s `/loop` section updated (doc).
- `src/reviewer.ts:84-90` — `shouldActivatePhase0` deleted; `analyzeSpec` returns `{ findings, reasons: ["Phase 0 is the baseline"] }` directly (pinned: the `SpecAnalysis` interface in `types.ts:103-107` loses `shouldActivatePhase0`, keeps `reasons`); `PhaseZeroThresholds` + `DEFAULT_PHASE_ZERO_THRESHOLDS` deleted from `types.ts`.

**Test files deleted with their modules (closed list — 6):** `test/state-types.test.ts`, `test/state-factory.test.ts`, `test/state-migration.test.ts`, `test/state-validation.test.ts` (rewritten, not deleted — see Test Strategy), `test/transient-flags.test.ts`, `test/metrics.test.ts`.

## Behavior

Validator decision table (rows = the three corrected invariants + shape; first-fail-wins, all failures collected into the returned error list for the debug line):

| # | Check | Old (dead module) rule | Live machine fact (evidence) | New rule |
|---|---|---|---|---|
| 1 | done/round | `done ⇒ round === 0` | `markDone` keeps round (`transitions.ts:277`); `/loop-status` displays it | **no constraint** on round in done |
| 2 | escalated origin | `escalated ⇒ lastPhase ∈ {B,C}` | `escalateTo(state, "A")` reachable (`transitions.ts:148`); negotiate escalation (`transitions.ts:61`) | `escalated ⇒ lastPhase ∈ {A, negotiate, B, C}` |
| 3 | idle counter | `non-done ⇒ turnsThisPhase >= 1` | initial state `turnsThisPhase: 0, phase: "idle"` (`index.ts:33`) | `turnsThisPhase >= 1` only in {review, A, negotiate, B, C} |
| 4 | round floor | `non-done ⇒ round >= 1` | idle has `round: 0` (`index.ts:32`) | `round >= 1` in all phases except `idle` |
| 5 | dispute budget | (absent) | `disputeCount` increments at filing, `maxDispute: 3` | `disputeCount <= maxDispute` (note: `bug-dispute-reload-evaporation.md` moves the increment to resolution — the inequality holds under both semantics; pinned) |

**Quirks list:**
- Q1: the commit-side validation failure persists anyway (Interface, call site 1). A persist-then-quarantine cycle (commit writes a broken entry, next restore quarantines it) is *more* recoverable than a silent drop — the session log keeps the evidence. Pinned, do not "fix" to skip the persist.
- Q2: `validateLoopState` accepts `lastPhase: "idle"` in non-escalated states (the initial state has `lastPhase: "idle"`, `index.ts:36`) — no constraint beyond type. Pinned.

**Intended shifts:** none in the live machine's decisions — the validator gates restore (quarantine) and logs at commit; it changes no transition. The only user-visible change: a corrupt restore now shows the pinned status string (already specified in `refactor-single-commit-point.md` — this unit folds its `validateRestoredState` into `validateLoopState`, so that spec's Interface is updated to import from `state-validation.ts` instead of `commit.ts` — pinned coordination note).

**Ownership:** `src/state-validation.ts` owns the validator; `commit.ts` + `session-start.ts` own the two call sites. Tests: `test/state-validation.test.ts` (rewritten).

## Inventory

**Files deleted (closed list — 7):** `src/state-types.ts`, `src/state-factory.ts`, `src/state-migration.ts`, `src/transient-flags.ts`, `src/metrics.ts`, `test/state-types.test.ts`, `test/state-factory.test.ts`, `test/state-migration.test.ts`, `test/transient-flags.test.ts`, `test/metrics.test.ts`. (Count: 5 src + 5 test = 10 deletions; `state-validation.ts`/`test/state-validation.test.ts` are rewrites.)

**Files edited (closed list — 5):** `src/state-validation.ts` (rewrite), `src/types.ts` (`skipPhase0`, `LoopMetrics`, `PhaseZeroThresholds`, `DEFAULT_PHASE_ZERO_THRESHOLDS`, `SpecAnalysis.shouldActivatePhase0` removed), `src/commands.ts` (usage strings, `skipPhase0` writer), `src/reviewer.ts` (`shouldActivatePhase0` deleted, `analyzeSpec` simplified), `SPEC.md` + `README.md` (`--skip-review` removed from `/loop` docs).

**Imports after:** `state-validation.ts` imports only `src/types.ts`. `commit.ts` imports `validateLoopState` from it. No module imports a deleted file (grep-provable).

**Name collisions resolved:** `createInitialState` (1 survivor: `commands.ts`), `clearTransientFlags` (1 survivor: `session-start.ts` local), `DisputeState` (1 survivor: the field on flat `LoopState` per `bug-dispute-reload-evaporation.md`), `LoopMetrics` (0 survivors — deleted).

## Test Strategy

- **Baseline:** 32 files / 1017 tests green.
- **Deletions (counted):** 5 test files deleted with their modules — **~520 tests** removed (per-file: `state-types` 13K, `state-factory` 9.6K, `state-migration` 16.9K, `transient-flags` 10.4K, `metrics` 25K of test code; exact test counts re-verified at implementation time — the grep needle is the `describe(` count per file).
- **Rewrite:** `test/state-validation.test.ts` — the 5-rule suite is rewritten against the flat shape and the 5-row decision table above; **0 old tests kept** (every old test asserts the sub-structure shape `state.machine.phase` — not a single assertion transfers). New tests: one per table row (5), one per rejection class (missing field, wrong type, each of the 3 corrected invariants with a *live-reachable* counterexample: `markDone`'s output for row 1, `escalateTo(state,"A")`'s output for row 2, the `index.ts` initial state for row 3 — pinned: the counterexamples are the live builders' actual outputs, proving the validator accepts the machine's real states).
- **New tests:** `test/extension.test.ts` — commit of a broken state persists + debug line (Q1); restore quarantine uses `validateLoopState` (the `refactor-single-commit-point.md` test is re-pointed, not duplicated).
- **Untouched:** all transition/tool/command/gate logic — mechanism: this unit deletes dead code and rewrites a validator with 0 production callers today; the live machine's behavior is bit-identical (the 1017 − ~520 surviving tests must all pass unchanged).

## Scope lines

- `src/state-types.ts`, `src/state-factory.ts`, `src/state-migration.ts`, `src/transient-flags.ts`, `src/metrics.ts`: **deleted**.
- `src/state-validation.ts`: **rewritten** (flat shape, 5-row table, `validateLoopState` export).
- `src/types.ts`: 4 symbols **removed** (`skipPhase0`, `LoopMetrics`, `PhaseZeroThresholds`, `DEFAULT_PHASE_ZERO_THRESHOLDS`) + `SpecAnalysis` field removed.
- `src/commands.ts`, `src/reviewer.ts`: kept + deletions per Inventory.
- `SPEC.md` / `README.md`: `--skip-review` **removed** from `/loop` docs; dispute section untouched (owned by `bug-dispute-reload-evaporation.md`).

## Acceptance Criteria

1. `npm test` green: 32 − 5 = 27 files (5 deleted); surviving live tests (1017 − ~520 deleted) all pass **unchanged**.
2. `npx tsc --noEmit` clean (deletions are the type-checker's proof that nothing referenced the dead modules).
3. Grep sweeps (needles that must reach 0 in `src/` and `test/`): `toSubStructures`, `applySubStructures`, `LoopSubStructures`, `validateState(`, `LoopMetrics` (the dead shape's unique fields: `turnsByPhase`, `finalized`), `PhaseZeroThresholds`, `skipPhase0`, `--skip-review`, `shouldActivatePhase0`.
4. Grep sweep: `validateLoopState` — 1 definition + 2 production call sites (`commit.ts`, `session-start.ts`) + test hits.
5. The three corrected invariants each have a named test using a live-builder output as fixture (row 1: `markDone(makeState({phase:"C"}))`; row 2: the A-escalation state; row 3: the `index.ts` initial state literal) — the validator **accepts** all three (pre-fix validator rejects all three — the tests fail against the old rules, proving the correction).
6. `SPEC.md` grep `--skip-review` → 0 hits.

## Dependencies

- **Ordering note:** this unit is *independent* of the other four specs (it touches no transition/tool/dispute code) and can land any time — **but** it must land **before** `bug-dispute-reload-evaporation.md`'s `DisputeState` field is added to `LoopState` (the validator's shape check must include the new field; landing this first means the dispute spec adds one line to the shape check; landing it later means a second rewrite). Pinned order: this spec before the dispute spec.
- **Coordination:** `refactor-single-commit-point.md`'s `validateRestoredState` (in `commit.ts`) is **folded into** this spec's `validateLoopState` — that spec's Interface is updated (one import change); no double validator.
- **Blocks:** nothing else.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | The 2025-08-18 review (AR-1) listed two validator conflicts (rules 1, 3); a third exists — rule 5 rejects the live initial `idle` state (`turnsThisPhase: 0`) | Accepted — row 3 of the decision table is the pin |
| 2 | needs-doc | `src/metrics.ts` was not flagged in the 2025-08-18 review; it is dead (0 importers) and name-collides with `types.ts:LoopMetrics` — added to this spec's scope as the same divergence class | Accepted — same root cause (the unfinished loop-state-refactor), one cleanup unit |
| 3 | blocker | `--skip-review` is advertised in the usage string but `parseLoopArgs` never parses it — a user who passes it gets a silently-ignored flag (the spec path is still required, so the loop runs with review) | Rejected as a feature to implement — removed from the usage string instead (Phase 0 is a baseline per `reviewer.ts:82-83`); if a user wants skip, that is a new spec with its own Phase 0 analysis |
