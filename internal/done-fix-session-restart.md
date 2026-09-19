# fix-session-restart

## Problem

Verified current state as of writing (2026-09-16):

- On session reload, `handleSessionStart` (`src/events/session-start.ts:101-130`) restores `state.current` from the last `loop-state` entry (`findLastLoopState`, line 41-43), validates it (`restoreState`, line 132-158), clears transient flags (`clearTransientFlags`, lines 82-99), and sets UI status. It has **no "resume" path**: after restore, the next `before_agent_start` delivers the same phase-entry prompt the agent got at phase start.
- `handleBeforeAgent` (`src/events/before-agent.ts:36-51`) always dispatches to `buildPhasePrompt` (line 53-73) — a 5-case switch (review/A/negotiate/B/C) plus explicit terminal rows (done/escalated → `undefined`) and a defensive default. There is no distinction between first entry and mid-phase reload.
- `turnsThisPhase` is **not** a usable mid-phase signal: it is incremented in-memory at `src/events/agent-settled/index.ts:43` (`checkLoopEscalation`), but the single-commit-point design (comment at lines 46-49: "No commit here: the single commit point is the end of handlePhaseSettled, AFTER the retry effect has reset turnsThisPhase") means the persisted value mid-phase is always 1 — the retry effect resets it to 1 (`src/events/agent-settled/effect-applicator.ts:80`), and the end-of-settle commit (index.ts:179) persists that 1.
- The in-memory flag `justTransitioned` already distinguishes "prompt was just delivered, agent has not done work yet" from "agent is mid-work": it is set at exactly 4 entry points — `src/tools/state-io.ts:35` (`resetForPhaseB`, negotiate→B), `src/commands/patch.ts:95` (`/loop-patch`), `src/tools/negotiate.ts:172` (`executeNegotiateReReview`), `src/transitions.ts:296` (`advanceToPhaseB`, the settle-path B advance) — and cleared at 3 places: `src/events/agent-settled/index.ts:73` (first settle after transition), `src/tools/dispute.ts:58,93` (dispute interrupts). It is persisted in the `loop-state` entry (`src/state-validation.ts:45` — required boolean field, so every saved entry carries it). **But `clearTransientFlags` (`src/events/session-start.ts:85`) unconditionally zeroes it on restore — destroying the signal before `before_agent_start` can read it.**
- **Observed bug (runtime evidence):** session `01a011fa` (`~/.pi/agent/sessions/--Users-alancapps-.pi-agent-extensions-loop-go-bak--/2026-08-17T23-06-44-955Z_01a011fa-335b-74d9-a96c-526a97eaee0a.jsonl`, extracted via `scripts/extract-session.sh 01a011fa`): 04:08:07 `Gate fail (33 failures)` → `Advance → negotiate` → advance prompt `WRITER (negotiation).` delivered; 04:27:19 reload — `session_start: restored → Phase A round 1`; 04:30:01 compaction; 04:31:10 the full Phase A entry prompt re-delivered (`[USER] You are the TESTER. Write contract tests.` + `Read internal/09-wire-dispute-review.md...`), and the Tester re-read the spec and re-derived the contract (04:32:40 `read` of the spec). Phase A ran to 04:45 (gate fail, 26 failures) — ~40 min of re-derivation.
- Baseline: `npx vitest run` → 60 files, 1647 tests, all passing (as of writing); `npx tsc --noEmit` clean.

## Target

After: a reload mid-phase delivers a **resume** prompt (role + round + "work is already on disk, continue — do not re-read the spec / do not rewrite from scratch") instead of the full phase-entry prompt. First-entry behavior is byte-identical to today. The `justTransitioned` flag becomes the resume trigger: it survives restore (no longer zeroed), `before_agent_start` reads it as the sole branch input, and the settle handler's existing clear (index.ts:73) becomes the single consumption point. No persisted-shape change: the flag already exists in every saved entry.

## Interface

