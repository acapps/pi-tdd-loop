# Wire the negotiate review round

## Problem

The negotiate phase is designed as a Writer-propses / Tester-reviews exchange, but the
handoff is broken in four verified places (all checked against the repo as of writing):

1. **The writer→Tester prompt is sent from tool context and is lost.**
   `src/tools.ts:159` `triggerTesterReview` (called from `executeNegotiateProposal` at
   `src/tools.ts:156`) sends `GP.promptNegotiateProposalForReview(lastProposal)` via
   `pi.sendUserMessage(..., { triggerTurn: true })` *during* the Writer's active turn.
   Empirically this message is never delivered: in session `01a00b11-7e19-75fb-be92-652e656893e8`
   (2026-08-16) the Writer's `negotiate_propose` calls were logged to `loop-negotiate`
   entries, but no "Writer proposes:" user message appears anywhere in the session.
   All 9 loop-driven user messages in that session were sent from agent-settled or
   command context — never from tool context.
2. **The settle handler ignores whether a proposal was recorded.**
   `src/events/agent-settled/negotiate.ts:32` `handleNegotiateSettled` runs on every
   negotiate settle and calls `computeNegotiateTransition` (`src/transitions.ts:43`),
   which keys only on `negotiateReprompted` and `round % 2` — not on whether the Writer
   actually proposed. After a successful proposal the Writer is reprompted
   ("Must use negotiate_propose…"), and the next settle auto-advances to B with
   "Advancing to Phase B without explicit proposal." (`src/transitions.ts:55`). In the
   session this skipped the Tester review entirely.
3. **The Tester branch is unreachable and unbounded.** `repromptTester`
   (`src/transitions.ts:80`) returns the state *unchanged* — it never sets
   `negotiateReprompted` — so a Tester that never reviews would be reprompted forever.
   It is unreachable in practice because the even round is never reached (defect 2).
4. **The feedback direction has the same latent defect.**
   `executeNegotiateFeedback` (`src/tools.ts:283`) sends `GP.promptNegotiateFeedback`
   from tool context (lost, same mechanism as 1) and mutates no state — no marker, no
   round change — so the settle handler cannot deliver it either.

Additionally, `maxNegotiate` is not used by `computeNegotiateTransition` (only by
`getPhaseMax` for notify strings), so a Writer↔Tester ping-pong would be unbounded once
delivered.

## Target

After the Writer records a non-"agree" proposal, the loop hands off to the Tester:
round 1→2 (even), one user message containing the proposal text, sent from the
agent-settled context (the only context proven to deliver). The Tester's
`negotiate_review` approve advances to Phase B (existing code path, unchanged); a
non-approve feedback returns to the Writer on the next odd round, again delivered by
the settle handler. The reprompt / auto-advance fallback is preserved for settles where
no proposal or feedback was recorded. All handoff prompts move out of tool context; the
tools record intent in state, the settle handler delivers. The Writer↔Tester feedback
loop is bounded by `maxNegotiate` Writer rounds (row 2b — escalate when exhausted)
under any `maxTurnsPerPhase`; the existing turn-loop detector
(`src/events/agent-settled/index.ts:35`) bounds everything else, as in every other
phase (see Quirk 3).

## Interface

`LoopState` (`src/types.ts:7`) gains two **optional** transient fields (optionality is
the existing precedent — `lastGateResult?`, `specFindings?`, `awaitingReview?`,
`skipPhase0?` — and keeps every existing state fixture and saved session entry valid):

```typescript
negotiateProposed?: boolean;  // set by negotiate_propose (negotiate phase, non-"agree");
                              // consumed + cleared by the settle handler at round odd→even
negotiateFeedback?: string;   // set by negotiate_review (negotiate phase, non-approve);
                              // consumed + cleared by the settle handler at round even→odd
                              // undefined and "" both mean "no feedback pending"
```

- `computeNegotiateTransition(state: LoopState)` — signature unchanged.
- `handleNegotiateSettled(input: NegotiateHandlerInput)` — signature unchanged.
- Tool `execute` signatures — unchanged.
- `TransitionEffect` (private union, `src/transitions.ts:12`): two variants added —
  `{ type: "review-request"; notify: string }` and `{ type: "feedback"; notify: string }`.
  They are produced only by `computeNegotiateTransition`; the gate path
  (`applyEffect`, `src/events/agent-settled/effect-applicator.ts:58`) is unaffected —
  its `Effect` alias is `ReturnType<typeof T.computeTransition>["effect"]`, which never
  gains the new variants, and its `default:` branch remains the type-level guard.
