# fix-just-transitioned-settle-drop

## Problem

Verified current state as of writing (2026-09-19):

- `justTransitioned` (required boolean, `src/types.ts:29`, `src/state-validation.ts:45`) is set at exactly **4 entry points**:
  1. `src/tools/state-io.ts:35` — `resetForPhaseB` (negotiate→B via `negotiate_review`, prompt delivered synchronously by `applyTransitionEffect` in the same tool call)
  2. `src/commands/patch.ts:95` — `/loop-patch` (prompt delivered synchronously by `sendPrompt` at patch.ts:102-109 — same delivery timing as entry points 1 and 3; it is grouped with entry point 4 in S1 only because its prompt is a *re-entry* prompt whose first settle is a prompt-delivery settle, matching the consumed semantics the 01a0ba95 stall requires)
  3. `src/tools/negotiate.ts:172` — `executeNegotiateReReview` (re-review prompt delivered synchronously by `sendPrompt`, negotiate.ts:174)
  4. `src/transitions.ts:296` — `advanceToPhaseB` (settle-path B advance; prompt delivered by the **next turn's** `before_agent_start`)
- It is cleared at 4 places: `src/events/agent-settled/index.ts:73` (`handleJustTransitioned`, the settle dispatcher), `src/tools/dispute.ts:58` (Writer concede) and `:93` (dispute filed — both so the gate runs after resolution), and `src/state-helpers.ts:18` (`resetPhaseState`, human restarts).
- `handleJustTransitioned` (`src/events/agent-settled/index.ts:65-80`) is dispatcher **step 4**, before the dispute handlers and `handlePhaseSettled` (index.ts:103-106). It **returns `true` (handled) and stops the pipeline**: the gate, the commit point, everything after it never runs. Its contract (comment index.ts:75-78): "the advance effect already sent it" — i.e., the settle that consumes the flag is assumed to be the *prompt-delivery* settle, not a *work* settle.
- **The assumption is only true for entry points 2 and 4.** For 1 and 3, the prompt is delivered synchronously inside the tool call, in the *same* turn. The agent does its work, the turn ends, `agent_settled` fires — and `handleJustTransitioned` swallows that settle as if it were the prompt-delivery settle. **The work settle is dropped: no gate, no commit, no advance.**
- `fix-session-restart` (`internal/done-fix-session-restart.md:16,110`) made this flag "the resume trigger" and declared `index.ts:73` "the single consumption point." That declaration is only correct for the settle-path entry (4); it silently reclassified the work settles of entry points 1 and 3 as consumption points.
- **Observed bug (runtime evidence, session `01a0ba95`, 2026-09-19):** spec `fix-phase0-scanner-noise` ran Phase 0 → A → negotiate → B. At 17:46:24 the Tester's `negotiate_review(approve)` of the contract re-review fired entry point 1 (`resetForPhaseB`), committing `phase=B, justTransitioned=true` (loop-state entry 17:46:24.818Z). The Writer implemented the fix (S2-S4 in `src/reviewer.ts` + `src/commands/loop.ts`), ran the full suite (1691/1691 passing) and `tsc --noEmit` (clean), and summarized at 18:05:23.826Z (`stopReason: stop`). At 18:05:23.827Z `agent_settled` fired; the **only** log line after the 17:50 compaction is:
  ```
  agent_settled: justTransitioned → clearing (no second prompt — the advance effect already sent it) (Phase B round 1)
  ```
  No gate log, no `Gate fail`/`Gate pass`, no second loop-state commit, no Phase C prompt. The session file ends at that entry. The Writer's work was complete and green — and the loop stalled in Phase B with nothing to do but wait.
- Note: `src/tools/dispute.ts:58,93` already *partially* treats this correctly — the Writer-concede and dispute-filed paths clear the flag in-tool because "the Writer did work after transition — the gate must run after resolution." The same reasoning applies to *any* work done after an entry-point 1/3 transition, but the settle path doesn't know which entry point set the flag.

## Target

After: a settle that follows **work** done after a tool/command-triggered advance (entry points 1 and 3) runs the gate and commits normally — the flag is cleared but does not swallow the settle. A settle that follows the **prompt-delivery** turn of a settle-path advance (entry point 4 — the Writer's first turn after `advanceToPhaseB`) is still consumed (cleared, no gate) exactly as today, because that turn delivered no work — it received the prompt. Reload-resume behavior (flag set pre-reload, `before_agent_start` resume branch, `src/events/before-agent.ts:59`) is unchanged: the resume prompt is delivered, the agent works, and the *work* settle after a resumed tool-triggered advance runs the gate (see S2); the work settle after a resumed settle-path advance is consumed (no gate), matching the no-reload behavior.

## Interface

- **No signature changes.** `handleAgentSettled` (`src/events/agent-settled/index.ts:85`), `handleJustTransitioned` (index.ts:66), `handleBeforeAgent` (`src/events/before-agent.ts:44`), `resetForPhaseB` (`src/tools/state-io.ts:32`), `executeNegotiateReReview` (`src/tools/negotiate.ts:162`), `advanceToPhaseB` (`src/transitions.ts:291`) — all unchanged.
- **One new persisted boolean** on `LoopState`: `justTransitionedBySettle: boolean` — true iff the flag was set by a **settle-path** advance (entry point 4) or the `/loop-patch` command (entry point 2, whose prompt is a re-entry prompt — its first settle is a prompt-delivery settle and must be consumed, same as entry point 4). it is **optional** in the validator (S4: `{ type: "boolean", optional: true }` + heal in `clearTransientFlags`), so pre-fix saved entries without the field still validate — no migration, no quarantine.

## Behavior

### S1 — Mark the settle-path entry points

- `src/transitions.ts:290` `advanceToPhaseB`: add `justTransitionedBySettle: true` to the returned state (next to `justTransitioned: true` at line 296).
- `src/commands/patch.ts:95`: add `state.current.justTransitionedBySettle = true;` next to the existing `justTransitioned = true`. (Note: `/loop-patch` delivers its re-entry prompt synchronously — `sendPrompt` at patch.ts:102-109 — so its delivery timing matches entry points 1/3. It is marked `true` (consumed) because that prompt is a *re-entry* prompt: the settle that follows it is a prompt-delivery settle, and consuming it is the pinned semantics. The marker, not the delivery timing, is what S2 reads.)
- `src/tools/state-io.ts:35` `resetForPhaseB` and `src/tools/negotiate.ts:172` `executeNegotiateReReview`: set **neither** marker — `justTransitionedBySettle` stays `false` (it is reset to `false` by `resetPhaseState` where applicable and initialized `false` at `src/commands/loop.ts:34`).

### S2 — Settle consumption only for settle-path flags

`handleJustTransitioned` (`src/events/agent-settled/index.ts:65-80`) becomes:

```ts
if (!state.current.justTransitioned) return false;
if (!state.current.justTransitionedBySettle) {
  debug(`agent_settled: justTransitioned (tool-triggered) → clearing, gate runs (work settle) (${stateSummary(state.current)})`);
  state.current.justTransitioned = false;
  return false; // continue the pipeline: dispute handlers, then the gate
}
debug(`agent_settled: justTransitioned → clearing (no second prompt — the advance effect already sent it) (${stateSummary(state.current)})`);
state.current.justTransitioned = false;
state.current.justTransitionedBySettle = false;
return true; // consumed: the prompt-delivery settle, no gate
```

- The existing debug line for the consumed case is **byte-identical** (existing tests pin it: `test/events/agent-settled/index.test.ts:224`).
- The consumed-case commit is unchanged: the dispatcher's `handlePhaseSettled` commit point does not run for a consumed settle (it returns before reaching it) — same as today. The tool-triggered case falls through to `handlePhaseSettled`, whose commit point #2 (index.ts:179) persists the cleared flag + gate outcome.

### S3 — Reload-resume composition

- `clearTransientFlags` (`src/events/session-start.ts:84-99`) stays: `justTransitioned` is deliberately not cleared (resume trigger); `justTransitionedBySettle` is likewise **not cleared** (it must survive restore so the post-resume settle consumes or gates correctly).
- `buildResumePrompt` / `handleBeforeAgent` (`src/events/before-agent.ts:59,85-100`): unchanged — the resume branch reads only `justTransitioned`.
- Post-resume settle semantics (pinned): after a reload, the resumed turn's settle sees the same flag pair as the no-reload flow would at that point — tool-triggered → gate runs; settle-path → consumed. Identical to the no-reload behavior at the same lifecycle position.

### S4 — Validator, heal, and initial state

- `src/state-validation.ts`: `justTransitionedBySettle: { type: "boolean", optional: true }` — **optional**, not required. Pre-fix saved entries (written between `46236a4` and this fix) lack the field; making it required would quarantine mid-loop upgrades (the exact failure class logged in `internal/fix-phase0-scanner-noise.md` F3).
- `clearTransientFlags` heals absent → `false` (same precedent as `negotiateProposed` at session-start.ts:91-93): `s.justTransitionedBySettle = false;` — a pre-fix entry saved with `justTransitioned: true` (a tool-triggered advance, the common case) resumes, the agent works, and the work settle **runs the gate** (healed `false` → tool-triggered semantics). This is the correct behavior for the entry points 1/3 states that pre-fix entries can actually hold; the one pre-fix state it treats differently is a settle-path advance saved with `justTransitioned: true` (entry point 4, pre-fix), which would now gate instead of being consumed — harmless: the gate re-verifies work that is already verified, and the flag is cleared either way.
- `src/commands/loop.ts:34` (initial state) and `src/state-helpers.ts` `resetPhaseState` (lines 13-21): add `justTransitionedBySettle: false`.

### Q — Quirks / non-goals

- **Q1:** The dispute in-tool clears (`src/tools/dispute.ts:58,93`) are untouched — they already implement the correct semantics (clear the flag so the gate runs after resolution) and compose with S2: after a concede, `justTransitioned` is false, so `handleJustTransitioned` is a no-op and the gate runs.
- **Q2:** `justTransitionedBySettle` is always cleared *together with* `justTransitioned` in the consumed case (S2) and is `false` whenever `justTransitioned` is false in every other path (resetPhaseState, initial state, heal). The pair is a single logical signal; no code path reads `justTransitionedBySettle` when `justTransitioned` is false. **The S2 tool-triggered branch deliberately does NOT clear the marker** — it relies on this pair invariant: the next path that sets `justTransitioned = true` (an entry point) writes the marker fresh, and every path that clears `justTransitioned` either clears the marker (consumed case) or leaves it `false` (dispute clears, resetPhaseState, heal). Pinned by test: a state with `justTransitioned: true, justTransitionedBySettle: true` (a saved settle-path flag) is consumed; a state with `justTransitioned: true, justTransitionedBySettle: false` runs the gate — a stale-true marker cannot arise because no path sets `justTransitioned` without writing the marker.
- **Q3:** The ESC'd-turn case (comment index.ts:75-78: "an ESC'd phase turn does NOT re-deliver the prompt — the user runs /loop-continue") is unchanged for settle-path advances: the consumed settle still does nothing. For tool-triggered advances, an ESC'd work turn leaves `justTransitioned` **cleared** — the S2 tool-triggered branch clears it before running the gate — so the next `/loop-continue` delivers the full entry prompt via `resetPhaseState`. No behavior regression: before this fix, an ESC'd tool-triggered work turn also left the flag cleared (the swallowed settle cleared it); the difference is only that the gate ran first.
- **Q4:** `turnsThisPhase` and the loop-escalation counter (dispatcher step 3, `checkLoopEscalation`) are untouched. A tool-triggered work settle that now runs the gate also increments the counter exactly as any work settle does — no new escalation risk: the counter was already incremented on the turn's `turn_start` bookkeeping, not on the settle.
- **Q5:** The Phase C stall in session 01a0ba95 is *recovered*, not re-run: after this fix lands, a reload restores `phase=B, justTransitioned=true, justTransitionedBySettle` (healed `false`) → resume prompt → Writer continues (work is on disk, suite green) → work settle → gate → Phase C. No re-implementation.

## Inventory

| File | Action |
|------|--------|
| `src/types.ts` | **Modify** — add `justTransitionedBySettle: boolean` to `LoopState` (line ~29, next to `justTransitioned`). |
| `src/transitions.ts` | **Modify** — `advanceToPhaseB` (line 290): add the marker (1 line). |
| `src/commands/patch.ts` | **Modify** — line 95 area: set the marker (1 line). |
| `src/commands/loop.ts` | **Modify** — initial state (line 34): `justTransitionedBySettle: false` (1 line). |
| `src/state-helpers.ts` | **Modify** — `resetPhaseState` (lines 13-21): `state.justTransitionedBySettle = false;` (1 line). |
| `src/state-validation.ts` | **Modify** — `justTransitionedBySettle: { type: "boolean", optional: true }` (1 line). |
| `src/events/session-start.ts` | **Modify** — `clearTransientFlags`: heal absent → `false` (1 line + comment). |
| `src/events/agent-settled/index.ts` | **Modify** — `handleJustTransitioned` (lines 65-80): the S2 branch (≈6 lines). |
| `test/events/agent-settled/index.test.ts` | **Modify** — existing step-4 tests: states with `justTransitioned: true` now need `justTransitionedBySettle: true` to keep the consumed-case assertions; add the new tool-triggered work-settle tests (below). |
| `test/fix-just-transitioned-settle-drop.ts` | **Create** — regression fixture: the 01a0ba95 sequence (negotiate→B via entry point 1, Writer works, settle → gate runs, advances to C; flag cleared; no prompt re-delivery). |
| `test/events/before-agent.test.ts` | **Modify** — heal test: restored pre-fix entry (`justTransitioned: true`, field absent) → resume prompt delivered, post-work settle runs the gate. |
| `internal/fix-phase0-scanner-noise.md` | **Modify** — F3 note: the quarantine concern is moot for this field (optional + heal); F3 remains open for any *required* field added in the future. |

## Test Strategy

1. **Consumed case unchanged:** `justTransitioned: true, justTransitionedBySettle: true` (any phase/round) → handled, both flags cleared, no gate, no message, byte-identical debug line (existing tests, updated states). **Pinned default:** every `makeState()` factory in the agent-settled test files gets `justTransitionedBySettle: false` as its default (matching the initial state), so unlisted tests keep the tool-triggered semantics unless they explicitly set the marker.
2. **Tool-triggered work settle (the fix):** `phase=B, justTransitioned: true, justTransitionedBySettle: false` → `handleAgentSettled` continues to the gate: `runGates` called, `justTransitioned` cleared, gate outcome applied (advance to C on green gate), commit point #2 runs.
3. **Regression fixture (01a0ba95):** the exact session sequence as a unit test — entry-point-1 transition (`transitionToPhaseB`), a work turn (no tool calls), settle → assert gate ran, phase C, flags cleared, no `sendPrompt` call. (Unit; the gate is mocked per the test-speed rule — no real vitest spawn.)
4. **Heal:** `clearTransientFlags` on a pre-fix entry (field absent, `justTransitioned: true`) → `justTransitionedBySettle === false`; validator accepts the absent field.
5. **Settle-path marker set:** `advanceToPhaseB` output carries `justTransitionedBySettle: true`; `/loop-patch` sets it; `resetForPhaseB` and `executeNegotiateReReview` do not. **Contradictory saved state pinned:** a restored entry with `justTransitioned: true, justTransitionedBySettle: true` (settle-path flag, pre-fix or post-fix) is *consumed* on the next settle — the marker wins; this is the resume-after-reload case for entry point 4 and must not gate.
6. **No prompt double-delivery:** tool-triggered advance → settle consumed-and-gated → next turn's `before_agent_start` delivers the **normal** Phase C entry prompt (flag false), not the resume prompt.
7. Run `npx tsc --noEmit`; run `npx vitest run` — all green (baseline 1691 as of the 01a0ba95 Phase B run).

## Scope lines

- **IN:** the 8 src files above, the 3 test files, the F3 doc note.
- **OUT:** redesigning the flag into a richer "pending prompt" token; touching the dispute in-tool clears; changing `buildResumePrompt`; the Phase 0 findings-count delta in 01a0ba95 (13 vs 5 — separate investigation, the S1 framing line may be self-scanning); committing the in-flight 01a0ba95 work (that is the loop's job once this fix lands and the session resumes).

## Acceptance Criteria

1. Test Strategy items 1-6 all pass. (hard)
2. `npx tsc --noEmit` clean; `npx vitest run` all green. (hard)
3. A reload of a session in the 01a0ba95 end-state (Phase B, work done, `justTransitioned: true`, marker absent) resumes, the work settle runs the gate, and the loop advances to Phase C without re-implementation. (hard — verified by running the actual session, not just the unit fixture)
4. `internal/done-fix-session-restart.md` gains a one-line addendum: "the single-consumption-point declaration (line 110) was incomplete — tool-triggered entry points 1/3 work settles are gated, not consumed; see `done-fix-just-transitioned-settle-drop.md`." (hard)
5. `src/events/agent-settled/index.ts` `handleJustTransitioned` stays under 25 lines (soft — it is ~16 lines as of writing).

## Dependencies

None. Pure state-flag semantics change. Independent of `bug-dispute-fix-redundant-turn.md`, `bug-role-context-mismatch.md`, and the Phase 0 findings-count delta.

## Findings log

- **F1 (accepted, verified):** 01a0ba95 Phase B stall — the settle at 18:05:23.827Z was consumed by `handleJustTransitioned` (single debug line, no gate, no commit, session ends). Entry point 1 set the flag at 17:46:24.818Z. Source: session JSONL + extract-session.sh, inspected 2026-09-19.
- **F2 (accepted, verified):** `done-fix-session-restart.md:16,110` declared index.ts:73 "the single consumption point" without distinguishing entry points — the spec's Q3 reasoned about double *delivery*, not swallowed *work settles*. The 4-set-point/3-clear-point inventory (line 110) listed the set points but not their prompt-delivery timing, which is the discriminating property.
- **F3 (accepted):** the pre-fix `justTransitioned` quarantine concern (logged in `fix-phase0-scanner-noise.md` F3) does not apply to the new field — it is optional + healed. The quarantine concern remains valid for any future *required* field.
- **F4 (flagged, unverified):** 01a0ba95 Phase 0 reported 13 findings (vs 5 in 01a0b7de for a similar-sized spec) — possibly the S1 framing line or the spec's own regex examples self-scanning. Separate investigation; out of scope here.