- **No signature changes.** `handleSessionStart(input: SessionStartHandlerInput): void` (`src/events/session-start.ts:101`), `handleBeforeAgent(input: BeforeAgentHandlerInput): BeforeAgentHandlerOutput | undefined` (`src/events/before-agent.ts:36`), `clearTransientFlags(s: LoopState): void` (non-exported, `src/events/session-start.ts:82`) — all unchanged.
- `BeforeAgentHandlerOutput` shape unchanged: `{ message: Record<string, unknown>, systemPrompt: string }` (`src/events/before-agent.ts:24-27`). The resume branch returns the same shape, built by a new non-exported helper in `src/events/before-agent.ts`.
- **Persisted state:** the saved `loop-state` entry is the flat `LoopState` (`src/commit.ts:40` — `api.appendEntry("loop-state", { ...state })`). `justTransitioned` is a **required boolean** in the validator's `FIELD_SPECS` (`src/state-validation.ts:45`), so every entry written since the flat-state refactor carries it — no migration, no optional-field extension needed. Restore path: `findLastLoopState` → `validateLoopState` → `migrateDispute` → `clearTransientFlags` (`src/events/session-start.ts:132-158`). Compatibility: pre-existing saved entries are unchanged in shape; the only behavior change is that `clearTransientFlags` no longer rewrites `justTransitioned` (line 85 deleted). An entry saved with `justTransitioned: true` (the 4 set points listed in Problem) now resumes; one saved with `false` (every mid-work commit — see Problem: the settle handler clears it at index.ts:73 before commit point #2, index.ts:179) gets the normal entry prompt, exactly as today.

## Behavior

### Decision table — `handleBeforeAgent` (first-match-wins, pinned order)

| # | Condition (evaluated in this order) | Returns |
|---|---|---|
| 1 | `s.phase === "idle"` | `undefined` (unchanged — before any lang resolution; S1) |
| 2 | `s.justTransitioned === true` (any non-idle phase) | resume output (new) |
| 3 | lang resolution `getLanguageConfig(s.language)` — may throw `Language not available: ${key}` for every non-idle phase (R4, unchanged) | — |
| 4 | `buildPhasePrompt` switch — review / A / negotiate / B / C / done / escalated / default, exactly as today (`src/events/before-agent.ts:53-73`) | unchanged |

**Pin (F — order matters):** row 2 sits AFTER the idle short-circuit and BEFORE `getLanguageConfig`. Idle never inspects the flag; a corrupted language still throws for every non-idle phase, flag included (the resume branch never touches `lang`).

### Decision table — `clearTransientFlags` (post-change)

| Field | Before | After |
|---|---|---|
| `justTransitioned` | `false` (line 85) | **untouched** |
| `negotiateReprompted` | `false` | unchanged |
| `negotiateProposed` | `false` (heal) | unchanged |
| `negotiateFeedback` | `""` (heal) | unchanged |
| `dispute` | untouched (heal to `{ status: "none" }` if absent) | unchanged |

### Resume prompt (new — verbatim, language-agnostic, `src/events/before-agent.ts`)

Message content (built by `buildContextMessage`, same `{ customType: "loop-context", content, display: false }` envelope as every other prompt, `src/events/before-agent.ts:77-79`):

```
RELOAD. You are mid-phase: Phase ${s.phase}, round ${s.round}.
Your previous turn's work is already on disk — continue from where you stopped.
Do not re-read the spec, re-derive the contract, or rewrite files from scratch.
${roleLine(s.phase)}
Stop when done.
```

`roleLine` per phase (the last phase is `C`):

| phase | roleLine |
|---|---|
| `review` | `Role: Reviewer (Phase 0). Use negotiate_propose or negotiate_review.` |
| `A` | `Role: Tester. Write *_test.go-style contract tests only.` — NO: language-agnostic, verbatim: `Role: Tester. Continue writing the contract tests.` |
| `negotiate` | `Role: Negotiator. Use negotiate_propose / negotiate_review.` |
| `B` | `Role: Writer. Continue implementing to pass the tests.` |
| `C` | `Role: Cleaner. Continue refactoring. All tests must pass.` |

(Exact strings the implementer pins: the `A` row above is `Role: Tester. Continue writing the contract tests.` — the "*_test.go-style" variant above is a drafting artifact and must NOT appear.)

