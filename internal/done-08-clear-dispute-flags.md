# clear-dispute-flags

## Problem

Verified current state as of writing:

- Two transient dispute flags exist on `LoopState`: `awaitDisputeFix` and `awaitDisputeReview` (`src/types.ts:27-28`). Both are set only by tools: `triggerDisputeReview` sets `awaitDisputeReview = true` (`src/tools.ts:168`); `executeBDisputeConcede` sets `awaitDisputeFix = true` (`src/tools.ts:298`).
- The only live clearing paths today:
  - `applyRetryEffect` clears `awaitDisputeReview` — **gate-fail (retry) path only** (`src/events/agent-settled/effect-applicator.ts:86-88`).
  - `buildDisputeFixPrompt` clears `awaitDisputeFix` — at the *next turn's* prompt build (`src/events/before-agent.ts:178`).
  - `clearTransientFlags` clears both — **new session only** (`src/events/session-start.ts:45-46`).
  - `resetPhaseState` clears `awaitDisputeFix` **but not `awaitDisputeReview`** (`src/commands.ts:79`; the function is at `:71-81`).
- No clearing happens at any phase boundary. Every state builder that changes `phase` spreads `...state` without touching the flags: `advanceToNegotiate` (`src/transitions.ts:219-225`), `advanceToPhaseB` (`:228-237`), `advanceToPhaseC` (`:239-247`, clears only `disputeMode`), `escalateTo` (`:249-256`), `markDone` (`:258-260`). The direct-mutation sites (tool path and dispatcher) also never clear: `executeNegotiateAgree` (`src/tools.ts:127-150`, phase set at `:134`), `executeNegotiateApprove` (`src/tools.ts:253-276`, phase set at `:260`), `logEscalation` (`src/tools.ts:369-378`, phase set at `:374`), `checkLoopEscalation` (`src/events/agent-settled/index.ts:40-55`, phase set at `:51`), and the `/loop-cancel` handler (`src/commands.ts:424`).
- The handler's design comment names the broken invariant: "only the retry effect clears it" (`src/events/agent-settled/dispute.ts:48`). That assumes the gate **fails** after a dispute is filed. A gate **pass** with a pending review is a normal, expected outcome (the dispute was fixed and the suite is green) — and it leaks the flag into the next phase.
- Runtime evidence (session `01a00dba-1766-7742-9327-f4a6cd3d225a`, 2026-08-17; artifact: the session JSONL): at 06:31:12 the Tester filed dispute #2, setting `awaitDisputeReview = true`; at 06:32:20 the gate **passed** and the transition advanced to Phase C, carrying the flag; at 06:44:56 the Cleaner's `read` and `bash` calls were both blocked (`Blocked: <tool> (awaiting dispute review)`, `src/events/tool-call.ts:67-73`); at 06:46:35 the gate passed again and the loop ended in `done`. The final persisted `loop-state` entry (session line 218) shows `phase: "C", awaitDisputeReview: true`. Phase C performed zero work and the saved state is poisoned.

Gap: there is no path that clears the dispute flags at a phase boundary, so a passed gate (or a command, or an escalation) can carry a live flag into a phase where it blocks every tool call and nothing in that phase can clear it.

## Target

No dispute flag survives a phase boundary. Every state builder that changes `phase` and every command/dispatcher site that mutates `phase` directly sets `awaitDisputeFix: false` and `awaitDisputeReview: false`. Intra-phase behavior is unchanged: tools still set the flags mid-turn, the retry effect still clears `awaitDisputeReview` on gate-fail, `before-agent` still clears `awaitDisputeFix` at prompt build, and session start still clears both.

## Interface

No signature changes. No new fields.

Persisted state: the saved `loop-state` shape is unchanged; the restore path (`clearTransientFlags`, `src/events/session-start.ts:39-47`) already clears both flags, so pre-change saved entries remain valid and are healed on restore exactly as today. No migration needed.

## Behavior

Decision table — the closed list of phase-boundary sites, each gains explicit clears (first-match-wins is N/A; this is a per-site additive contract):

