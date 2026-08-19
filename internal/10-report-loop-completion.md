# report-loop-completion

## Problem

Verified current state as of writing:

- `applyDoneEffect` (`src/events/agent-settled/effect-applicator.ts:114-123`) destructures `{ ctx, debug }` — **no `pi`**. Its entire effect is: `state.turnsThisPhase = 1`; `debug("Done")`; `ctx.ui.notify(effect.notify, "info")`; `ctx.ui.setStatus("loop", effect.status)`. There is no `pi.sendUserMessage` — the loop's completion is visible only as a transient TUI toast and a status-bar update, never in the conversation transcript.
- The `done` effect is produced at exactly two sites in `src/transitions.ts` (handlePhaseCTransition): `doneEffect("done (cleaner failed)", "Phase C failed, keeping original code. Loop complete.")` (`:216-218`) and `doneEffect("done", "All phases complete.")` (`:220`), via `markDone` (`:276-278`). The effect shape is `{ type: "done"; status: string; notify: string }` (`src/transitions.ts:13`).
- Runtime evidence (session `01a00dba-1766-7742-9327-f4a6cd3d225a`, 2026-08-17; artifact: the session JSONL): at 06:46:35 the `Done` debug entry is the **last line of the session file** (file mtime 06:46:35 local; verified). No final user message exists anywhere in the transcript. The last durable user-visible text was the blocked-turn tool result *"Dispute filed. Waiting for Tester review. STOP producing tool calls."* — to a human watching, the run looked like a loop parked, waiting for a review that would never come. This is the "it feels like it hung" perception: the loop had actually finished, **silently**.
- Every other terminal/phase transition in the extension delivers into the conversation (`sendUserMessage` with `{ triggerTurn: true }` from the agent-settled context — the context proven to deliver; spec 07). `done` is the one terminal state that does not.

Gap: a completed run leaves no durable completion record in the session, so users cannot tell "finished" from "stuck" without reading debug entries.

## Target

When the loop reaches `done`, `applyDoneEffect` additionally delivers a completion message into the conversation from the agent-settled context, with the run's outcome (clean finish vs Phase C failure), the spec path, and the dispute count. The existing toast and status update are kept. The message is the transcript's last word of the run.

## Interface

No signature change to `applyDoneEffect` (`EffectInput` already carries `pi`). One new function in `src/generic-prompts.ts` (language-agnostic, same section as the other flow prompts):

```ts
export function promptLoopComplete(specPath: string, disputes: number, cleanerFailed: boolean): string {
  if (cleanerFailed) {
    return `Loop complete — spec ${specPath}. Phase C failed; the original code is kept. Disputes raised: ${disputes}.`;
  }
  return `Loop complete — spec ${specPath}. All phases passed the gate. Disputes raised: ${disputes}.`;
}
```

Persisted state: none — no state fields touched, no saved-shape change, no restore-path change.

## Behavior

Decision table — one row (the `done` effect is the only input to `applyDoneEffect`):

| # | Condition | Actions (pinned order) |
|---|---|---|
| 1 | effect.type === "done" (both producers) | 1. `state.turnsThisPhase = 1` 2. `debug("Done")` 3. `ctx.ui.notify(effect.notify, "info")` 4. `ctx.ui.setStatus("loop", effect.status)` 5. `sendPrompt(pi, GP.promptLoopComplete(state.current.specPath, state.current.disputeCount, effect.status === "done (cleaner failed)"))` |

- `sendPrompt` is the module's existing private helper (`src/events/agent-settled/effect-applicator.ts:52-54`: `pi.sendUserMessage(prompt, { triggerTurn: true })`) — same helper the retry/advance effects use.
- `cleanerFailed` is derived from the effect's `status` string, not a new effect field: `effect.status === "done (cleaner failed)"` matches the sole failing producer (`src/transitions.ts:216-218`); the passing producer's status is `"done"` (`:220`).
- `triggerTurn: true` (flagged for Phase 0, Findings row 1): the completion message uses the only delivery mode proven for this extension (agent-settled + triggerTurn; spec 07). The triggered final agent turn is expected to end without tool calls — the dispatcher's terminal short-circuit (`src/events/agent-settled/index.ts:82`: `isTerminalPhase` → `undefined`) guarantees no further loop activity.
- The variant text is chosen from `effect.status`; the two producer `notify` strings are **unchanged** verbatim pins: `"Phase C failed, keeping original code. Loop complete."` and `"All phases complete."`.