systemPrompt: `${systemPrompt}\n\nSession reloaded mid-phase. Continue the current phase — do not restart it.`

Debug (exactly one call, before returning): `before_agent_start: resume prompt (Phase ${s.phase} round ${s.round})`.

### Side-effect contract (new branch)

- No `commit` / `appendEntry` — the settle handler's existing clear+commit (index.ts:73 → commit point #2, index.ts:179) is the single persistence point, matching the existing "no side effects in review/A/C branches" contract (`test/events/before-agent.test.ts` "persists no session entries in any non-dispute-fix branch").
- No state mutation. The flag is consumed only at the next settle.
- `ctx.ui` untouched (session-start already set the status at restore).

### Quirks (current behavior, do not fix)

- Q1: `commit()` persists even when validation fails (`src/commit.ts:29-34`) — a broken state is recoverable via quarantine-on-restore. Unchanged.
- Q2: `migrateDispute` is one-directional and drops the 6 flat dispute fields (`src/events/session-start.ts:47-80`). Unchanged.
- Q3: The dispute-fix branch in `buildWriterPrompt` (B + `dispute.status === "conceded"` + `filer === "writer"`) mutates state and commits inside `handleBeforeAgent` (`src/events/before-agent.ts:155-168`). Unchanged; it is reached only when `justTransitioned` is false (row 3), so it composes with the new row 2 without interaction — pin a test asserting a B state with BOTH `justTransitioned: true` and the conceded-dispute shape takes row 2 (resume), not the dispute-fix branch.
- Q4: `promptTesterPhaseARestart` is byte-identical to `promptTesterPhaseA` in all 3 languages (`src/languages/go.ts:32-46, java.ts:29-44, typescript.ts:28-43`; asserted in `test/prompts.test.ts:21,53,72`). It is a dead prompt as far as reloads are concerned — used only by `/loop-restart` (`src/commands/status.ts:55`). Not touched by this change.
- Q5: The stale bug note `internal/bug-phase-restart-on-reload.md` cites `buildRestartPrompt` at `src/events/before-agent.ts:60-64` — that function lives in `src/commands/status.ts:51`; the before-agent handler never called it. The note's *proposed* fix (persist `turnsUsed`/`lastAction` checkpoint) is superseded by this spec: `turnsThisPhase` is pinned unreliable (Problem) and `justTransitioned` already exists. The bug note is left as-is (historical record) — no doc edit in this unit.

### Intended shifts (before → after; accepted, not quirks)

- S1: A reload landing right after a prompt delivery (saved `justTransitioned: true` — all 4 set points) now gets the **resume** prompt instead of the full entry prompt. Before: full entry prompt (re-derivation, the observed bug). This is the fix.
- S2: `/loop-continue` and `/loop-restart` (`src/commands/status.ts:103-131, 150-165`) call `resetPhaseState` (`src/state-helpers.ts:13-21`), which sets `justTransitioned: false` — so a human-initiated restart still delivers the full entry prompt. Before/after identical for humans; only machine reloads change.
- S3: The settle handler's existing `handleJustTransitioned` debug line (`src/events/agent-settled/index.ts:72` — `agent_settled: justTransitioned → clearing (no second prompt — ...)`) now also covers the reload-resume case (flag set pre-reload, consumed post-reload). No code change; the comment at index.ts:75-78 ("an ESC'd phase turn does NOT re-deliver the prompt — the user runs /loop-continue") stays true.

### Ownership

| Behavior | Module | Asserting test file |
|---|---|---|
| Flag survives restore | `src/events/session-start.ts` (`clearTransientFlags`) | `test/events/session-start-wiring.test.ts` (rewrite) + `test/events/session-start.test.ts` (new) |
| Resume branch + strings + order | `src/events/before-agent.ts` | `test/events/before-agent.test.ts` (new) |
| Flag consumed at settle (unchanged) | `src/events/agent-settled/index.ts` | `test/events/agent-settled/index.test.ts` (kept) |
| Validator accepts the flag (unchanged) | `src/state-validation.ts` | `test/state-validation.test.ts` (kept) |

