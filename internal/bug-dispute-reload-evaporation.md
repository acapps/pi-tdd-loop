# bug-dispute-reload-evaporation

## Problem

Verified current state as of writing (baseline: `npx tsc --noEmit` clean; `npm test` → 32 files, 1017 tests, 0 failures):

**A pending dispute evaporates on session reload, and its budget is consumed anyway.**

Filing a dispute (`src/tools.ts:handleBDisputePropose`, lines 222-236):
1. `state.current.disputeCount++` (line 224) — budget consumed.
2. `triggerDisputeReview` sets `awaitDisputeReview = true` and persists (lines 242-248).

Reload in that window (`session-start.ts:41-54`, `clearTransientFlags`):
```ts
s.disputeMode = false;
...
s.awaitDisputeReview = false;
s.disputeFiler = undefined;
```
Both dispute flags are cleared *simultaneously*. The restored machine has: `disputeMode: false`, `awaitDisputeReview: false`, `disputeDefended: undefined`, `disputeFiler: undefined` — but `disputeCount` is **not** in the cleared set, so it survives. The dispute no longer exists anywhere in the machine, yet the budget it consumed does. Three disputes filed across three reloads → `disputeCount >= maxDispute` (3) → escalation on the fourth filing (`src/tools.ts:226-228`), even though the first three were lost and never reviewed.

**Second window — the fix leg:** `executeBDisputeConcede` (`src/tools.ts:368-375`) sets `disputeMode = true; awaitDisputeFix = true` and persists. Reload → `clearTransientFlags` clears *both* (`session-start.ts:42,48`). The conceding Tester's fix turn is never scheduled: `handleDisputeFix` (`src/events/agent-settled/dispute.ts:27`) gates on `awaitDisputeFix`, which is false. The dispute is silently closed with the wrong test still in place — and the Phase B gate will keep failing on it, burning Writer retries until `maxB` escalation.

**Third window — the review leg:** `handleDisputeReview` (`src/events/agent-settled/dispute.ts:49-68`) clears `awaitDisputeReview` at scheduling and persists (line 58) — this leg *is* crash-safe by construction (clear-at-schedule). The asymmetry is the problem: one leg of the dispute flow is commit-safe, the other two are not.

**Root cause:** the dispute is tracked as a *pair of boolean flags* (`awaitDisputeReview`, `awaitDisputeFix`) plus two optional payloads (`disputeDefended`, `disputeFiler`) with no status field. `clearTransientFlags` cannot distinguish "transient interaction state" from "pending obligation" because the machine has no field that says *what is pending*.

## Target

After this fix: a dispute is a first-class state object with an explicit status lifecycle. A reload never destroys a pending dispute: `filed`/`in-review` disputes survive restore and are redelivered on the next settle; `conceded` disputes survive as a pending fix obligation; the dispute budget (`disputeCount`) is consumed at *resolution*, not at filing. `clearTransientFlags` shrinks to genuinely session-scoped flags.

## Interface

```ts
// src/types.ts — LoopState gains (additive; old fields retired per Scope):
dispute: DisputeState;

export interface DisputeState {
  status: "none" | "filed" | "in-review" | "conceded" | "defended" | "closed";
  filer?: "writer" | "tester";      // set at filing (was: re-derived from disputeMode)
  claim?: string;                    // the proposal text that filed it (was: lastProposal, shared)
  decision?: string;                 // the review decision (was: disputeDefended)
  filedRound?: number;               // round at filing — for the redelivery prompt
}
```

**Retired fields (removed from `LoopState`, `src/types.ts`):** `disputeMode`, `awaitDisputeFix`, `awaitDisputeReview`, `disputeDefended`, `awaitWriterConcedeFix`, `disputeFiler`. Closed inventory of their production sites (grep-proven): `disputeMode` — 14 sites; `awaitDisputeFix` — 9; `awaitDisputeReview` — 11; `disputeDefended` — 4; `awaitWriterConcedeFix` — 3; `disputeFiler` — 4. (Exact counts re-verified at implementation time; the grep needles are the acceptance criterion.)