- No type-level facts otherwise: no non-exported types change, no union exhaustiveness
  change outside the private effect union.

## Behavior

### Decision table — `computeNegotiateTransition` (first match wins)

Round parity semantics (new, now reachable): **odd round = Writer turn, even round =
Tester turn.** `state` is the pre-settle state; each row returns a fresh state object
(the input is never mutated — pure-state contract pinned by
`test/events/agent-settled/negotiate.test.ts`).

| # | Condition (evaluation order) | New state | Effect |
|---|---|---|---|
| 1 | `state.negotiateProposed === true` | `{ ...state, round: round + 1, negotiateProposed: false, negotiateFeedback: "", negotiateReprompted: false }` | `{ type: "review-request", notify: "Writer proposed — Tester reviewing." }` |
| 2a | `(state.negotiateFeedback ?? "") !== ""` and `(round + 2) / 2 <= state.maxNegotiate` | `{ ...state, round: round + 1, negotiateFeedback: "", negotiateProposed: false, negotiateReprompted: false }` | `{ type: "feedback", notify: "Tester feedback recorded — Writer revising." }` |
| 2b | `(state.negotiateFeedback ?? "") !== ""` and `(round + 2) / 2 > state.maxNegotiate` | `escalateTo(state, "negotiate")` → `phase: "escalated"`, `lastPhase: "negotiate"`, `turnsThisPhase: 1` | `{ type: "escalated", status: "escalated (Phase negotiate exhausted)", notify: "Negotiation limit reached. Escalating to human." }` |
| 3 | `state.negotiateReprompted === true` | `advanceToPhaseB(state)` with `negotiateReprompted: false` — **unchanged** from today | `advance` — **unchanged** (`status: "Phase B — round 1"`, `notify: "Advancing to Phase B without explicit proposal."`, `prompt: "cleaner_phase_c"`) |
| 4 | `round % 2 === 1` (odd) | `{ ...state, negotiateReprompted: true }` — **unchanged** | `reprompt` — **unchanged** (`notify: "Writer must use negotiate_propose tool."`, `level: "warning"`, `prompt: REPROMPT_KEYS.WRITER`) |
| 5 | else (even) | `{ ...state, negotiateReprompted: true }` — **CHANGED**: today `repromptTester` returns the state unchanged (`src/transitions.ts:80-90`) | `reprompt` — effect payload **unchanged** (verbatim today: `notify: "Tester must use negotiate_review tool."`, `level: "warning"`, `prompt: REPROMPT_KEYS.TESTER`) |

Rows 1–2 take priority over row 3 on purpose: a recorded proposal supersedes any
reprompt state (the Writer may propose after being reprompted — that is the happy
path). Row 2b cap: Writer proposal round `n` (odd) has index `(n + 1) / 2`; feedback
delivered at even round `r` would create Writer round `r + 1` with index
`(r + 2) / 2`. With the default `maxNegotiate: 3` the Writer proposes in rounds 1, 3,
5; the Tester feedback after round 5 (at even round 6) escalates.

### Handler — `handleNegotiateSettled` (`src/events/agent-settled/negotiate.ts:32`)

Per effect variant, in the agent-settled context (the only context proven to deliver
user messages — see Problem 1):