## Inventory

- **Files touched (3):** `src/events/session-start.ts` (delete line 85 `s.justTransitioned = false;` + update the surrounding comment block at lines 82-99), `src/events/before-agent.ts` (new `buildResumePrompt` helper + row-2 branch in `handleBeforeAgent`), `test/events/before-agent.test.ts` + `test/events/session-start-wiring.test.ts` + `test/events/session-start.test.ts` (test updates below). **No other file changes.**
- **Imports:** zero added/removed in all touched files — `buildResumePrompt` uses only `LoopState` (already imported, `src/events/before-agent.ts:10`) and `buildContextMessage` (same file).
- **Call sites of `clearTransientFlags`:** exactly 1 — `restoreState` at `src/events/session-start.ts:156` (grep: `grep -rn "clearTransientFlags" src/` → 2 hits: definition line 82, call line 156; closed).
- **Call sites of `handleBeforeAgent`:** exactly 1 — `eventBeforeAgentStart` at `src/events/index.ts:51` (closed).
- **Set points of `justTransitioned` (4, closed):** `src/tools/state-io.ts:35`, `src/commands/patch.ts:95`, `src/tools/negotiate.ts:172`, `src/transitions.ts:296`. **Clear points (3, closed):** `src/events/agent-settled/index.ts:73`, `src/tools/dispute.ts:58`, `src/tools/dispute.ts:93`. **Restore zeroing (1, deleted by this change):** `src/events/session-start.ts:85`. **Initial-state writes (2, closed):** `src/commands/loop.ts:35` (`false`), `src/state-helpers.ts:18` (`resetPhaseState`, `false`).
- **Exports:** none added. `buildResumePrompt` is non-exported (same pattern as `buildPhasePrompt`).

## Test Strategy

- **Baseline:** 1647/1647 passing across 60 files (as of writing). No stub-era tests in the touched files — `test/events/session-start.test.ts` and `test/events/before-agent.test.ts` assert live behavior.
- **Per-test dispositions (flip count: 1 rewritten, 0 removed):**
  - `test/events/session-start-wiring.test.ts` — 23 of 24 kept unchanged. **1 rewritten:** "clears transient flags and preserves persistent fields" (line 174) — old assertion `expect(state.current.justTransitioned).toBe(false)` (line 188) → new assertion `expect(state.current.justTransitioned).toBe(true)` (the fixture saves `justTransitioned: true`, line 183, and the flag now survives). Every other assertion in that test (dispute preserved, `negotiateReprompted` cleared, persistent fields intact) is unchanged.
  - `test/events/before-agent.test.ts` — all 25 kept (see below why none flip).
  - `test/events/session-start.test.ts` — all 10 kept; 1 new test added (below).
  - `test/events/agent-settled/index.test.ts`, `test/state-validation.test.ts` — untouched. `test/state-commit.test.ts` and `test/extension.test.ts` — **2 tests each updated** (post-implementation correction, surfaced via Writer dispute in session 01a0b7de): their restore fixtures save `justTransitioned: true` and asserted the old zero-on-restore behavior, so the flag now survives in the snapshots. The spec's "0 flips" prediction below is superseded by this outcome.
    - ~~`test/state-commit.test.ts` — untouched (…as of writing, its fixtures at lines 184-200 save `justTransitioned: false` or do not assert the field, so 0 flips).~~
  - `test/prompts.test.ts` — untouched (Q4: `promptTesterPhaseARestart` delegation is a language-config concern, not touched here).
