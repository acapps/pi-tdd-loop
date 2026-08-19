# refactor-single-commit-point

## Problem

Verified current state as of writing (baseline: `npx tsc --noEmit` clean; `npm test` → 32 files, 1017 tests, 0 failures):

**State is persisted by 14 independent call sites, each with its own opinion about when a commit happens.** Closed inventory of `pi.appendEntry("loop-state", ...)` production sites (grep-proven, 2025-08-18):

| # | Site | What it persists |
|---|---|---|
| 1 | `src/commands.ts:194` (`cmdLoop`) | Phase 0 review entry |
| 2 | `src/commands.ts:259` (`cmdContinue`) | continue/reset |
| 3 | `src/commands.ts:306` (`handlePhaseRestart`) | restart |
| 4 | `src/commands.ts:433` (`cmdCancel`) | idle |
| 5 | `src/commands.ts:460` (`cmdApprove`) | Phase A entry |
| 6 | `src/tools.ts:57` (`applyTransitionEffect`) | negotiate→B (tool path) |
| 7 | `src/events/before-agent.ts:179` (`buildDisputeFixPrompt`) | dispute-fix flag clear |
| 8 | `src/events/agent-settled/review.ts:36` (`handleReviewSettled`) | review settle |
| 9 | `src/events/agent-settled/dispute.ts:102` (`persistState`) | dispute review/defend/writer-fix settles |
| 10 | `src/tools.ts:111` (`logDisputeConcession` — no, that is `loop-dispute`; the `loop-state` sites in tools are: `applyTransitionEffect` (#6), plus `executeNegotiateProposal`/`executeNegotiateFeedback`/`triggerDisputeReview`/`executeBDisputeConcede`/`executeBDisputeDefend`/`executeWriterConcede`/`logEscalation`) | negotiate + dispute tool mutations |

(Count: 14 sites across 5 files; the grep `appendEntry("loop-state"` returns exactly 14 production hits.)

**Consequences (each is a live desync path):**

1. **The gate path never persists.** `handleGateTransition` (`src/events/agent-settled/gate-transition.ts`) applies retry/advance/done/escalated effects — the *most important* transitions in the machine — and writes no `loop-state` entry. A `done` transition is never committed at all: a completed loop restored from disk shows the last *pre-done* snapshot (Phase C, round N) and `session-start.ts` happily resumes a finished loop.
2. **The negotiate settle path never persists** (see `bug-negotiate-settle-not-persisted.md`): after a proposal is delivered, the persisted snapshot still says `negotiateProposed: true, round: N`; the in-memory state says round `N+1`, markers cleared. Reload in that window desyncs the round ping-pong.
3. **`checkLoopEscalation` never persists** (`src/events/agent-settled/index.ts:43-58`): a crash between escalation and the next persist restores the pre-escalation state and the loop re-runs the same 6+ turns.
4. **Restore is trust-based.** `session-start.ts:69-74` does `state.current = entry.data` with zero field validation, then clears a hand-listed transient set (`clearTransientFlags`, lines 41-54). A corrupt or stale entry (crash mid-mutation, older version) is installed verbatim. `before-agent.ts:66` documents this: "session state restored from JSONL is unvalidated."

**Three mutation surfaces write the same mutable object with no protocol:** the settle path (in-place mutation in `checkLoopEscalation`/`handleJustTransitioned` + reassignment in `handlePhaseSettled`), the tool path (20+ direct field writes in `src/tools.ts`), the command path (`src/commands.ts`). There is no single "transition commit" the machine can point at.

## Target

After this refactor: **one function owns persistence — `commit(stateRef, pi)` — and it is called from exactly the transition-commit points**: (a) every place the settle dispatcher reassigns `state.current`, (b) every tool/command handler that mutates phase/round/flags. All 14 ad-hoc `appendEntry("loop-state")` sites are replaced by `commit` calls (same count, one owner). Restore (`session-start.ts`) validates the entry against a field-shape check before installing it; an invalid entry is quarantined (debug + status, state stays idle) instead of installed. `done` and `escalated` states are committed at the moment they are produced.

## Interface

```ts
// src/commit.ts (new module)
export function commit(state: { current: LoopState }, pi: ExtensionAPI): void;
// pi.appendEntry("loop-state", { ...state.current }) — the only production
// writer of loop-state entries.

export function validateRestoredState(data: unknown): data is LoopState;
// field-shape check: phase ∈ Phase (the 8-member union, src/types.ts:1),
// round/turnsThisPhase are numbers, the 14 boolean/optional-boolean flags
// are booleans-or-undefined, language ∈ LanguageKey, buildTool ∈ BuildTool,
// maxA/maxNegotiate/maxB/maxC/maxDispute/maxTurnsPerPhase/coverageThreshold
// are numbers, specPath/lastProposal are strings.
// Returns false (never throws) — the caller quarantines.
```

- `session-start.ts:handleSessionStart` — after `findLastLoopState`, calls `validateRestoredState(entry.data)`. On false: `debug("session_start: restored entry failed validation — quarantining")`, `ctx.ui.setStatus("loop", "state corrupted — run /loop to restart")`, and `state.current` is left as the initial idle state (pinned: no partial install). On true: current behavior (install + `clearTransientFlags`).
- **No schema version field is added** — the validator is shape-only, matching the existing optional-field migration precedent (`negotiateProposed?`/`negotiateFeedback?` were added as optionals without a version bump, `src/types.ts:32-33`). A version field is a larger change with its own migration story; not this unit.

## Behavior

Commit-point table (closed list — every row is a current mutation site that will call `commit`):

| # | Commit point | Trigger | Replaces (current site) |
|---|---|---|---|
| 1 | `agent-settled/index.ts:handleAgentSettled` — after `state.current = result.newState` (negotiate) | negotiate settle | none (was missing — this is the fix) |
| 2 | `agent-settled/index.ts:handlePhaseSettled` — after `state.current = gate.state` | gate settle (retry/advance/done/escalated) | none (was missing) |
| 3 | `agent-settled/index.ts:checkLoopEscalation` — after setting `phase: "escalated"` | loop-detector escalation | none (was missing) |
| 4 | `agent-settled/dispute.ts` — `handleDisputeReview` / `handleDisputeDefend` / `handleWriterConcedeFix` | dispute settles | site 9 (3 `persistState` calls → 3 `commit` calls) |
| 5 | `agent-settled/review.ts:handleReviewSettled` | Phase 0 settle | site 8 |
| 6 | `before-agent.ts:buildDisputeFixPrompt` — after clearing `awaitDisputeFix` | dispute-fix prompt build | site 7 |
| 7 | `tools.ts` — `applyTransitionEffect` (negotiate→B), `executeNegotiateProposal`, `executeNegotiateFeedback`, `triggerDisputeReview`, `executeBDisputeConcede`, `executeBDisputeDefend`, `executeWriterConcede`, `logEscalation` | tool mutations | site 6 + the 7 `loop-state` sites in tools.ts |
| 8 | `commands.ts` — `cmdLoop`, `cmdContinue`, `handlePhaseRestart`, `cmdCancel`, `cmdApprove` | command mutations | sites 1-5 |

**Ordering pin (per commit point):** mutate → `commit` → `sendUserMessage` (where both apply). Current code is mixed: `commands.ts` sites persist *before* `sendUserMessage` (kept), `dispute.ts` persists *after* the send (flipped to before — intended shift S1, justified below). This order makes a crash between commit and send recoverable (re-send on next settle; the pending marker is still set), whereas a crash between send and commit re-delivers (the current, worse failure).

**Verbatim pins (new user-visible strings):**
- quarantine status: `state corrupted — run /loop to restart`
- quarantine debug: `session_start: restored entry failed validation — quarantining`

**Side-effect contract:** `commit` is the *only* production caller of `pi.appendEntry("loop-state", ...)`. `loop-debug`, `loop-refusal`, `loop-negotiate`, `loop-dispute` entries are untouched (they are logs, not commits).

**Quirks list (odd-but-current, do not fix in this unit):**
- Q1: `tools.ts` persists in `logEscalation` (dispute-limit escalation) but `checkLoopEscalation` (turn-limit escalation) does not — after this unit both commit; the asymmetry is removed *as a side effect of the commit-point table*, pinned as intended shift S2, not a quirk.
- Q2: `handleDisputeFix` (`dispute.ts:27-40`) persists nothing even though it delivers the fix-turn prompt — it does not mutate state (the flag was cleared in `before-agent.ts`), so it has no commit point. Pinned: no commit added.
- Q3: `review.ts` persists on *every* review settle (repeated identical entries accumulate in the session log) — kept as-is; deduplication is a log-hygiene concern, out of scope.

**Intended shifts:**
- S1: dispute settles persist *before* the prompt send (was after). Before: crash → prompt delivered, flag not cleared → re-delivery on next settle. After: crash → flag still set, next settle re-delivers once, then commits. Double-delivery window shrinks from "always" to "crash-in-one-statement."
- S2: turn-limit escalation (`checkLoopEscalation`) now commits. Before: crash → escalation lost, loop re-runs. After: crash → restored escalated state, user sees the escalation.

**Ownership:** `src/commit.ts` owns persistence + validation; `session-start.ts` owns the quarantine branch; each handler owns *when* it commits (the table above). Tests: `test/commit.test.ts` (new — `commit` + `validateRestoredState`), `test/events/session-start.test.ts` (quarantine branch), `test/extension.test.ts` (commit-call counts at the new sites).

## Inventory

**Files touched (closed list — 8):**
1. `src/commit.ts` — **new**: `commit`, `validateRestoredState`.
2. `src/events/session-start.ts` — validation + quarantine branch; `clearTransientFlags` unchanged.
3. `src/events/agent-settled/index.ts` — `commit` after the two reassignments + in `checkLoopEscalation`.
4. `src/events/agent-settled/dispute.ts` — `persistState` helper deleted (caller-count: 3, all in this file), 3 `commit` calls.
5. `src/events/agent-settled/review.ts` — 1 `commit` call.
6. `src/events/before-agent.ts` — 1 `commit` call (replaces the inline `appendEntry`).
7. `src/tools.ts` — 8 `commit` calls; the local `persistState` helper (line 56-58) deleted.
8. `src/commands.ts` — 5 `commit` calls.

**Imports:** `commit` imported in 6 files (3,4,5,6,7,8 above); `validateRestoredState` imported in 1 (`session-start.ts`). No other import changes.

**`appendEntry("loop-state", ...)` sites after:** exactly 1 — inside `src/commit.ts`. (Grep-provable acceptance criterion.)

## Test Strategy

- **Baseline:** 32 files / 1017 tests green.
- **Flips (counted):** `test/extension.test.ts` asserts on `appendEntry` call sequences (grep: 12 assertions matching `appendEntry, expect`).call("loop-state"`). These keep passing: `commit` calls the same `pi.appendEntry` with the same payload. **0 assertion flips** — the mock sees identical calls. `test/events/session-start.test.ts` — 1 flip: the "restored stale entry" test (line ~1009, fixture includes `justTransitioned: false`) now also exercises validation; its fixture is a valid shape, so it passes unchanged; **1 new test** added (invalid shape → quarantine).
- **New tests:**
  - `test/commit.test.ts`: `commit` calls `appendEntry("loop-state", snapshot)` with a *copy* (mutating `state.current` after commit does not affect the entry — pinned); `validateRestoredState` accepts the initial state from `index.ts`, rejects each of: missing `phase`, `phase: "B "`, `round: "1"`, `language: "rust"`, `null`, `undefined` (one test per rejection class, 6 tests).
  - `test/events/session-start.test.ts`: corrupt entry → state stays at initial idle, status string pinned, debug string pinned.
  - `test/extension.test.ts`: after a `done` effect, a `loop-state` entry with `phase: "done"` exists (regression: the never-persisted done).
- **Untouched:** all transition/tool/command *logic* — this unit moves persistence, changes no decision. Mechanism: `commit` is a verbatim rename of the existing `appendEntry` call; the flip-count above proves no assertion changes.

## Scope lines

- `src/commit.ts`: **added**.
- `src/events/agent-settled/dispute.ts`: `persistState` **removed**; kept otherwise.
- `src/tools.ts`: local `persistState` **removed**; kept otherwise.
- All other touched files: kept + `commit` calls.
- `README.md` / `SPEC.md`: no change (no user-visible behavior change; the quarantine status string is the only new UI text, documented in the `session_start` section of SPEC.md — one line).

## Acceptance Criteria

1. `npm test` green, 32 files; the new `done`-is-persisted regression test fails pre-fix, passes post-fix.
2. `npx tsc --noEmit` clean.
3. Grep sweep: needle `appendEntry("loop-state"` — exactly **1** hit in `src/` (inside `commit.ts`); was 14.
4. Grep sweep: needle `persistState(` — 0 hits in `src/` (was 2 definitions + 11 calls).
5. Grep sweep: needle `validateRestoredState` — 1 definition + 1 production call + ≥ 6 test hits.
6. Restore quarantine: a session whose last `loop-state` entry has `phase: "B "` restores to idle with the pinned status string (named test in `test/events/session-start.test.ts`).

## Dependencies

- **Must land after** `bug-gate-signal-integrity.md` (the async gate changes the settle dispatcher's structure; adding commit calls to a moving dispatcher is two reviews in one).
- **Unblocks** `bug-negotiate-settle-not-persisted.md` (commit point #1 *is* that fix — the negotiate spec becomes a verification spec once this lands) and `bug-dispute-reload-evaporation.md` (a committed dispute state survives reload only if commits exist).
- Independent of `refactor-state-model-divergence.md` (the validator here is shape-only and lives in `commit.ts`; it does not adopt `state-validation.ts` rules).

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | The review of 2025-08-18 cited "14 call sites"; the closed inventory above resolves it to 14 `loop-state` sites across 5 files, but 3 of the tools.ts sites were initially miscounted as one — the inventory table is the corrected count | Accepted — table is the pin |
| 2 | blocker | `bug-gate-signal-integrity.md` and this unit both edit `src/events/agent-settled/index.ts` (dispatcher) | Rejected as a conflict — different lines (gate await vs commit calls); ordering (gate first) makes the overlap textual-only, resolved by re-verification at implementation time |