| Effect variant | `pi.sendUserMessage(prompt, { triggerTurn: true })` | `ctx.ui.notify` | `ctx.ui.setStatus` | debug lines (in order) |
|---|---|---|---|---|
| `review-request` | `GP.promptNegotiateProposalForReview(state.lastProposal)` — payload read from the **input** state (the transition does not touch `lastProposal`) | `(effect.notify, "info")` | none | entry line, then `Negotiate: proposal → Tester review (round ${state.round + 1})` |
| `feedback` | `GP.promptNegotiateFeedback(state.negotiateFeedback ?? "")` — payload read from the **input** state (the transition clears the field) | `(effect.notify, "info")` | none | entry line, then `Negotiate: feedback → Writer revision (round ${state.round + 1})` |
| `reprompt` | **unchanged**: `GP.promptNegotiateRepromptWriter()` / `GP.promptNegotiateRepromptTester()` keyed off `effect.prompt` | unchanged | unchanged | entry line only |
| `advance` | **unchanged**: `lang.prompts.promptNegotiateAutoAdvance()` | unchanged | unchanged | entry line, then `Negotiate: auto-advancing to Phase B` |
| `escalated` (newly producible) | none — matches the existing escalated-effect pattern (`applyEscalatedEffect` sends no message) | `(effect.notify, "warning")` | `("loop", effect.status)` | entry line, then `Negotiate: limit reached → escalating` |

The hardcoded entry debug line `Negotiate: agent didn't use tool (reprompted=…, round …)`
(`src/events/agent-settled/negotiate.ts:36`) — a misnomer, emitted even when the tool
*was* used — is replaced by:

```typescript
debug(`Negotiate: settle (round ${state.round}, proposed=${state.negotiateProposed === true}, feedback=${(state.negotiateFeedback ?? "") !== ""}, reprompted=${state.negotiateReprompted})`);
```

### Tool changes — `src/tools.ts` (state-record only; no messages sent from tool context)

- `executeNegotiateProposal` (`:149`): the `triggerTesterReview` call is removed.
  New body, in this exact order (order pinned — class F):
  1. `debug("negotiate_propose: proposal recorded")` (unchanged)
  2. `state.current.negotiateProposed = true;`
  3. `pi.appendEntry("loop-state", { ...state.current });` (crash-safe persistence —
     same pattern as `triggerDisputeReview`, `:171`)
  4. `return buildProposeResult();` → verbatim `"Proposal recorded. Awaiting review."` (unchanged)
- `executeNegotiateFeedback` (`:283`): the `sendContextMessage(GP.promptNegotiateFeedback(...))`
  call and its now-unused `getLanguageConfig` lookup are removed. New body, in order:
  1. `debug("negotiate_review: feedback")` (unchanged)
  2. `state.current.negotiateFeedback = decision;`
  3. `pi.appendEntry("loop-state", { ...state.current });`
  4. `return buildReviewResult(...)` → verbatim `"Feedback recorded."` (unchanged)
  Round is *not* changed by the tool — the transition advances it at settle (parity
  must stay even through the Tester turn).
- `executeNegotiateAgree` (`:127`) / `executeNegotiateApprove` (`:261`): existing
  reset block (which already sets `negotiateReprompted: false` at `:138` / `:272`) gains
  two lines: `state.current.negotiateProposed = false; state.current.negotiateFeedback = "";`
  Everything else unchanged — the advance to B still rides `justTransitioned` →
  `handleJustTransitioned` (`src/events/agent-settled/index.ts:53`), which sends
  `promptNegotiateApproved` from settle context (proven in the session).
- `triggerTesterReview` (`:159`): **removed** — caller count 1 (`:156`), verified by
  grep; after removal, zero. `sendContextMessage` (`:399`) stays — `executeBDisputeDefend`
  still calls it (see Quirks 2).

### State plumbing (closed list — five production sites)

| Site | Change |
|---|---|
| `src/types.ts` `LoopState` | + `negotiateProposed?: boolean;` + `negotiateFeedback?: string;` |
| `index.ts` initial literal (`:18`) | + `negotiateProposed: false,` + `negotiateFeedback: "",` |
| `src/commands.ts` `createInitialState` (`:88`, used by `/loop` at `:172`) | + both, same values |
| `src/commands.ts` `resetPhaseState` (`:70`, used by `/loop-continue` at `:250` and `/loop-restart` at `:295`) | + `state.negotiateProposed = false; state.negotiateFeedback = "";` |
| `src/events/session-start.ts` `clearTransientFlags` (`:39`, called at `:71`) | + `s.negotiateProposed = false; s.negotiateFeedback = "";` — this also heals restored entries from pre-feature sessions, where the fields are `undefined` |

### Side-effect contract

- User messages: exactly one per negotiate settle (review-request / feedback / reprompt
  / auto-advance) — all from the agent-settled handler, `{ triggerTurn: true }`. Net
  change vs today: the propose/feedback tools stop sending (2 sends removed); the
  handler gains 2 send branches.