- **New tests (one per newly pinned behavior):**
  1. `test/events/before-agent.test.ts` — "justTransitioned → resume prompt, all 5 non-idle phases": for each of review/A/negotiate/B/C, `makeState({ phase, justTransitioned: true })` → exact `toEqual` on `{ message: { customType: "loop-context", content: <resume content verbatim with phase+round>, display: false }, systemPrompt: <resume SP verbatim> }`. Round interpolated: use round 3 for B to pin interpolation.
  2. `test/events/before-agent.test.ts` — "resume branch order: idle + justTransitioned → undefined (row 1 wins)": `makeState({ phase: "idle", justTransitioned: true })` → `undefined`, no throw.
  3. `test/events/before-agent.test.ts` — "resume branch before lang resolution: justTransitioned + corrupted language → resume output, no throw": `makeState({ phase: "A", justTransitioned: true, language: "bogus" })` → resume output (proves row 2 precedes row 3).
  4. `test/events/before-agent.test.ts` — "justTransitioned + B + conceded dispute → resume (row 2 wins over dispute-fix)": `makeState({ phase: "B", round: 3, justTransitioned: true, dispute: { status: "conceded", filer: "writer" } })` → resume output; `pi.appendedEntries` empty (no commit — Q3 pin).
  5. `test/events/before-agent.test.ts` — "resume branch debug line": exactly one debug call, `before_agent_start: resume prompt (Phase B round 3)`; and "no debug calls" stays true for the 5 non-resume paths (existing F6 test at line 265 keeps its 3 phases; extend its phase list? NO — kept unchanged; the resume debug is pinned only in test 4/5 where the branch fires).
  6. `test/events/before-agent.test.ts` — "resume branch mutates nothing, persists nothing": structuredClone before/after equality + `pi.appendedEntries` empty, for one representative phase (A).
  7. `test/events/session-start.test.ts` — "restore preserves justTransitioned=true (resume survives reload)": saved entry with `justTransitioned: true` → `state.current.justTransitioned === true` after `handleSessionStart`.
  8. `test/events/session-start-wiring.test.ts` — end-to-end: "factory restores with justTransitioned=true and the next handleBeforeAgent call returns the resume prompt": register via `eventSessionStart` + `eventBeforeAgentStart` (the existing end-to-end test at line 332 is the pattern), assert the before-agent output content starts with `RELOAD. You are mid-phase: Phase A, round 1.`.
- **Why existing before-agent tests don't flip:** every fixture in `makeState` (`test/events/before-agent.test.ts:81-104`) omits `justTransitioned` (→ `undefined` ≠ `true`), so row 2 never fires in the existing 25 tests. The branch condition is `=== true`, never truthiness — pin that in test 1's comment.
- **Live-toolchain rules:** N/A — no test in this unit spawns a real tool (all assertions are on prompt strings, state fields, and mock `pi`/`ctx` objects). No fixture buildability / tool-absence / timeout / verdict concerns.

## Scope lines

- `src/events/session-start.ts`: line 85 (`s.justTransitioned = false;`) **removed**; the comment block at lines 82-99 **edited** to state `justTransitioned` is deliberately NOT cleared (resume trigger, consumed at the settle); everything else **kept** (migration, quarantine, heal lines 86-98, debug/status lines 155-158).
- `src/events/before-agent.ts`: row-2 branch **added** in `handleBeforeAgent` between the idle return (line 48) and `getLanguageConfig` (line 49); `buildResumePrompt(state: LoopState, systemPrompt: string): BeforeAgentHandlerOutput` **added** (non-exported); the file header comment **edited** to document the resume path; everything else **kept** verbatim (all 8 prompt builders, dispatch switch, dispute-fix branch).
- `test/events/before-agent.test.ts`: 6 new tests **added** (above 1-6); 25 existing **kept** unchanged.
- `test/events/session-start-wiring.test.ts`: 1 test **rewritten** (assertion flip, above); 23 **kept**; 1 new end-to-end test **added** (above 8).
- `test/events/session-start.test.ts`: 10 **kept**; 1 new **added** (above 7).
- All other files: **kept** (enforced by the grep sweeps below — no other file may change).

## Acceptance Criteria