**Compatibility (pinned — persisted state):** pre-fix `loop-state` entries carry the old fields and no `dispute` object. `session-start.ts` gains a one-directional migration: if `entry.data.dispute` is absent, synthesize it from the old flags (`disputeMode && awaitDisputeReview → "in-review"`, `disputeMode && awaitDisputeFix → "conceded"`, `disputeMode → "filed"`, else `"none"`) and drop the old fields. Precedent: the optional-field additions `negotiateProposed?`/`negotiateFeedback?` (`src/types.ts:32-33`) — additive-with-migration, no version bump. Post-migration entries are the new shape; `validateRestoredState` (from `refactor-single-commit-point.md`) checks `dispute.status ∈` the 6-member union.

**Budget semantics change (pinned):** `disputeCount` increments at *resolution* — the concede/defend review decision (`handleBDisputeReview`) — not at filing. The escalation check moves from `handleBDisputePropose` (filing) to `handleBDisputeReview` (resolution): `disputeCount >= maxDispute` after a resolution → escalate. Before: a *filed but never resolved* dispute consumed budget forever. After: only resolved disputes count. (Intended shift S1 — the review of 2025-08-18 flagged the budget-at-filing as part of the evaporation bug; this is the fix, not a quirk.)

## Behavior

Dispute lifecycle table (status transitions; first match wins; "settle" = `agent_settled`):

| # | From | Event | To | Side effects (order pinned) |
|---|---|---|---|---|
| 1 | none | Writer `negotiate_propose` in Phase B (dispute claim) | filed | `filer: "writer"`, `claim: plan`, `filedRound: round`; persist; return the existing pinned refusal text |
| 2 | none | Tester `negotiate_propose` in Phase B (dispute claim) | filed | `filer: "tester"`, same shape |
| 3 | filed | settle | in-review | deliver review prompt to the *other* agent (existing `handleDisputeReview` prompts, verbatim); clear-at-schedule: status set **before** the send, persist **before** the send (S2) |
| 4 | in-review | reviewer `negotiate_review` approve (concede) | conceded (writer filed → Tester fixes) / defended-fix (tester filed → Writer fixes) | `decision: "concede"`; `disputeCount++`; if `disputeCount >= maxDispute` → phase `escalated` (persist, pinned notify); else schedule the fix turn on next settle |
| 5 | conceded | settle | closed | deliver `promptTesterDisputeFix()` (existing, verbatim); status → closed |
| 6 | in-review | reviewer `negotiate_review` feedback (defend) | defended | `decision: text`; `disputeCount++`; escalation check as row 4; deliver the defend-decision prompt on next settle (existing `handleDisputeDefend` prompts, verbatim) |
| 7 | defended | settle | closed | deliver decision prompt; status → closed |
| 8 | any | Phase C advance / escalate / cancel | closed (or none) | `advanceToPhaseC`/`escalateTo`/`cmdCancel` set `dispute: { status: "none" }` (replaces the current 6-flag clearing in `transitions.ts:234-277` and `commands.ts`) |

**Reload policy (the fix):** `clearTransientFlags` no longer touches `dispute`. Restore of `filed`/`in-review`/`conceded`/`defended` → next settle redelivers per rows 3/5/7 (idempotent: the status gates delivery, so a double settle cannot double-deliver — the status moves on delivery). Restore of `closed`/`none` → no-op.

**Verbatim pins (existing strings, unchanged):** the dispute review prompts (`GP.promptTesterReviewWriterDispute`, `GP.promptWriterDisputeReview`, `GP.promptTesterReportRejected`, `GP.promptWriterDisputeDefended`, `GP.promptWriterConcedeFix`), `promptTesterDisputeFix` (all languages), the tool result `"Dispute filed. STOP producing tool calls. The review is requested when your turn ends."` (`src/tools.ts:246`), the tool-call block reason `"Dispute filed. Waiting for dispute review. STOP producing tool calls."` (`src/events/tool-call.ts:60`).

**New user-visible strings:** none. (The escalation notify `"Dispute limit reached. Escalating to human."` — `src/tools.ts:124` — moves from filing-time to resolution-time but the string is unchanged.)