- Entries appended: `loop-state` on non-"agree" propose and on non-approve feedback
  (new, 2 sites); all existing entries unchanged (`loop-negotiate` from both tools,
  `loop-state` from agree/approve/dispute paths).
- `turnsThisPhase`: incremented per settle by the dispatcher (`index.ts:45`) —
  unchanged.

### Quirks list (current behavior, do not fix)

1. **The auto-advance fallback stays.** When the Writer never proposes, one reprompt
   then "Advancing to Phase B without explicit proposal." is the shipped escape — it is
   how session 01a00b11 completed. Not replaced by escalation.
2. **`executeBDisputeDefend` (`src/tools.ts:311`) has the same latent lost-message
   defect** — it sends `GP.promptWriterDisputeDefended` from tool context. Out of scope:
   different phase (B), different tool path, different test file. Candidate for a
   follow-up spec; no change here.
3. **Bounds interaction.** Two bounds coexist. (a) Row 2b bounds the *feedback* path
   (propose → feedback → …) under any `maxTurnsPerPhase` — with default
   `maxNegotiate: 3`, the 3rd feedback (even round 6) escalates. With default
   `maxTurnsPerPhase: 5`, `checkLoopEscalation` (`index.ts:35-50`) instead escalates
   on the 6th turn of the phase — the detector wins at defaults, row 2b wins at
   non-default `maxTurnsPerPhase`. (b) The *propose* path has **no** round cap: the
   tool does not check round parity (`handleNegotiatePropose`, `src/tools.ts:92`), so
   an agent proposing on the Tester round overwrites `lastProposal` and every settle
   consumes it via row 1 — unbounded except by the turn-loop detector, exactly as in
   every other phase. No row 1b cap: a role-violation edge is not worth a new knob
   (Phase 0 F2, decided).
4. **`getPhaseMax` "review" reusing `maxNegotiate`** (`src/transitions.ts:287`) —
   unchanged.
5. **Orphaned nested-shape modules** (`src/state-types.ts`, `state-factory.ts`,
   `state-migration.ts`, `state-validation.ts`, `transient-flags.ts` — the nested
   `LoopState` from `internal/done-loop-state-refactor.md`) are referenced only by
   their own tests, not by `index.ts` or any live handler. Unchanged; the live flat
   shape is `src/types.ts`.
