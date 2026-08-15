# loop-metrics — Measurable Scoreboard for Loop Runs

## Overview

Add a metrics collector to the loop extension that tracks per-run measurements and produces a scoreboard. The goal: enable quantitative comparison between runs so that prompt changes, feature requests, and configuration tweaks can be evaluated against concrete numbers.

**Spec is the target state.** This extends the existing `loop-go-bak` extension. The spec describes additions to `types.ts`, `events.ts`, `commands.ts`, and a new `metrics.ts` module.

**Single module.** Operates on `ctx.cwd`. Metrics are emitted as session entries and optionally persisted to disk.

## Metrics

Every loop run produces a `LoopMetrics` record. It accumulates across phase transitions and is finalized when the loop reaches `done` or `escalated`.

### Tracked Metrics

| Metric | Type | Source | Description |
|--------|------|--------|-------------|
| `startTime` | ISO timestamp | `/loop` command | Wall-clock start |
| `endTime` | ISO timestamp | done/escalated effect | Wall-clock end |
| `durationMs` | number | derived | `endTime - startTime` |
| `finalPhase` | `Phase` | last state | `done`, `escalated`, or current if interrupted |
| `finalCoverage` | number | last gate | Coverage percentage from final gate run |
| `gateRuns` | number | gate handler | Total number of gate executions |
| `compileFails` | number | gate handler | Gate runs where `compile: false` |
| `testFails` | number | gate handler | Gate runs where `tests: false` |
| `totalFailures` | number | gate handler | Sum of all `failures.length` across gate runs |
| `roundsByPhase` | `Record<Phase, number>` | state transitions | Max round reached per phase |
| `turnsByPhase` | `Record<Phase, number>` | `turnsThisPhase` | Total turns consumed per phase |
| `disputesRaised` | number | dispute handler | Times `negotiate_propose` called in Phase B |
| `disputesConceded` | number | dispute handler | Times Tester conceded (`approve` in B) |
| `disputesDefended` | number | dispute handler | Times Tester defended the test |
| `filesWritten` | number | tool_call handler | Total `write`/`edit` tool calls allowed |
| `filesBlocked` | number | tool_call handler | Total tool calls blocked by enforcement |

### Accumulator Design

- **`src/metrics.ts`** — new module with `LoopMetrics` interface and accumulator functions
- Created fresh on `/loop`, cleared on `/loop-cancel`
- Accumulated in `events.ts` at natural boundaries:
  - `eventSessionStart` — reset on fresh `/loop`
  - `eventAgentSettled` — gate results, phase transitions
  - `eventToolCall` — file write/block counts
- Finalized on `done` or `escalated` effect in `eventAgentSettled`

### Session Entry

On `done` or `escalated`, emit:

```json
{
  "type": "custom",
  "customType": "loop-metrics",
  "data": {
    "ts": "2025-01-15T12:00:00.000Z",
    "specPath": "path/to/spec.md",
    "language": "go",
    "startTime": "2025-01-15T12:00:00.000Z",
    "endTime": "2025-01-15T12:08:30.000Z",
    "durationMs": 510000,
    "finalPhase": "done",
    "finalCoverage": 87.3,
    "gateRuns": 8,
    "compileFails": 1,
    "testFails": 4,
    "totalFailures": 12,
    "roundsByPhase": { "A": 1, "negotiate": 1, "B": 3, "C": 1 },
    "turnsByPhase": { "A": 1, "negotiate": 1, "B": 3, "C": 1 },
    "disputesRaised": 0,
    "disputesConceded": 0,
    "disputesDefended": 0,
    "filesWritten": 24,
    "filesBlocked": 2
  }
}
```

## State Extension

Add to `LoopState` in `types.ts`:

```typescript
interface LoopState {
  // ... existing fields ...
  metrics?: LoopMetrics;  // accumulated metrics for current run
}
```

## Commands

### `/loop-metrics`

Shows the current run's metrics. Works during an active run or after completion.

```
Usage: /loop-metrics

Output:
  Run time: 8m 30s
  Final phase: done
  Coverage: 87.3%
  Gate runs: 8
  Compile fails: 1
  Test fails: 4
  Total failures: 12
  Rounds — A: 1, negotiate: 1, B: 3, C: 1
  Disputes: 0 raised, 0 conceded, 0 defended
  Files: 24 written, 2 blocked
```

If no run is active: `No metrics. Run /loop <spec> to start.`

### `/loop-scoreboard`

List and compare past runs.

