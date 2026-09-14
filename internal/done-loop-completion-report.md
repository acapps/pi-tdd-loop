# implement-loop-completion-report

## Problem

Verified current state as of writing: when the loop reaches `done`, `reportDone`
(`src/events/agent-settled/effect-applicator.ts:138`) sends a single-line prompt:

```
Loop complete — spec <path>. All phases passed the gate. Disputes raised: N.
```

or (cleaner failed):

```
Loop complete — spec <path>. Phase C failed; the original code is kept. Disputes raised: N.
```

That's the entire completion output. The user has no visibility into:
- How many rounds each phase consumed (A: 3/3, B: 4/5, C: 1/3)
- How many gate runs, compile fails, or test fails occurred
- What the final coverage was
- What the final phase sequence was
- How long the loop took (wall clock)

`src/metrics.ts` defines `LoopMetrics` (gateRuns, compileFails, testFails,
finalCoverage, roundsByPhase, turnsByPhase, disputesRaised/Conceded/Defended,
durationMs) and provides `createMetrics`, `accumulateGate`,
`accumulatePhaseTransition`, `accumulateTurn`, `accumulateDispute`,
`accumulateToolCall`, `finalize`. **None of these are called by the live loop.**
They are only used by `test/golden/runner.ts` and `test/e2e/runner.ts` which
build their own metrics from mock data.

The live loop accumulates no metrics. The completion report is a one-liner.

## Target

When the loop reaches `done`, the user sees a structured completion report in
the transcript: phase rounds used, gate stats, final coverage, dispute summary,
and wall-clock duration. The report is built from a `LoopMetrics` object that
the live loop accumulates throughout its run. The one-line `promptLoopComplete`
is replaced by a multi-line `promptLoopReport` that formats the metrics.

## Interface

New exported function in `src/metrics.ts`:

```ts
export function formatReport(m: LoopMetrics): string;
```

Returns a multi-line string. Shape (verbatim):

```
Loop complete — spec <specPath>
  Phases: A <rounds>/<max> → B <rounds>/<max> → C <rounds>/<max>
  Gates:  <gateRuns> runs, <compileFails> compile fails, <testFails> test fails
  Coverage: <finalCoverage>% (threshold <coverageThreshold>%)
  Disputes: <disputesRaised> raised, <disputesConceded> conceded, <disputesDefended> defended
  Duration: <durationMs formatted as Xm Ys>
```

When `cleanerFailed` is true, the first line becomes:
`Loop complete (Phase C failed — original code kept) — spec <specPath>`

`LoopState` gains no new fields. The metrics object is a module-level
accumulator in `effect-applicator.ts` (or a new `src/loop-metrics.ts`),
initialized at `/loop` start, accumulated at each gate/phase/dispute event,
and finalized at `done`.

New exported function in `src/generic-prompts.ts`:

```ts
export function promptLoopReport(report: string): string;
```

Wraps the formatted report in a prompt envelope. Replaces `promptLoopComplete`.

## Behavior

**Accumulation points** (first-match-wins, all in the live loop path):

| Event | Accumulator | Where |
|---|---|---|
| `/loop` starts | `createMetrics({ specPath, language })` | `cmdLoop` in `src/commands.ts` |
| Gate runs (pass or fail) | `accumulateGate(metrics, gateResult)` | `handleGateTransition` in `gate-transition.ts` |
| Phase advances | `accumulatePhaseTransition(metrics, fromPhase, toPhase, round)` | `applyEffect` in `effect-applicator.ts` (advance effect) |
| Turn settles in a phase | `accumulateTurn(metrics, phase)` | `handleAgentSettled` dispatcher in `agent-settled/index.ts` |
| Dispute filed | `accumulateDispute(metrics, "raised")` | `negotiate_propose` in `tools.ts` (Phase B dispute path) |
| Dispute conceded | `accumulateDispute(metrics, "conceded")` | `executeWriterConcedeDispute` in `tools.ts` |
| Dispute defended | `accumulateDispute(metrics, "defended")` | `negotiate_review` in `tools.ts` (approve path) |
| Loop done | `finalize(metrics, phase)` | `applyDoneEffect` in `effect-applicator.ts` |

**Report delivery**: `reportDone` calls `finalize` then `formatReport` then
`sends `promptLoopReport(report)`` via `sendPrompt`. The old
`promptLoopComplete` is removed.

**Quirks list**:
- `metrics.ts` header comment says "The live loop no longer accumulates
  metrics" — this is the current behavior, do not fix. The spec *changes* it.
- `finalCoverage` defaults to 0 when the gate has no coverage data (Java
  without jacoco). The report shows `0%` in that case. Current behavior, do
  not fix.