6. **`buildContinuePrompt`'s negotiate branch** (`src/commands.ts:28-37`,
   `round % 2 === 1 ? writer-prompt : tester-reprompt`) acquires correct semantics as a
   side effect of parity now carrying a role — even-round `/loop-continue` in the
   Tester turn sends the Tester prompt instead of the (today's only) Writer prompt.
   This is intended, not a quirk.

### Ownership

| Behavior | Module | Asserted by |
|---|---|---|
| Transition table rows 1–5 (pure state) | `src/transitions.ts` | `test/transitions.test.ts` |
| Prompt delivery, notify, debug (rows 1–5) | `src/events/agent-settled/negotiate.ts` | `test/events/agent-settled/negotiate.test.ts` |
| Tool state-record + no-send (propose/feedback) | `src/tools.ts` | `test/extension.test.ts` |
| Approve/agree → B advance (unchanged path) | `src/tools.ts` | `test/extension.test.ts` |
| Transient-field restore + restart reset | `src/events/session-start.ts`, `src/commands.ts` | `test/events/session-start.test.ts`, existing `test/transient-flags`-adjacent suites (flat shape: `test/events/session-start-wiring.test.ts`) |

## Inventory

**Files touched (7):** `src/types.ts`, `src/transitions.ts`,
`src/events/agent-settled/negotiate.ts`, `src/tools.ts`,
`src/events/session-start.ts`, `src/commands.ts`, `index.ts`.

**Functions:**
- Added: none public. Private: two `TransitionEffect` variant builders are inlined in
  `computeNegotiateTransition` (matching the existing `repromptWriter`/`repromptTester`
  style — no new helper functions).
- Changed: `computeNegotiateTransition`, `repromptTester` (flag set),
  `handleNegotiateSettled`, `executeNegotiateProposal`, `executeNegotiateFeedback`,
  `executeNegotiateAgree`, `executeNegotiateApprove` (2 lines each), `clearTransientFlags`,
  `createInitialState` (commands.ts), `resetPhaseState`.
- Removed: `triggerTesterReview` (caller count 1 → 0, verified).
- Dead code: none introduced.

**Imports (closed):** 0 added, 0 rewritten, 0 removed in every touched file.
`negotiate.ts` already imports `* as GP` (used for the reprompt mapping); the two new
GP calls reuse it. `tools.ts` already imports `GP` (still used by the dispute prompts —
`promptWriterDispute`, `promptWriterDisputeDefended`); after the change it no longer
references `promptNegotiateProposalForReview` / `promptNegotiateFeedback`, whose sole
call sites move to `negotiate.ts`.

**Call sites (who sets / reads / clears the markers):**
- Set: `executeNegotiateProposal` (`negotiateProposed`), `executeNegotiateFeedback`
  (`negotiateFeedback`).
- Read: `computeNegotiateTransition` rows 1–2 (condition), `handleNegotiateSettled`
  (payloads), the entry debug line.
- Cleared: transition rows 1/2/3 (new state), `executeNegotiateAgree` /
  `executeNegotiateApprove` (explicit reset), `clearTransientFlags` (restore),
  `resetPhaseState` (restart).

**Exports:** unchanged — no new exports; `computeNegotiateTransition` is already
exported. `GP.promptNegotiateProposalForReview` / `GP.promptNegotiateFeedback` keep
their names, signatures, and verbatim bodies (call sites move only).

## Test Strategy

**Baseline:** 934/934 passing across 31 files; `tsc --noEmit` clean (verified at the end
of session 01a00b11, spec 06 complete, 2026-08-16 17:24).

**Per-test disposition:**

Rewritten (6 — old assertion → new assertion):
1. `test/extension.test.ts` "records proposal and transitions to Tester review in
   negotiate phase" — old: last sent message contains "proposes"/"Review" (tool send).
   New: the last `loop-state` entry has `negotiateProposed === true`, and
   `api.sentMessages` did **not** grow (tool sends nothing).
2. `test/extension.test.ts` "gives feedback in negotiate phase" — old: last sent
   message contains "feedback"/"Revise" (tool send). New: the last `loop-state` entry
   has `negotiateFeedback === decision`, and `api.sentMessages` did not grow.
3. `test/events/agent-settled/negotiate.test.ts` "even round → tester reprompt,
   `negotiateReprompted` stays false" — old: stays `false`. New: becomes `true` (row 5).
   Its pinned debug line at `:111` (`"Negotiate: agent didn't use tool (reprompted=false,
   round 2)"`) is also replaced with the new entry-line string — the same replacement as
   rewrites #4 (pin at `:97`) and #5 (pin at `:155`). Closed count: those three are the
   only test pins of that string; the fourth hit of Acceptance Criterion 4's grep is the
   source line this spec replaces (`src/events/agent-settled/negotiate.ts:36`).
4. `test/events/agent-settled/negotiate.test.ts` "odd round, not reprompted → writer
   reprompt" — state assertions kept; the pinned debug line
   `"Negotiate: agent didn't use tool (reprompted=false, round 1)"` is replaced with the
   new entry-line string.
5. `test/events/agent-settled/negotiate.test.ts` "negotiateReprompted true → advance to
   B r1" — state/message assertions kept; the two pinned debug lines are replaced
   (new entry line + unchanged `"Negotiate: auto-advancing to Phase B"`).
6. `test/transitions.test.ts` "first settle: re-prompts Tester on even round" — effect
   assertions kept; add `expect(result.state.negotiateReprompted).toBe(true)`.

Kept unchanged (every other test — the two new fields are optional, so all existing
state fixtures remain valid without edits), notably: "auto-advance wins over the
odd/even reprompt (round 1 + reprompted)" (its fixture has no marker → row 3 still
wins), the B-phase dispute tests, `test/prompts.test.ts` (GP strings unchanged),
`test/events/agent-settled/index.test.ts` (dispatcher unchanged), all golden/e2e,
`test/state-*.test.ts` + `test/transient-flags.test.ts` (orphaned nested shape —
untouched, Quirk 5).