1. `npx vitest run` — all 60+ files green, including the rewritten/new tests (checker: test run; ~1656 tests).
2. `npx tsc --noEmit` clean (checker: type-checker — the vitest run does not type-check; this sees the new helper's signature).
3. Grep sweep (functional): `grep -rn "s.justTransitioned = false" src/events/session-start.ts` → 0 hits; `grep -rn "clearTransientFlags" src/` → exactly 2 hits (definition + the one call at restoreState) (checker: grep).
4. Grep sweep (textual): `grep -rn "justTransitioned" src/events/before-agent.ts` → ≥ 2 hits (the branch + a comment); `grep -c "RELOAD. You are mid-phase" src/events/before-agent.ts` → exactly 1 (checker: grep — the resume string exists in exactly one place).
5. Verbatim pin: the resume message in `test/events/before-agent.test.ts` matches the spec's strings character-for-character, including `RELOAD. You are mid-phase: Phase ${s.phase}, round ${s.round}.` and `Stop when done.` (checker: the 5-phase `toEqual` test, criterion 1).
6. First-entry regression: the 25 pre-existing `test/events/before-agent.test.ts` tests pass unchanged — byte-identical entry prompts (checker: test run + git diff shows no changes to existing test bodies).
7. No other file changed: `git status` lists exactly `src/events/session-start.ts`, `src/events/before-agent.ts`, and the 3 test files (checker: inspection).
8. Quirk preservation: `promptTesterPhaseARestart` still byte-identical to `promptTesterPhaseA` in all 3 languages (checker: `test/prompts.test.ts` lines 21/53/72 pass unchanged).

## Dependencies

- `done-01-wire-session-start.md` (implemented): the `session_start` handler exists in `src/events/session-start.ts` with the `findLastLoopState`/`migrateDispute`/`clearTransientFlags` structure this spec edits.
- `done-03-implement-before-agent-handler.md` (implemented): `handleBeforeAgent`/`buildPhasePrompt` with the S1 entry order (idle → lang → dispatch) that this spec inserts row 2 into.
- `done-refactor-single-commit-point.md` (implemented): `commit()` is the single persistence path and the settle handler is the single commit point — that is why `turnsThisPhase` is pinned unreliable and why this spec uses the already-persisted `justTransitioned` flag instead of a new checkpoint field.
- `done-bug-dispute-reload-evaporation.md` (implemented): the `dispute` object survives restore and redelivers on the next settle — the resume prompt must not disturb that path (Q3 pin).

## Findings log

| # | Severity | Finding | Disposition (accepted/rejected + what was verified + what the spec now pins) |
|---|---|---|---|
| 1 | needs-doc | The bug note `internal/bug-phase-restart-on-reload.md` (line 10) cites `buildRestartPrompt` at `src/events/before-agent.ts:60-64` — that function does not exist in that file; it is at `src/commands/status.ts:51` and is never called from the before-agent handler. The note's proposed fix (persist `turnsUsed`/`lastAction`) is infeasible per the goal's constraint: `turnsThisPhase` is pinned always-1 mid-phase (verified: increment at `src/events/agent-settled/index.ts:43`, no pre-gate commit per the comment at lines 46-49, reset to 1 at `effect-applicator.ts:80/98/154`, commit at index.ts:179). | Accepted as a superseded plan. Verified by reading both files + the single-commit-point comment. The spec pins `justTransitioned` (already persisted, already the "prompt-not-yet-consumed" marker) as the trigger and records the stale citation in quirk Q5. |
| 2 | needs-doc | Session `01a011fa` evidence: the 04:27:19 reload restored `Phase A round 1` even though the 04:08:07 gate had advanced to negotiate (`[STATE] phase=A round=1` is the last loop-state entry before the reload — the advance commit landed, but the restored entry predates it per the extracted log; the spec's own note calls this "anomalous"). Regardless of the anomaly, the restore path has no mid-phase distinction — that is the bug this unit fixes. | Accepted as-is. Verified via `scripts/extract-session.sh 01a011fa` (lines: 04:08:07.303 Gate fail / Advance → negotiate; 04:27:19.530 `restored → Phase A round 1`; 04:31:10.279 full Tester prompt re-delivered; 04:30:01.215 compaction). The spec's Problem section cites these timestamps as the observed artifact. |
| 3 | nit | Drafting artifact: the resume roleLine table in this spec's Behavior section contains a self-correcting line for phase A ("`*_test.go-style` — NO: language-agnostic"). | Accepted; the spec explicitly marks the final verbatim string (`Role: Tester. Continue writing the contract tests.`) and forbids the artifact variant. AC5 pins it. |