Quirks (current behavior, do not fix):
1. `applyEscalatedEffect` (`src/events/agent-settled/effect-applicator.ts:126-134`) is also toast-only — an escalated run is equally silent. **Out of scope**: different object (escalation ≠ completion); recorded as an adjacent candidate, not folded in.
2. The two `done` producers use different `status` strings (`"done"` vs `"done (cleaner failed)"`) while both mean "loop over" — the prompt derivation keys off that asymmetry; kept. **Test-locked**: the coupling is enforced by the verbatim status pins in the rewritten tests (rewrites 2/3 assert the exact prompt variant selected by the fixture's status string; `gate-transition.test.ts:373` and `:385` pin both producer statuses verbatim). If a producer's status string changes, the prompt variant flips — the tests catch it.

Intended shifts: none — the done path is the only behavior touched; no pre-existing code inherits new semantics.

Ownership: the delivery is owned by `src/events/agent-settled/effect-applicator.ts` (asserted in `test/events/agent-settled/effect-applicator.test.ts`); the prompt text by `src/generic-prompts.ts` (asserted in `test/prompts.test.ts`).

## Inventory

- Files (closed — 2 src, 2 test): `src/events/agent-settled/effect-applicator.ts` (`applyDoneEffect` body), `src/generic-prompts.ts` (+1 function). Tests: `test/events/agent-settled/effect-applicator.test.ts`, `test/prompts.test.ts`.
- Imports: `effect-applicator.ts` already imports `GP` (`src/events/agent-settled/effect-applicator.ts:11`: `import * as GP from "../../generic-prompts";`) and `EffectInput` already carries `pi` (`:31-41`) — zero import lines added, rewritten, or removed.
- Call sites: `applyDoneEffect` — 1 caller, the `applyEffect` dispatcher (`src/events/agent-settled/effect-applicator.ts:66`: `case "done"`); `doneEffect` — 2 producers (`src/transitions.ts:216-218`, `:220`), both unchanged; `promptLoopComplete` — 1 call site (Table 1 step 5) + tests.
- Exports: `promptLoopComplete` exported from `generic-prompts.ts` (consumer: `effect-applicator.ts`; pin-testable directly, same precedent as the other GP prompt functions).

## Test Strategy

- Baseline (as of writing): `npm test` → 1011/1011 passing, 32 files (specs 08 and 09 landed: 979 + 12 + 15 − 2 = 1004; the 7 additional are from spec 09's extra test coverage). `npx tsc --noEmit` clean.
- Rewritten (5 — old assertion → new assertion):
  1. `test/events/agent-settled/effect-applicator.test.ts:178` `"dispatches done effect: applied, notified, no prompt sent"` → old: `sentMessages` length 0. New: `applied:true`, `sentMessages` length **1**, content = `GP.promptLoopComplete("spec.md", 0, false)` (fixture values: `specPath: "spec.md"` from `makeState`, `disputeCount: 0` from `makeState`, `cleanerFailed: false` derived from fixture status `"All phases complete."`), `options` = `{ triggerTurn: true }`, plus the existing notify/status assertions kept.
  2. `test/events/agent-settled/effect-applicator.test.ts:566` `"returns applied: true and sends no prompt"` → old: `sentMessages` length 0. New: `sentMessages` length 1 with the pinned clean-finish text.
  3. `test/events/agent-settled/effect-applicator.test.ts:595` `"handles done with 'done (cleaner failed)' status"` → old: asserts only `setStatus("loop", "done (cleaner failed)")`. New: same + `sentMessages` length 1 with the pinned Phase-C-failed variant.
  4. `test/events/agent-settled/gate-transition.test.ts:368` `"tests fail, round >= maxC → done (cleaner failed): no prompt"` → old: `sentMessages` length 0. New: `sentMessages` length **1**, content = `GP.promptLoopComplete("spec.md", 0, true)` (fixture `specPath: "spec.md"`, `disputeCount: 0`, `cleanerFailed: true` derived from status `"done (cleaner failed)"`), plus the existing notify/status assertions kept.
  5. `test/events/agent-settled/gate-transition.test.ts:380` `"all pass → done: no prompt"` → old: `sentMessages` length 0. New: `sentMessages` length **1**, content = `GP.promptLoopComplete("spec.md", 0, false)` (clean-finish variant), plus the existing notify/status assertions kept.
- Kept as-is (named, closed): `effect-applicator.test.ts:586` `"notifies at 'info' and sets status"` (toast kept — still true); `:607` `"does not change phase"`; `test/events/agent-settled/gate-transition.test.ts:352` (asserts the toast `notify("All phases complete.", "info")` — unchanged).
- New tests (3):
  1. `test/prompts.test.ts` — `promptLoopComplete` clean-finish branch: exact string with interpolated `specPath`/`disputes` (e.g. `promptLoopComplete("internal/07.md", 2, false)` → verbatim).
  2. `test/prompts.test.ts` — `promptLoopComplete` Phase-C-failed branch: exact string.
  3. `test/events/agent-settled/effect-applicator.test.ts` — dispute count flows through: state with `disputeCount: 3` → sent message contains `"Disputes raised: 3."`.
- Untouched: all other test files — the mechanism: no state fields, no fixtures, and no other code path is changed; `done` is the sole touched behavior (closed: `rg -n "applyDoneEffect|type: \"done\"" test/` → the named tests above only).

## Scope lines

- `src/events/agent-settled/effect-applicator.ts`: `applyDoneEffect` — destructure `pi` (line 1 of the function) and add `sendPrompt(…)` as the last statement; nothing else in the file changed.
- `src/generic-prompts.ts`: +1 exported function in the Dispute/flow section; nothing else.

## Acceptance Criteria

1. `npm test` (vitest run) → all 32 files green, 1011 + 3 tests, 0 failures. Checker: `vitest run`.
2. `npx tsc --noEmit` → exit 0 (`vitest run` does not type-check). Checker: tsc.
3. Wiring sweep: `rg -n "promptLoopComplete" src/ test/` → exactly 5 hits: 1 definition in `src/generic-prompts.ts`, 1 call site in `src/events/agent-settled/effect-applicator.ts` (Table 1 step 5), 1 `GP.promptLoopComplete` reference in `test/events/agent-settled/effect-applicator.test.ts` (rewrite 1), 1 in `test/events/agent-settled/gate-transition.test.ts` (rewrite 4 or 5), 1 in `test/prompts.test.ts` (new test 1 or 2). The `GP.` star-import (`src/events/agent-settled/effect-applicator.ts:11`) means the call site is `GP.promptLoopComplete(…)` — the grep pattern `promptLoopComplete` catches it. Checker: ripgrep.
4. Both variant strings from the Interface block appear verbatim in `test/prompts.test.ts` assertions. Checker: vitest.
5. `applyDoneEffect` sends exactly one message: rewrite 1 asserts `sentMessages` length 1 with `triggerTurn: true`. Checker: vitest.
6. The toast is preserved: `gate-transition.test.ts:352` passes unchanged. Checker: vitest.
7. The `gate-transition.test.ts` done tests (rewrites 4/5) assert the completion message is sent via the `handleGateTransition` → `applyEffect` → `applyDoneEffect` chain — the inventory is closed. Checker: vitest.

## Dependencies

- Soft dependency on **specs 08 and 09** for sequencing only: this spec runs third (08 → 09 → 10) so the completion message reports `disputeCount` under 09's routed semantics and its pinned strings are never re-pinned. There is no code-level dependency — `promptLoopComplete` compiles against today's state shape alone.
- The fixture blocker from spec 08's Dependencies (suite was red at 8/979) — **resolved with user GO (2026-08-16)**: `setupSpecFiles()` (`test/extension.test.ts:49-57`) now writes the Go fixture files; suite verified 979/979. No remaining blocker.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | **Decision for Phase 0:** the completion message uses `triggerTurn: true`, the only delivery mode proven for this extension (agent-settled + triggerTurn; spec 07). Cost: one final agent turn that does nothing but settle (terminal short-circuit, `src/events/agent-settled/index.ts:82`). Alternative: `triggerTurn: false` (no turn) — cheaper, but delivery of non-triggered extension messages is unverified in this codebase; spec 07's evidence covers only the triggerTurn path | **Confirmed by reviewer (round 1):** `triggerTurn: true` matches the module convention (`sendPrompt` helper at `src/events/agent-settled/effect-applicator.ts:52-54`); the terminal short-circuit is verified (`src/events/agent-settled/index.ts:82`: `isTerminalPhase` → `undefined` → no further loop activity). **Accepted.** |
| 2 | needs-doc | `applyEscalatedEffect` is equally silent (toast-only) — the escalated run has the same "can't tell done from stuck" problem | **Rejected as in-scope.** Different object (escalation); one-verb-per-unit. Recorded as an adjacent candidate for a future `report-escalation` spec. |
| 3 | nit | First draft pinned the prompt text with `<spec>`-style placeholders; the template requires the exact string — pinned verbatim in the Interface block with named interpolation points | **Accepted, fixed.** Class B. |
| 4 | blocker | **Reviewer (round 1):** Inventory not closed — `handleGateTransition` calls `applyEffect`, so the two done tests in `gate-transition.test.ts` (`:368-378`, `:380-390`, both asserting `sentMessages` length 0) will break. The spec's "Kept as-is" list only named `:352` | **Accepted, verified.** The two tests are at `:368` and `:380` (verified via `cat -n`); both call `handleGateTransition` → `applyEffect` → `applyDoneEffect`, so they will receive the completion message. Added as rewrites 4/5 with explicit fixture-value mapping (reviewer N3: the fixture's status is `"All phases complete."` / `"done (cleaner failed)"`, not `"done"`, so the `cleanerFailed` derivation yields the correct variant — the spec now states the mapping explicitly so the Writer doesn't "fix" the fixture). |
| 5 | blocker | **Reviewer (round 1):** AC 3 math wrong — the `rg` sweep as written hits exactly 4 with the named tests, and the "import-free same-module reference" description is inaccurate (it's a `GP.` star-import) | **Accepted, verified.** The `GP.` star-import (`src/events/agent-settled/effect-applicator.ts:11`: `import * as GP from "../../generic-prompts";`) means the call site is `GP.promptLoopComplete(…)` — the grep pattern `promptLoopComplete` catches it. The exact hit count is 5: 1 definition (`src/generic-prompts.ts`), 1 call site (`src/events/agent-settled/effect-applicator.ts`), 1 in `test/events/agent-settled/effect-applicator.test.ts` (rewrite 1), 1 in `test/events/agent-settled/gate-transition.test.ts` (rewrite 4 or 5), 1 in `test/prompts.test.ts` (new test 1 or 2). AC3 rewritten with the exact count and the `GP.` import noted. |
| 6 | nit | **Reviewer (round 1):** Status-string coupling — accepted as recorded Quirk 2, but the disposition should note the coupling is test-locked via the verbatim status pins | **Accepted.** Quirk 2 updated: "**Test-locked**: the coupling is enforced by the verbatim status pins in the rewritten tests (rewrites 2/3 assert the exact prompt variant selected by the fixture's status string; `gate-transition.test.ts:373` and `:385` pin both producer statuses verbatim). If a producer's status string changes, the prompt variant flips — the tests catch it." |
| 7 | info | **Reviewer (round 1):** Auto-findings 1, 2, 3 rejected as scanner noise (no I/O, no directories, no type conflicts in this spec) | **Accepted.** No action. |
| 8 | info | **Reviewer (round 1):** Finding 4 (empty `specPath`) answered by the closed producer inventory; suggested adding a one-line rationale to the spec | **Accepted.** The `specPath` field is always set by `createInitialState` (`src/commands.ts:98`) and is a required field on `LoopState` (`src/types.ts:32`); the two `done` producers (`src/transitions.ts:216-218`, `:220`) both call `markDone` which preserves the existing `specPath` (spread: `...state`). An empty `specPath` would require a corrupted state object — out of scope for this unit. |