**New tests (one per newly pinned behavior):**
- `test/transitions.test.ts`: row 1 (proposed → round+1 even, both markers cleared,
  `negotiateReprompted` cleared, effect `review-request`, input unmutated); row 2a
  (feedback at round 4, `maxNegotiate` 3 → round 5, effect `feedback`); row 2b
  boundary (round 6, `maxNegotiate` 3 → `phase: "escalated"`, `lastPhase: "negotiate"`;
  and round 4 with `maxNegotiate` 1 → also escalates); precedence (state with
  `proposed=true` **and** `negotiateReprompted=true` → `review-request`, not advance);
  row 5 flag assertion.
- `test/events/agent-settled/negotiate.test.ts`: `review-request` sends exactly one
  message === `GP.promptNegotiateProposalForReview(lastProposal)` with
  `{ triggerTurn: true }` + notify string + branch debug; `feedback` sends exactly one
  message === `GP.promptNegotiateFeedback(decision)` + notify + branch debug;
  `escalated` → notify + setStatus, **no** `sendUserMessage`; pure-state no-mutation on
  all new paths.
- `test/extension.test.ts`: the two rewritten tool tests (above) — these also pin the
  no-send-from-tool behavior.
- `test/events/session-start.test.ts`: restored entry lacking the new fields → after
  `handleSessionStart`, `negotiateProposed === false` and `negotiateFeedback === ""`
  (defined, not `undefined`).

**Untouched:** every suite not named above; until a follow-up spec (B-dispute
handoff) lands, `executeBDisputeDefend`'s behavior and its tests stay as-is.

## Scope lines

- `src/types.ts` — kept; +2 optional fields on `LoopState`. Nothing else.
- `src/transitions.ts` — kept; `computeNegotiateTransition` + rows 1–2, `repromptTester`
  + flag, effect union +2 variants, +3 debug strings. `getPhaseMax` and every other
  function byte-identical.
- `src/events/agent-settled/negotiate.ts` — kept; +3 new effect branches (review-request,
  feedback, escalated), entry debug line replaced. The reprompt/advance branches
  byte-identical.
- `src/tools.ts` — kept; 4 functions changed as specified; `triggerTesterReview`
  removed; `executeBDisputeConcede`/`executeBDisputeDefend`/`triggerDisputeReview` and
  every B-phase path byte-identical.
- `src/events/session-start.ts` — kept; `clearTransientFlags` +2 lines only.
- `src/commands.ts` — kept; `createInitialState` +2 lines, `resetPhaseState` +2 lines.
- `index.ts` — kept; initial literal +2 lines. (No byte-identity pin here — nothing
  consumes the entry-point hash in this unit.)

## Acceptance Criteria

Each names a checker that can see it (`npm test` = `vitest run` only — package.json:21 —
so the type checker is named separately, spec 06 V3 precedent):

