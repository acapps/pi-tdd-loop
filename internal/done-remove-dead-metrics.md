# remove-dead-metrics

## Problem

**REVISED:** `src/metrics.ts` is NOT dead code. It is used by:
- `test/golden/runner.ts` — imports `createMetrics`, `accumulateGate`, `accumulateRound`, `accumulateDispute`, `accumulateToolCall`, `finalize`
- `test/golden/types.ts` — imports `LoopMetrics` type
- `test/golden/score.ts` — imports `LoopMetrics` type
- `test/golden/fixtures.ts` — imports `LoopMetrics` type
- `test/golden/scenarios.test.ts` — imports `LoopMetrics` type
- `test/e2e/runner.ts` — imports `LoopMetrics` type
- `test/e2e/process-score.ts` — imports `LoopMetrics` type

The initial assessment ("zero call sites") was wrong: the grep only searched
`src/` for imports, missing `test/golden/` and `test/e2e/`.

The metrics module is the scoring backbone of the golden test infrastructure.
It tracks gate runs, compile failures, test failures, disputes, and tool calls
per loop run, and `finalize()` produces the score used by the golden scoreboard.

## Target

No change. `src/metrics.ts` stays. The spec is closed as **invalid** — the
premise was wrong.

## Resolution

No code change. The spec is archived as `done-remove-dead-metrics.md` with a
note that the premise was incorrect.