**Side-effect contract:**
- `tool-call.ts` rule 2 (block all tools) keys off `dispute.status === "in-review"` (was `awaitDisputeReview`); rule 3 (block non-test writes) keys off `dispute.status === "conceded" || (status === "filed" && filer === "writer")` — pinned: the current `disputeMode` is true from *filing* for a writer-filed dispute and from *concede* for a tester-filed one (`tools.ts:369`), so the rule-3 condition must preserve both windows.
- `before-agent.ts:buildDisputeFixPrompt` keys off `dispute.status === "conceded"` (was `awaitDisputeFix`); its clear-at-prompt-build + persist order is preserved (R3 pin, `before-agent.ts:172-179`).
- `handleBDisputeReview` no longer re-derives the filer from `disputeMode` — it reads `dispute.filer` (set at filing; the current code's comment at `tools.ts:337-339` already says the recorded value is load-bearing — this makes it the *only* value).

**Quirks list:**
- Q1: `logDisputeEntry` (`src/tools.ts:98-107`) writes `filer: state.current.disputeMode ? "tester" : "writer"` — the *re-derived* filer, which is wrong for a writer-filed dispute at filing time (`disputeMode` is false until the review). After this unit the log entry reads `dispute.filer` — intended shift S2, not a quirk.
- Q2: `handleDisputeFix` returns `{ handled: true, type: "fix" }` even when the flag is unset (`dispute.ts:28` — `handled: false` there; the `type` field is vestigial). Pinned: `type` is removed with the handler rewrite; no behavior change.

**Intended shifts:**
- S1: budget consumed at resolution, not filing (Interface). Before: lost disputes consume budget. After: only resolved disputes do.
- S2: dispute log entries record the *recorded* filer (Q1).
- S3: a reload mid-dispute now *redelivers* the pending leg on next settle (was: silent evaporation). A user watching a restored session sees the dispute prompt re-appear — this is the fix being visible, not a regression.

**Ownership:** `src/types.ts` (shape), `src/tools.ts` (filing/resolution), `src/events/agent-settled/dispute.ts` (delivery), `src/events/session-start.ts` (migration + no-clear), `src/events/tool-call.ts` + `src/events/before-agent.ts` (keying). Tests: `test/extension.test.ts` (lifecycle), `test/events/session-start.test.ts` (migration + survival), `test/events/tool-call.test.ts` (rule keying).

## Inventory

**Files touched (closed list — 9):**
1. `src/types.ts` — `DisputeState` added; 6 fields removed.
2. `src/tools.ts` — filing/resolution rewritten per table; `logEscalation` keys off the new check.
3. `src/events/agent-settled/dispute.ts` — 4 handlers rewritten to status transitions.
4. `src/events/agent-settled/index.ts` — `checkLoopEscalation` dispute clearing → `dispute: { status: "none" }`.
5. `src/events/session-start.ts` — migration; `clearTransientFlags` shrinks (dispute lines removed).
6. `src/events/tool-call.ts` — rules 2-3 re-keyed.
7. `src/events/before-agent.ts` — dispute-fix prompt key re-keyed.
8. `src/transitions.ts` — `advanceToPhaseC`/`escalateTo` dispute clearing → single field.
9. `src/commands.ts` — `resetPhaseState`/`cmdCancel` dispute clearing → single field.

**Imports:** no new modules. `DisputeState` exported from `src/types.ts` (type-only).

**`loop-state` payload change:** the persisted object gains `dispute` (object) and loses 6 flat fields. The migration in `session-start.ts` handles old entries (Interface). `test/extension.test.ts` fixtures that assert on `disputeMode`/`awaitDispute*` fields (grep: ~14 assertions, lines 836-843, 1009-1020, 1247-1315) are rewritten to the new shape — counted in Test Strategy.

## Test Strategy

- **Baseline:** 32 files / 1017 tests green.
- **Flips (counted):** `test/extension.test.ts` — the dispute fixture/assertion sites (grep `disputeMode\|awaitDispute` in the file: 14 assertion sites) are rewritten old-field → `dispute.status`; **14 flips**, each old→new named in the implementation PR. `test/events/session-start.test.ts` — 2 flips (the cleared-flags assertions at lines ~1009, ~1247 become survival assertions — the *opposite* expectation, which is the fix). `test/events/tool-call.test.ts` — 3 flips (rule 2/3 fixtures). Total: **19 flips**.
- **New tests (the evaporation regressions, named):**
  1. "reload after filing preserves the dispute": file → persist → reload → `dispute.status === "in-review"` (was: flags cleared, dispute gone).
  2. "reload after concede preserves the fix obligation": concede → reload → `status === "conceded"` → next settle delivers `promptTesterDisputeFix()` (was: evaporation, gate burns maxB).
  3. "budget consumed at resolution, not filing": file 3 disputes, reload after each, resolve none → `disputeCount === 0` (was: 3 → spurious escalation on the 4th).
  4. "redelivery is idempotent": in-review → reload → settle delivers the review prompt; immediate second settle does NOT re-deliver (status moved).
  5. "old-shape entry migrates": seed a pre-fix `loop-state` entry (`disputeMode: true, awaitDisputeReview: true`, no `dispute` field) → restore → `dispute.status === "in-review"`, old fields absent from `state.current`.
- **Untouched:** `src/gates.ts`, `src/baseline.ts`, `src/selectors.ts`, `src/metrics.ts` — mechanism: no gate/display code reads dispute fields (grep-proven: `disputeMode` has 0 hits in those files).

## Scope lines

- `src/types.ts`: 6 fields **removed**, `DisputeState` **added**.
- `src/events/agent-settled/dispute.ts`: all 4 handlers **rewritten** (same module, same exports — `handleDisputeFix/Review/Defend/WriterConcedeFix` keep their names and the `DisputeHandlerOutput` shape so the dispatcher is untouched).
- `src/events/session-start.ts`: `clearTransientFlags` **shrinks** (dispute lines removed); migration **added**.
- All other touched files: kept + re-keyed.
- `README.md` / `SPEC.md`: SPEC.md's dispute section (grep `dispute` in SPEC.md: the Phase B dispute flow) updated to the status lifecycle — one section rewrite; no README change (no command/tool surface change).

## Acceptance Criteria

1. Tests 1-5 above fail on pre-fix code (1, 2, 3, 5) or assert new behavior (4) and pass after.
2. `npm test` green, 32 files, with the 19 counted flips landed.
3. Grep sweeps (needles that must reach 0 in `src/`): `disputeMode`, `awaitDisputeFix`, `awaitDisputeReview`, `disputeDefended`, `awaitWriterConcedeFix`, `disputeFiler` — all 0. (Each currently has ≥ 3 hits; the migration in `session-start.ts` is the *only* place the old names may appear, as string keys reading the raw entry — pinned exception, counted: 6 hits, all in the migration function.)
4. Grep sweep: `dispute.status` ≥ 12 hits in `src/` (the lifecycle is the only mechanism).
5. `npx tsc --noEmit` clean (the field removals are the type-checker's job; the test runner does not type-check).

## Dependencies

- **Hard dependency:** `refactor-single-commit-point.md` — the redelivery-on-settle is idempotent only if the settle commits (commit point #4); without commits, a reload after redelivery re-delivers forever.
- **Soft dependency:** `bug-gate-signal-integrity.md` (shares `src/events/agent-settled/index.ts` and `src/transitions.ts`; order: gate → commit → this).
- **Blocks:** nothing. `refactor-state-model-divergence.md` will adopt the `DisputeState` shape if it lands later (its sub-structure `DisputeState` in `src/state-types.ts:39-45` is superseded by this unit's shape — pinned: this unit's shape wins, the dead module is deleted, not reconciled).

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | The 2025-08-18 review (B-9) named two windows (filing, fix-leg); a third exists — the review leg *is* crash-safe (clear-at-schedule at `dispute.ts:58`), which is why the asymmetry is the root cause, not three independent bugs | Accepted — the lifecycle table unifies all three legs under one status |
| 2 | needs-doc | `src/state-types.ts` already defines a `DisputeState` (mode/count/max/awaitFix/awaitReview) for the dead refactor — name collision with this unit's `DisputeState` | Rejected as a constraint — the dead module is out of the live path (see `refactor-state-model-divergence.md`); this unit's shape wins; the collision disappears when the dead module is deleted |