| # | Site (as of writing) | Change |
|---|---|---|
| 1 | `advanceToNegotiate` — `src/transitions.ts:219-225` | + `awaitDisputeFix: false, awaitDisputeReview: false` in the object literal |
| 2 | `advanceToPhaseB` — `src/transitions.ts:228-237` | + both clears in the object literal |
| 3 | `advanceToPhaseC` — `src/transitions.ts:239-247` | + both clears beside the existing `disputeMode: false` |
| 4 | `escalateTo` — `src/transitions.ts:249-256` | + both clears in the object literal |
| 5 | `markDone` — `src/transitions.ts:258-260` | + both clears in the object literal |
| 6 | `executeNegotiateAgree` — `src/tools.ts:127-150` | + `state.current.awaitDisputeFix = false; state.current.awaitDisputeReview = false;` immediately after the `phase = "B"` assignment (`:134`) |
| 7 | `executeNegotiateApprove` — `src/tools.ts:253-276` | same, after `:260` |
| 8 | `logEscalation` — `src/tools.ts:369-378` | same, after `:374` (before the existing `appendEntry`/`notify`/`setStatus` — order: phase → clears → entry → notify → status) |
| 9 | `checkLoopEscalation` — `src/events/agent-settled/index.ts:40-55` | same, after `:51` |
| 10 | `/loop-cancel` handler — `src/commands.ts:424` | + both clears after the `phase = "idle"` assignment (before the existing `round = 0` / `disputeMode = false` lines — order: phase → clears → round → disputeMode, matching the handler's existing mutation order) |
| 11 | `resetPhaseState` — `src/commands.ts:71-81` | + `state.awaitDisputeReview = false;` only — `awaitDisputeFix` is already cleared at `:79`. Covers both callers: the `/loop-continue` handler (`:255`) and the `/loop-restart` helper (`:300`) |

Closed-list proof: `rg -n '\.phase = |phase: "' src/` (verified as of writing) returns: the five builders (`src/transitions.ts:222`, `:231`, `:242`, `:252`, `:259`); the three tools.ts mutations (`:134`, `:260`, `:374`); the one index.ts mutation (`src/events/agent-settled/index.ts:51`); and six commands.ts sites — `createInitialState` (`:98`, fresh state, both flags already initialized false at `:119-120` — no change), `cmdLoop` Phase-0 start (`:183`, fresh state from `createInitialState` at `:177` — no change), `/loop-continue` resume-from-escalated (`:252`, immediately followed by `resetPhaseState` at `:255` — covered by site 11), `/loop-restart` helper (`:299`, immediately followed by `resetPhaseState` at `:300` — covered by site 11), the `/loop-cancel` handler (`:424` — site 10), and `/loop-approve` (`:449`, provably safe: no tool sets the flags in Phase `review` and session restore clears them — no change, documented exclusion). Excluded non-state matches: effect-payload objects (`src/transitions.ts:80`, `src/tools.ts:144`, `:270`) and `loop-refusal` entry data (`src/events/tool-call.ts:81`, `:90`, `:101`). Also excluded: `src/state-factory.ts:37` and `src/state-migration.ts:85` — orphaned nested-shape modules with zero live importers (verified: `rg -n "state-factory|state-migration" src/ index.ts` outside the two files → 0). Scope note (reviewer F4): that grep covers `src/` only; the one remaining phase site outside it is the top-level `index.ts` fresh-state literal (`index.ts:18-42`: `phase: "idle"` at `:19`, flags already false at `:40-41`) — no change. That is the complete set of phase-mutation sites.

Verbatim pins: no new user-visible strings. The only new code is the six clear assignments (five sites get two, site 10 gets one).

Side-effect contract: state mutation only. No UI calls, no messages, no entries are added or changed by this spec.

Quirks (current behavior, do not fix):
1. `applyRetryEffect`'s dispute branch (`src/events/agent-settled/effect-applicator.ts:86-91`) remains reachable and untouched — a dispute filed mid-turn whose gate then fails still takes the retry path. (Spec 09 later makes the flag impossible at gate time and removes that branch; that is 09's unit, not this one.)
2. `advanceToPhaseC` already special-cases `disputeMode` without touching the flags (`src/transitions.ts:245`); this spec follows that precedent (add fields, no refactor).
3. The escalated phase is rule-1-relaxed (`src/events/tool-call.ts:126`), so a leaked flag is *harmless* there today; sites 4, 8, 9 are cleared for invariant completeness, not because a symptom exists.

Intended shifts: none observable. The only diff is the flag values in states at/after a boundary — which is the whole point of the spec.

Ownership: the five builders are owned by `src/transitions.ts` (asserted in `test/transitions.test.ts`); the three tools.ts sites by `src/tools.ts` (asserted in `test/extension.test.ts`); `checkLoopEscalation` by `src/events/agent-settled/index.ts` (asserted in `test/events/agent-settled/index.test.ts`); `resetPhaseState` by `src/commands.ts` (asserted via the `/loop-restart` tests in `test/extension.test.ts`).

## Inventory