1. `npx vitest run` fully green — 31 existing files, 6 rewritten tests, all new tests
   in `test/transitions.test.ts`, `test/events/agent-settled/negotiate.test.ts`,
   `test/extension.test.ts`, `test/events/session-start.test.ts`. Checker: vitest (the
   gate's `runTests` parses its `FAIL` lines).
2. `npx tsc --noEmit` exit 0. Checker: tsc — vitest does not type-check.
3. Sweep (functional + textual): `grep -rn "triggerTesterReview" src/ test/` → zero
   lines. Checker: grep.
4. Sweep (textual): `grep -rn "agent didn't use tool" src/ test/` → zero lines.
   Checker: grep.
5. Sweep (verbatim, exactly one hit each in `src/`): `"Writer proposed — Tester
   reviewing."` (transitions.ts), `"Tester feedback recorded — Writer revising."`
   (transitions.ts), `"Negotiation limit reached. Escalating to human."`
   (transitions.ts). Checker: grep.
6. Manual probe (not a gate criterion — recorded for the run log): a live `/loop` run
   where the Writer proposes a non-"agree" plan produces a `"Writer proposes:"` user
   message in the session JSONL (every user message is recorded there — the session
   01a00b11 failure is detectable exactly this way). Checker: session log inspection
   after the run.

## Dependencies

- Spec 04 (agent-settled handlers) — implemented; the negotiate handler and dispatcher
  exist as cited above, which is why this spec edits them in place rather than adding a
  module.
- Spec 05 (effect-applicator) — implemented; the gate path only. The negotiate handler
  sends its own prompts (it never called `applyEffect`); unaffected.
- Spec 06 (remove monolith) — implemented; the events barrel is the registration
  surface. This spec touches no barrel code.
- `internal/done-loop-state-refactor.md` — the nested-shape modules are orphaned
  (Quirk 5); intentionally not a dependency.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Blocking | Tool-context `sendUserMessage` does not deliver (Problem 1) | **Accepted.** Verified against session 01a00b11: both `negotiate_propose` calls logged to `loop-negotiate` entries, zero "Writer proposes:" user messages; all 9 loop-driven user messages sent from settle/command context. Spec now pins all handoff prompts in the agent-settled handler (Behavior: Handler table) and the tools record intent in state instead. |
| 2 | Blocking | `computeNegotiateTransition` ignores recorded proposals; Tester branch unreachable; `repromptTester` never sets the flag (Problems 2–3) | **Accepted.** Verified at `src/transitions.ts:43-90`. Spec now pins the 5-row decision table with the marker priority order and the row-5 flag (fixing the infinite-reprompt edge). |
| 3 | Author verification miss (class K) | First reading assumed `repromptTester` set `negotiateReprompted`; the second read of `src/transitions.ts:80-90` showed it returns the state unchanged — the unbounded-Tester edge was missed until then | **Accepted.** Row 5 of the decision table pins the flag; the flipped assertion is item 3 of the Test Strategy rewrite list. |
| 4 | Adjacent defect | `executeBDisputeDefend` (`src/tools.ts:311`) sends `GP.promptWriterDisputeDefended` from tool context — the same latent lost-message defect | **Rejected as in-scope** (one verb, one object: this unit is the negotiate round). B-phase, different tool path, different tests. Flagged for a follow-up spec; Quirk 2 pins "do not fix here". |
| 5 | Config interaction | With default `maxTurnsPerPhase: 5`, the turn-loop detector escalates on the 6th phase turn, before the row-2b `maxNegotiate` round cap can fire | **Accepted as documented** (Quirk 3). Both escalations are correct; row 2b bounds the feedback path under non-default `maxTurnsPerPhase` (the propose path is bounded only by the detector — Phase 0 F2). New tests pin row 2b independently of the detector. |
| 6 | Phase 0 — auto-generated summary | 4 auto-generated findings: prose fragments misread as missing "directory references", effect-variant strings misread as missing types, "Sweep" treated as a function | **Rejected as extractor artifacts.** Verified: none of the four names a real gap — "Sweep" is Acceptance Criterion 3's grep, not a function; the "missing" types/directories are table cells and prose. No spec change. |
| 7 | Phase 0 F1 (required) | Test rewrite #3 missed the third `"agent didn't use tool"` pin (`test/events/agent-settled/negotiate.test.ts:111`) — the rewrite list covered 2 of 3 test pins, so Acceptance Criterion 4 (zero grep hits) would fail after applying the spec's own rewrites | **Accepted, fixed.** Verified: the three test pins are at `:97`/`:111`/`:155` and the source line at `negotiate.ts:36`. Rewrite #3 now names the `:111` replacement and the closed 4-hit count. |
| 8 | Phase 0 F2 (author decision) | "Self-bounded by `maxNegotiate` under any configuration" overclaimed — row 1 has no cap: proposes on the Tester round (the tool checks no parity) advance unbounded except via the turn-loop detector | **Accepted as wording fix** (reviewer's leaning). Row 1b cap rejected — a new knob for a role-violation edge. Target and Quirk 3 reworded; the propose-path edge is now pinned in Quirk 3(b) with the parity-check evidence (`src/tools.ts:92`). |
| 9 | Phase 0 F3 (nit) | `applyEffect` is at `effect-applicator.ts:58`, not `:77` | **Accepted, fixed** (verified by grep). |
| 10 | Phase 0 F4 (nit) | `resetPhaseState` is used by `/loop-continue` as well as `/loop-restart` | **Accepted, fixed** — plus its own line number corrected (`:70`, not `:72`); verified callers at `src/commands.ts:250` and `:295`. |