```
Usage: /loop-scoreboard              # list recent runs
       /loop-scoreboard compare A B   # compare two runs by index or label
```

**List mode** — shows last N runs (default 10) as a compact table:

```
 #  Phase    Time   Cov   Gates  Rounds  Disputes  Files
 1  done     8:30   87%   8      1-1-3-1  0        24w/2b
 2  done     6:12   91%   5      1-1-2-1  0        18w/0b
 3  escalated 4:45  62%   6      1-2-5-0  2        20w/3b
```

**Compare mode** — side-by-side diff of two runs. Highlights differences in bold.

```
Metric          Run 1 (baseline)   Run 2 (prompt-v2)
────────────────────────────────────────────────────
Duration        8m 30s             6m 12s  ← 28% faster
Final phase     done               done
Coverage        87%                91%  ← +4%
Gate runs       8                  5  ← -3
Compile fails   1                  0  ← fixed
Test fails      4                  2  ← -2
Total failures  12                 5  ← -7
Rounds (A/B/C)  1/3/1              1/2/1  ← B -1
Disputes        0/0/0              0/0/0
Files           24w/2b             18w/0b  ← cleaner
```

### `/loop-scoreboard-save <label>`

Save the current run's metrics with a label for later comparison.

```
Usage: /loop-scoreboard-save baseline
       /loop-scoreboard-save prompt-v2

Output: Saved metrics as "baseline" (run #12)
```

Metrics are stored in `runs/` directory within the extension or project root.

## Scoreboard Storage

- **Location:** `runs/` directory (configurable, defaults to `ctx.cwd/.loop-runs/`)
- **Format:** JSON file per run: `<timestamp>_<label>.json`
- **Contents:** The `LoopMetrics` data object plus a `label` field
- **Index:** `runs/index.json` — compact list of labels, timestamps, and summaries

## Integration Points

### `src/metrics.ts` (new)

```typescript
export interface LoopMetrics {
  ts: string;
  specPath: string;
  language: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  finalPhase: Phase;
  finalCoverage: number;
  gateRuns: number;
  compileFails: number;
  testFails: number;
  totalFailures: number;
  roundsByPhase: Record<Phase, number>;
  turnsByPhase: Record<Phase, number>;
  disputesRaised: number;
  disputesConceded: number;
  disputesDefended: number;
  filesWritten: number;
  filesBlocked: number;
}

export function createMetrics(state: LoopState): LoopMetrics;
export function accumulateGate(metrics: LoopMetrics, gateResult: GateResult): void;
export function accumulatePhaseTransition(metrics: LoopMetrics, phase: Phase, round: number): void;
export function accumulateDispute(metrics: LoopMetrics, action: "raised" | "conceded" | "defended"): void;
export function accumulateToolCall(metrics: LoopMetrics, blocked: boolean): void;
export function finalize(metrics: LoopMetrics, finalPhase: Phase): LoopMetrics;
export function formatMetrics(metrics: LoopMetrics): string;  // for /loop-metrics
export function loadScoreboard(dir: string): ScoreboardEntry[];
export function saveMetrics(dir: string, metrics: LoopMetrics, label: string): void;
```

### `src/events.ts` (additions)

- **`eventSessionStart`:** Create fresh `LoopMetrics` on `/loop` start (detected by `justTransitioned` being false and phase being "A")
- **`eventAgentSettled` gate section:** Call `accumulateGate()` after `runGates()`
- **`eventAgentSettled` advance/done/escalated:** Call `finalize()`, emit `loop-metrics` entry
- **`eventToolCall`:** Call `accumulateToolCall()` on each write/edit attempt

### `src/commands.ts` (additions)

- **`/loop` command:** Initialize `state.current.metrics = createMetrics(state.current)`
- **`/loop-metrics`:** New command, shows current metrics via `formatMetrics()`
- **`/loop-scoreboard`:** New command, list or compare saved runs
- **`/loop-scoreboard-save`:** New command, save current metrics with label
- **`/loop-cancel`:** Clear metrics

## Invariants

1. **Metrics are additive only.** Once accumulated, values are never decremented. The scoreboard reflects what actually happened.
2. **Metrics don't block the loop.** If metrics collection fails (disk full, etc.), the loop proceeds normally. Metrics are best-effort observability.
3. **Metrics survive session reload.** The `loop-metrics` entry is persisted in session JSONL. `/loop-continue` resumes accumulation from where it left off.
4. **Scoreboard is per-project.** Each `ctx.cwd` has its own `runs/` directory. No cross-project mixing.
