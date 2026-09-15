# fix-advance-effect-dual-path

## Status: open

## Problem

Verified current state as of writing (2026-09-15):

Two independent code paths both apply an **advance** effect (a phase
transition that should deliver the next phase's prompt), and they have
diverged. One sends the prompt; the other does not. This divergence is the
root cause of a loop stall that occurred **twice** in live sessions, and the
first fix addressed the wrong path.

**Path 1 — agent-settled** (`src/events/agent-settled/effect-applicator.ts:93`
`applyAdvanceEffect`): sends the prompt at line 117
(`sendPrompt(pi, buildAdvancePrompt(effect.prompt, state, lang), …)`).
Reached via `applyEffect` → `gate-transition.ts:98` when a gate passes and
the loop advances through the settle handler.

**Path 2 — tool-call** (`src/tools/state-io.ts` `applyTransitionEffect`): reached
via `transitionToPhaseB` (`src/tools/state-io.ts`) when the Writer calls
`negotiate_propose("agree")` or the reviewer calls
`negotiate_review("approve")`. Before this spec's fix it set the UI status
and persisted state but **never sent the prompt**. The `effect.prompt` field
(`ADVANCE_PROMPTS.WRITER_PHASE_B`) was set on the effect but never read.

**Runtime evidence (the stall):** two session logs both stall identically at
the negotiate→B transition:
- `01a0a16d-9b71-77fa-8504-556296801f5c` (2026-09-14) — Writer proposes
  "agree", `transitionToPhaseB` fires, no Phase B prompt is delivered, the
  Writer keeps acting in the negotiate turn, settles, `justTransitioned`
  consumes the settle, the loop stalls.
- `01a0a586-0fc5-7143-8d97-c82dd497a6b4` (2026-09-15) — identical stall.
  Last debug line: `agent_settled: justTransitioned → clearing (no second
  prompt — the advance effect already sent it)` — the code *believes* the
  prompt was sent, but no user message appears in the log.

**Why the first fix was wrong:** the first fix (`d268f72`) added
`prompt: ADVANCE_PROMPTS.WRITER_PHASE_B` to the effect in
`transitionToPhaseB` and handled `WRITER_PHASE_B` in `buildAdvancePrompt`
(`effect-applicator.ts:283`). That made the *prompt builder* correct, but
`applyTransitionEffect` (the tool-call applier) still never called
`sendPrompt`. The agent-settled applier (`applyAdvanceEffect`) does. So the
fix landed on the path that already worked, and the broken path stayed
broken. The second session stalled again.

**The structural smell:** the *same* effect type (`advance`) is applied by
two functions that do different things. `applyAdvanceEffect` does: reset
turns, accumulate metrics, notify, set status, archive spec (if phase C),
send prompt. `applyTransitionEffect` does: persist state, set status, (now)
send prompt. Any future change to "what an advance does" must be made in
two places, and forgetting one is exactly this bug.

**Compounding: a half-finished refactor was on `main`.** The
`refactor-tools-split` work (spec `internal/refactor-tools-split.md`) left
`src/tools/` (6 files, 21 `throw new Error("not implemented")` stubs)
committed to `main` while `src/tools.ts` (559 lines, the live monolith)
remained the file everything imports. `src/tools/` is imported by nothing —
it is dead code that would throw if ever called. This was the intermediate
state a refactor must not leave on the default branch. **Resolved:** the
`refactor-tools-split` is now done — `src/tools.ts` is deleted and
`src/tools/` contains the real modules. The `applyTransitionEffect` that
this spec targets now lives in `src/tools/state-io.ts`.

## Target

One advance-effect applier. The tool-call path and the agent-settled path
both route phase-advance prompts through the same function, so "what an
advance does" is defined in exactly one place. Concretely:

- `applyTransitionEffect` (tool-call) and `applyAdvanceEffect`
  (agent-settled) share a single prompt-delivery helper for advance effects,
  so the prompt send cannot diverge again.
- `src/tools/` is either fully implemented (the `refactor-tools-split`
  destination, with `src/tools.ts` deleted) or fully removed from `main`.
  It is not left as dead stubs.
- A regression test asserts the Phase B prompt is sent on the **tool-call**
  path specifically (not just the agent-settled path), so the next
  "fix the wrong path" is caught by red, not by a live session.

## Interface

No public signature change. The change is internal to the two appliers.

`buildAdvancePrompt(promptType, state, lang): string`
(`src/events/agent-settled/effect-applicator.ts:283`) is the existing single
prompt builder for advance effects; both appliers call it. This spec does
not change its signature. It is already imported by `src/tools/state-io.ts`.

The shared helper this spec introduces:

```
// effect-applicator.ts (agent-settled owns the effect semantics)
export function deliverAdvancePrompt(
  pi: ExtensionAPI,
  state: LoopState,
  lang: LanguageConfig,
  effect: AdvanceEffect,
  debug: (msg: string) => void,
): void
```

Body: `if (effect.prompt) sendPrompt(pi, buildAdvancePrompt(effect.prompt, state, lang), state, debug);`
— i.e. the exact prompt-send logic currently duplicated at
`effect-applicator.ts:117` and `src/tools/state-io.ts` (the ad-hoc block in
`applyTransitionEffect`). Both appliers call it.

Persisted state: unchanged. The advance effect does not change the saved
`loop-state` shape; `justTransitioned`, `phase`, `round`, `turnsThisPhase`
are set by the existing transition code and are not touched here.

## Behavior

Decision table for "who sends the advance prompt" after the change —
first-match-wins, one applier per path:

| Path | Trigger | Prompt sent by |
|---|---|---|
| agent-settled | gate passes → `applyEffect` → `applyAdvanceEffect` | `deliverAdvancePrompt` |
| tool-call | `negotiate_propose("agree")` / `negotiate_review("approve")` → `transitionToPhaseB` → `applyTransitionEffect` | `deliverAdvancePrompt` |

Both rows call the same function; the only difference is the surrounding
side effects (the agent-settled path also accumulates metrics and archives
the spec on phase C; the tool-call path persists state first). The prompt
delivery itself is one line in one place.

Verbatim pins (unchanged strings, pinned so a refactor does not drift them):
- `buildAdvancePrompt` returns `lang.prompts.promptWriterPhaseB(ws)` for
  `ADVANCE_PROMPTS.WRITER_PHASE_B` (`effect-applicator.ts:289-290`).
- Debug strings stay: `applying transition: ${effect.type}` (tool-call),
  `Advance → ${effect.phase}` (agent-settled).

Side-effect contract:
- `deliverAdvancePrompt` calls `sendPrompt` exactly once when
  `effect.prompt` is set, zero times when it is not. `sendPrompt`
  (`src/prompt.ts:33`) is the single delivery point (followUp in interactive
  mode, status file in runner mode). No new `pi.sendUserMessage` call is
  introduced directly.
- No state mutation in `deliverAdvancePrompt` (prompt delivery only).

Quirks (current behavior, do not fix in this spec):
- The agent-settled path's `applyAdvanceEffect` also accumulates live
  metrics and archives the spec on phase C. That is agent-settled-specific
  and is NOT moved into the shared helper. The shared helper is prompt
  delivery only. (If metrics/archival are later wanted on the tool-call
  path, that is a separate intended shift, not this fix.)

Intended shifts:
- Before: the tool-call path sends the Phase B prompt only because of the
  ad-hoc `if (effect.type === "advance" && effect.prompt)` block in
  `src/tools/state-io.ts` (added in `d268f72`/`41c20e0`). After: it sends
  it because it calls the same helper the agent-settled path calls. Removing
  the ad-hoc block and calling `deliverAdvancePrompt` is behavior-preserving
  but removes the divergence risk.

Ownership: `src/events/agent-settled/effect-applicator.ts` owns
`deliverAdvancePrompt` and `buildAdvancePrompt` (effect semantics live with
the effect applicator). `src/tools/state-io.ts` owns `applyTransitionEffect`
(tool-call persistence + status). `test/tools-negotiate-re-review.test.ts`
asserts the tool-call path sends the prompt; `test/events/agent-settled/effect-applicator.test.ts`
asserts the agent-settled path and the `buildAdvancePrompt` mapping.

## Inventory

Files:
- `src/events/agent-settled/effect-applicator.ts` — **keep**; extract the
  prompt-send at line 117 into `export function deliverAdvancePrompt`;
  `applyAdvanceEffect` calls it. `buildAdvancePrompt` (line 283) unchanged.
- `src/tools/state-io.ts` — **keep**; replace the ad-hoc prompt block in
  `applyTransitionEffect` with a call to `deliverAdvancePrompt`; drop the
  now-redundant local `getLanguageConfig` lookup if it becomes unused
  (verify caller count before removing — `state-io.ts` may use it elsewhere).

Imports:
- `src/tools/state-io.ts` already imports `buildAdvancePrompt`; this spec
  changes it to import `deliverAdvancePrompt` instead (or both, if
  `buildAdvancePrompt` is still used elsewhere in `state-io.ts` — verify).
- No new imports in `effect-applicator.ts` (it already has `sendPrompt`,
  `buildAdvancePrompt`, `LanguageConfig`).

Call sites of the advance effect (closed list, grep-proven):
- `src/tools/state-io.ts` — `transitionToPhaseB` → `applyTransitionEffect`
  (tool-call)
- `src/events/agent-settled/gate-transition.ts:98` — `applyEffect` →
  `applyAdvanceEffect` (agent-settled)
- `src/events/agent-settled/effect-applicator.ts:62` — `applyEffect` dispatch
  to `applyAdvanceEffect`

## Test Strategy

Baseline: all tests passing on `main` (the `refactor-tools-split` is done;
the 4 `test/tools-split/structure.test.ts` tests that were red while the
split was in progress now pass).

Per-test disposition:
- `test/tools-negotiate-re-review.test.ts` — **keep + strengthen**. The two
  tests at lines 111-131 already assert `pi.sentMessages[0].content`
  contains "Phase B" on the tool-call path. Keep them. These are the
  regression tests for this bug; they must fail if `deliverAdvancePrompt`
  is not called from `applyTransitionEffect`.
- `test/tools-split/behavior.test.ts:374` — **keep**. Asserts the tool-call
  advance sends the Phase B prompt.
- `test/events/agent-settled/effect-applicator.test.ts` — **keep**. Asserts
  `buildAdvancePrompt` maps `WRITER_PHASE_B` → `promptWriterPhaseB`.

New tests:
- One test that `deliverAdvancePrompt` sends exactly one `sendPrompt` when
  `effect.prompt` is set and zero when it is not (unit the helper directly,
  in `effect-applicator.test.ts`). This pins the helper's contract so the
  two appliers cannot silently diverge.
- One test naming the regression explicitly: "tool-call negotiate→B sends
  the Phase B prompt" that would have been red against the pre-`d268f72`
  code (verify red by temporarily reverting the `applyTransitionEffect`
  prompt block).

Untouched: `src/prompt.ts`, `src/transitions.ts`, all language prompt
modules. They are unchanged because the fix is at the applier layer, not the
delivery or transition layer.

Live-toolchain rules: no test in this spec spawns a real tool. All
assertions are on the mock `ExtensionAPI` (`pi.sentMessages`) and on
`buildAdvancePrompt`'s return value. No class-M risk.

## Scope lines

- `src/events/agent-settled/effect-applicator.ts` — **added**: `deliverAdvancePrompt`;
  **kept**: `applyAdvanceEffect` (now calls the helper), `buildAdvancePrompt`,
  all other effect appliers.
- `src/tools/state-io.ts` — **removed**: the ad-hoc `if (effect.type ===
  "advance" && effect.prompt)` block; **kept**: `applyTransitionEffect`
  (now calls `deliverAdvancePrompt`), everything else.
- `test/events/agent-settled/effect-applicator.test.ts` — **added**: helper
  unit test.
- `test/tools-negotiate-re-review.test.ts` — **kept** (already asserts the
  regression).

## Acceptance Criteria

- Full test run: 0 failing. Checker: `npx vitest run`.
- Type-checker clean. Checker: `npx tsc --noEmit`.
- Grep sweep (functional): `grep -rn "sendPrompt(pi, buildAdvancePrompt"
  src/ --include="*.ts"` returns **0** hits — the prompt send is no longer
  inlined in two places; both appliers call `deliverAdvancePrompt`.
- Regression: the tool-call negotiate→B test
  (`test/tools-negotiate-re-review.test.ts`) fails when the
  `deliverAdvancePrompt` call is removed from `applyTransitionEffect`
  (verify red, then green).
- One criterion per pinned item: the `deliverAdvancePrompt` unit test
  (one send / zero send) passes.

## Dependencies

- `refactor-tools-split.md` (done): the `src/tools/` split is complete.
  This spec's `applyTransitionEffect` now lives in `src/tools/state-io.ts`.
  No overlap remains.
- `d268f72` / `41c20e0` (committed): the ad-hoc prompt fix this spec
  consolidates. This spec does not revert them; it generalizes them.

## Findings log

- F1 (this spec's author): the first fix (`d268f72`) targeted the prompt
  *builder* and the agent-settled applier, not the tool-call applier that
  actually stalled. Verified against both session logs that the stall is the
  tool-call path. Lesson recorded: when a phase transition has two entry
  points, a regression test must exercise the entry point that stalled, not
  just the transition's state change.
- F2: `src/tools/` dead stubs were committed to `main` via a cherry-pick that
  swept in an in-progress branch's working tree. Lesson recorded: a commit
  that mixes a bug fix with a half-finished refactor is how dead code lands
  on the default branch; the fix and the refactor need separate commits.