**Intended shifts**:
- `promptLoopComplete` is replaced by `promptLoopReport`. Any test that
  asserts the old string must be updated.
- The `LoopMetrics` object is now a live-loop concern, not just a test-harness
  concern. The `metrics.ts` header comment must be updated.

**Ownership**:
- `src/metrics.ts` owns `formatReport` and the accumulation functions.
- `src/events/agent-settled/effect-applicator.ts` owns the finalization +
  report delivery.
- `src/generic-prompts.ts` owns `promptLoopReport`.
- `test/events/agent-settled/effect-applicator.test.ts` asserts the report
  delivery. `test/metrics.test.ts` (new) asserts `formatReport`.

## Inventory

**Files touched:**
- `src/metrics.ts` — add `formatReport`; update header comment
- `src/generic-prompts.ts` — add `promptLoopReport`; remove `promptLoopComplete`
- `src/events/agent-settled/effect-applicator.ts` — wire metrics accumulation
  at advance/done; call `finalize` + `formatReport` in `reportDone`
- `src/events/agent-settled/gate-transition.ts` — call `accumulateGate` after
  each gate run
- `src/events/agent-settled/index.ts` — call `accumulateTurn` in dispatcher
- `src/tools.ts` — call `accumulateDispute` at dispute file/concede/defend
- `src/commands.ts` — call `createMetrics` at `/loop` start; pass metrics
  reference through state or module-level
- `test/events/agent-settled/effect-applicator.test.ts` — update
  `promptLoopComplete` assertions → `promptLoopReport`
- `test/metrics.test.ts` — new: `formatReport` unit tests
- `test/prompts.test.ts` — update `promptLoopComplete` pins → `promptLoopReport`

**Imports added:**
- `effect-applicator.ts`: `import { finalize, formatReport } from "../../metrics"`
- `gate-transition.ts`: `import { accumulateGate } from "../../metrics"`
- `agent-settled/index.ts`: `import { accumulateTurn } from "../../metrics"`
- `tools.ts`: `import { accumulateDispute } from "../../metrics"`
- `commands.ts`: `import { createMetrics } from "../../metrics"`

**Call sites for removed `promptLoopComplete`:**
- `src/events/agent-settled/effect-applicator.ts:143` (the only production call)
- `test/events/agent-settled/effect-applicator.test.ts` (assertions)
- `test/prompts.test.ts` (pins)
- 4 total call sites.

## Test Strategy

- **Baseline**: 1245 tests passing.
- **New tests** (`test/metrics.test.ts`):
  - `formatReport` with all fields populated → exact string match
  - `formatReport` with `cleanerFailed` → first line variant
  - `formatReport` with 0 coverage → shows `0%`
  - `formatReport` with 0 disputes → shows `0 raised, 0 conceded, 0 defended`
  - Duration formatting: 0s, 45s, 2m 30s, 1h 5m
- **Updated tests**:
  - `effect-applicator.test.ts`: `promptLoopComplete` → `promptLoopReport`
    (assert the new multi-line string)
  - `prompts.test.ts`: `promptLoopComplete` pins → `promptLoopReport` pins
- **Untouched**: golden/e2e test runners (they build their own metrics from
  mock data; they don't call `formatReport`).

## Scope lines

- `src/metrics.ts`: kept + `formatReport` added, header comment updated
- `src/generic-prompts.ts`: kept + `promptLoopReport` added,
  `promptLoopComplete` removed
- `src/events/agent-settled/effect-applicator.ts`: kept + metrics wiring
- `src/events/agent-settled/gate-transition.ts`: kept + `accumulateGate` call
- `src/events/agent-settled/index.ts`: kept + `accumulateTurn` call
- `src/tools.ts`: kept + `accumulateDispute` calls
- `src/commands.ts`: kept + `createMetrics` call
- `test/metrics.test.ts`: added
- `test/events/agent-settled/effect-applicator.test.ts`: updated
- `test/prompts.test.ts`: updated

## Acceptance Criteria

- `npx tsc --noEmit` clean
- `npx vitest run` green (1245 + new tests)
- `grep -r "promptLoopComplete" src/ test/` returns 0 matches
- `grep -r "promptLoopReport" src/ test/` returns ≥ 3 matches
- `grep -r "formatReport" src/ test/` returns ≥ 2 matches
- `grep -r "accumulateGate\|accumulateTurn\|accumulateDispute\|createMetrics" src/` returns ≥ 5 matches (the live loop calls them)

## Dependencies

None. `src/metrics.ts` already exists with all the accumulation functions.
This spec wires them into the live loop and adds the formatter.

## Findings log

(empty — clean Phase 0)