- Files (closed — 4): `src/transitions.ts` (5 builders, no additions/removals of symbols), `src/tools.ts` (3 functions), `src/events/agent-settled/index.ts` (1 function), `src/commands.ts` (1 function).
- Imports: zero import lines added, rewritten, or removed in any touched file.
- Call sites (builder callers, counted as of writing): `advanceToNegotiate` — 1 (`computeTransition` `src/transitions.ts:33`); `advanceToPhaseB` — 1 (`autoAdvanceToPhaseB` `:77`); `advanceToPhaseC` — 2 (`handleDisputeFixIncomplete` `:173`, `handlePhaseBTransition` `:192`); `markDone` — 2 (`handlePhaseCTransition` `:206`, `:210`); `escalateTo` — 4 (`:62` negotiate branch, `:138` Phase A, `:182`, `:188` Phase B); `resetPhaseState` — 2 (`src/commands.ts:255`, `:300`).
- Exports: none added or changed.

## Test Strategy

- Baseline (as of writing): `npm test` → 979/979 passing across 32 files (the fixture blocker discovered during drafting was resolved with user GO before this review — see Dependencies; the fixture fix is already in the tree, applied separately, and is **not** part of this unit's diff). `npx tsc --noEmit` clean.
- Per-test disposition: **1 rewritten, 0 removed.**
  - **Rewritten (1):** `test/events/agent-settled/index.test.ts:275-288` — old name `"flag true + gate all-pass → gate runs, snapshot persisted, FLAG INTACT (spot assert), applied returned"`. The old assertion `expect(input.state.current.awaitDisputeReview).toBe(true)` (`:285`, comment "flag intact — advance doesn't clear it") pins the exact leak this spec removes. New: same scenario (Phase B, `disputeMode: true`, `awaitDisputeReview: true`, all-gates-passing → advance to C); the assertion flips to `expect(input.state.current.awaitDisputeReview).toBe(false)` — the flag is cleared at the B→C boundary by `advanceToPhaseC`. All other assertions in the test (applied, gate called once, snapshot entry appended, `phase: "C"`, `lastGateResult` set) are unchanged; the name is updated to drop "FLAG INTACT".
  - **Closed evidence (actual outputs, re-verified after review):**
    - `rg -n "awaitDisputeReview: true|awaitDisputeReview = true" test/` → 20 lines / 12 files, all input fixtures or intra-phase assertions — kept: `test/state-migration.test.ts:88,357` (migration fixtures — orphan nested-shape module), `test/events/agent-settled/effect-applicator.test.ts:310,346,383,483` (retry/escalation fixtures — retry branch untouched by this spec), `test/events/agent-settled/gate-transition.test.ts:268` (retry fixture — asserts the flag becomes false via the retry effect — untouched), `test/events/agent-settled/dispute.test.ts:137,154` (settle-handler fixtures — intra-phase), `test/events/tool-call.test.ts:171` (rule-2 block fixture — intra-phase), `test/events/session-start-wiring.test.ts:189` (restore path — untouched), `test/events/agent-settled/index.test.ts:261,276,291` (settle-dispatcher fixtures; `:276` belongs to the rewrite above — its flag *assertion* is the one that flips, its fixture stays), `test/events/tool-call-enforcement.test.ts:107,123,135,144,152,482` (rule-2 block fixtures — intra-phase, no boundary crossed).
    - `rg -n "awaitDisputeFix: true|awaitDisputeFix = true" test/` → 13 lines / 8 files, all kept: `test/state-migration.test.ts:87,356`, `test/events/before-agent.test.ts:197,202,216,303,346` (prompt-build fixtures — the before-agent clear is untouched), `test/events/session-start-wiring.test.ts:188`, `test/events/agent-settled/index.test.ts:240,261`, `test/events/agent-settled/dispute.test.ts:91,107,115` (settle fixtures — intra-phase).
    - Assertion sweep `rg -n "awaitDisputeReview.*toBe\(true\)|awaitDisputeFix.*toBe\(true\)" test/` → 10 hits: `test/state-migration.test.ts:236,237,366,367` (migration preserves flags — not a boundary), `test/events/agent-settled/dispute.test.ts:102,149` (settle handlers intentionally do not clear — intra-phase; `:149` comments "flag-preservation invariant"), `test/events/agent-settled/index.test.ts:248` (fix prompt sent, flag waits for the next turn's `before-agent` clear — intra-phase), `test/extension.test.ts:726` (dispute tool sets the flag — no boundary crossed), `test/extension.test.ts:839` (concede path sets `awaitDisputeFix` — no boundary crossed), and **`test/events/agent-settled/index.test.ts:285` — the single flip** (the rewrite above).
  - That is the complete set of dispute-flag references in the test tree: 1 flip, 0 removals.
- New tests (12: one per site plus the regression):
  1-5. `test/transitions.test.ts` — one per builder: state with both flags `true` entering the builder → both `false` after, `phase` correct. (5)
  6-7. `test/extension.test.ts` — `negotiate_propose` "agree" / `negotiate_review` approve in Phase negotiate with both flags `true` → the last `loop-state` entry shows both cleared and `phase: "B"`. (2)
  8. `test/extension.test.ts` — site 8 via its live caller: `negotiate_propose` in Phase B with `disputeCount: maxDispute - 1` and both flags `true` → `handleBDisputePropose` increments to `maxDispute` → `logEscalation` → `phase: "escalated"`, both flags cleared, a `loop-state` entry appended (assert on the last entry's `phase`/flags), `notify` called with the pinned escalation text `"Dispute limit reached. Escalating to human."` (`src/tools.ts:376`). (1)
  9. `test/events/agent-settled/index.test.ts` — `checkLoopEscalation` over `maxTurnsPerPhase` with both flags `true` → `phase: "escalated"`, both cleared. (1)
  10. `test/extension.test.ts` — `/loop-restart B` with both flags `true` (via the tool-dispute state) → `resetPhaseState` leaves `awaitDisputeReview: false` (the field this site currently misses). (1)
  11. `test/extension.test.ts` — `/loop-cancel` with both flags `true` → `phase: "idle"`, both cleared. (1)
  12. `test/events/agent-settled/gate-transition.test.ts` — regression of session 01a00dba's tail: Phase B, `disputeMode: true`, `awaitDisputeReview: true`, passing gate → returned state is Phase C with `awaitDisputeReview: false`, and `handleToolCall` on that state does not block (rule 2 off). (1)
- Untouched: all other test files — the mechanism that makes "all others kept" true: the change is additive field initializers and assignments inside boundary sites; no assertion in any other file reads a dispute flag at or after a boundary (closed list above).

## Scope lines

- `src/transitions.ts`: 5 object literals each gain 1-2 field initializers; nothing else changed.
- `src/tools.ts`: 3 functions each gain 2 assignment lines; nothing else changed.
- `src/events/agent-settled/index.ts`: `checkLoopEscalation` gains 2 assignment lines; nothing else changed.
- `src/commands.ts`: `resetPhaseState` gains 1 assignment line; the `/loop-cancel` handler gains 2; nothing else changed.

## Acceptance Criteria

1. `npm test` (vitest run) → all 32 files green, 991 tests (979 baseline + 12 new), 0 failures. Checker: `vitest run`.
2. `npx tsc --noEmit` → exit 0 (`vitest run` does not type-check; `package.json:21` is `vitest run` only). Checker: tsc.
3. Boundary-clear sweep: `rg -c "awaitDisputeReview: false" src/transitions.ts` → 5; `rg -c "awaitDisputeReview = false" src/tools.ts` → 3; `rg -c "awaitDisputeReview = false" src/commands.ts` → 2 (resetPhaseState + /loop-cancel); `rg -c "awaitDisputeReview = false" src/events/agent-settled/index.ts` → 1. (Pre-change: 0/0/0/0 in those files — the only existing `= false` is session-start.ts.) Checker: ripgrep.
4. Session-replay regression: the new gate-transition test (item 12) passes — flag does not survive a passing gate in Phase B. Checker: vitest.
5. Every site in the Behavior table is covered by exactly one named new test — sites 1-11 ↔ items 1-11 (item 8 covers site 8 via `negotiate_propose`'s Phase-B dispute-escalation path); item 12 is the session-replay regression, not a site. Checker: vitest test names.

## Dependencies

- None upstream.
- **Pipeline blocker (separate, test-only) — RESOLVED with user GO (2026-08-16):** the suite was red — 8/979 — because the `/loop` tests' Go fixture is created by `setupSpecFiles()` (`test/extension.test.ts:49-57`), which wrote only the two `spec.md` files; the Go project files the baseline check needs (`go test -json ./...`, `src/baseline.ts:102`, run in the mock cwd `/tmp/test-project`, `test/extension.test.ts:32`) were *assumed to pre-exist* in a mutable OS temp dir and had been lost, so the baseline exited non-zero (`setup failed`) and the Phase 0 gate (`src/commands.ts:158-168`) refused to start. Applied fix: `setupSpecFiles()` now idempotently writes `main.go`, `main_test.go` (a trivially-passing test), and `go.mod` (`module testproject\n\ngo 1.22\n`) alongside the spec files — the helper every `/loop`-family `beforeEach` already calls. Verified: full suite 979/979 (32 files) after the fix. Known hazard (noted, not addressed in this unit): the fixture dir is shared and mutable across parallel test files — one full-suite run showed a transient single failure that passed on re-run and on isolated file runs.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | First draft counted 9 boundary sites and claimed `resetPhaseState` cleared nothing; verification showed it already clears `awaitDisputeFix` (`src/commands.ts:79`) and misses only `awaitDisputeReview` — site 10 is a 1-line addition, not 2 | **Accepted, fixed.** Author verification miss logged per class K. |
| 2 | blocker | The suite is red (8/979) for a fixture reason unrelated to this spec — discovered while capturing the baseline; root cause: `setupSpecFiles()` wrote only the `spec.md` files while the Go project files the `/loop` baseline check runs were assumed to pre-exist in the mutable `/tmp/test-project` dir and had been lost | **GO obtained, fixed, verified.** `setupSpecFiles()` (`test/extension.test.ts:49-57`) now writes `main.go`, `main_test.go`, `go.mod` idempotently; suite 979/979. Kept out of this spec's unit (test-only, orthogonal). |
| 3 | needs-doc | First draft typed boundary-site lines and caller counts from memory; the post-draft grep pass found them stale — including a missed 11th boundary site (the `/loop-cancel` handler, `src/commands.ts:424`), an overcount of `escalateTo` callers (claimed 7, actually 4: `:62, :138, :182, :188`), and 5 further `phase` assignments the first closed list never classified (fresh-state sites, effect payloads, orphaned modules) | **Accepted, all corrected in the Behavior table and closed-list proof.** Class A + C: numbers typed from memory rot, and the first closed list wasn't closed. |
| 4 | blocker | **Reviewer F1:** the "0 rewritten" claim missed `test/events/agent-settled/index.test.ts:275` — its spot assert (`:285`, "flag intact — advance doesn't clear it") pins the exact leak this spec removes; the spec's closed-evidence block was stale (documented 4 hits; the literal grep actually returns 20 lines / 12 files) and its literal pattern could not catch the `.toBe(true)` assertion form | **Accepted.** Listed as the single rewrite (assertion flips true→false); closed evidence re-issued with the actual output of all three greps plus the assertion-style sweep (10 hits: 9 kept, 1 flip). Meta: the spec-07 criterion-4 lesson recurred — closed lists must close at the leaf, in both literal *and* assertion form. |
| 5 | moderate | **Reviewer F2:** AC1's "979 + 10" contradicted the 11 enumerated new tests, and site 8 (`logEscalation`) had no dedicated test despite AC5's 1:1 claim | **Accepted.** Dedicated site-8 test added (`negotiate_propose` in Phase B at `disputeCount: maxDispute - 1` → escalation path); 12 new tests; AC1 → 991; AC5 mapping made explicit (sites 1-11 ↔ items 1-11, item 12 = regression). |
| 6 | minor | **Reviewer F3:** Test Strategy baseline ("971/979, red until the fixture fix lands") contradicted Dependencies ("resolved, 979/979"); fixture-fix ownership was implicit | **Accepted.** Baseline updated to 979/979; the fixture fix is documented as already in the tree (applied with user GO) and explicitly **not** part of this unit's diff. |
| 7 | nit | **Reviewer F4:** the closed-list proof grep covered `src/` only; the top-level `index.ts` fresh-state init (`:19`, flags at `:40-41`) was unclassified | **Accepted.** Added as an excluded fresh-state site in the closed-list proof, with the scope note. |
| 8 | needs-doc | The review prompt's auto-generated portion contained a "Finding 1" that is a parser artifact (prose tokenized as a "directory conflict"); the reviewer dismissed it | **No action** — recorded per the spec-07 precedent (extractor artifact, not a finding). |
| 9 | out-of-scope | Reviewer flagged: `logEscalation` never sets `lastPhase` (pre-existing; affects the resume-from-escalated path, not the flags) | **Acknowledged, deferred.** Different verb-object (`lastPhase` bookkeeping, not flag clearing); candidate for its own spec — not folded into this unit. |
| 10 | info | Reviewer independently verified against the live tree: all 11 boundary sites, the closed list, caller counts, the flag writer/clearer inventory, the `/loop-approve` exclusion, the orphan-module status, AC3's pre-change counts, and the runtime-evidence scenario — no discrepancies beyond F1-F4 | **Recorded.** |
