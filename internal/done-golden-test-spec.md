# golden-test — E2E Test Harness for Loop

## Overview

A small "golden" test project and E2E harness for measuring loop behavior. The golden project is a known spec that the loop can run against end-to-end. The harness replays the loop lifecycle through the extension's public API, captures metrics, and asserts thresholds.

**Spec is the target state.** This spec describes the test project, runner, and assertion suite. Implementation lives under `test/golden/`.

**Purpose:** Enable regression testing of prompt changes and feature requests. If a prompt change increases Phase B rounds from 2 to 5, the scoreboard catches it.

## Golden Project

A minimal Go project that exercises all three phases (A, B, C) but is small enough to complete in 2-5 rounds per phase.

### Location

```
test/golden/stringutils/
  go.mod              # module stringutils
  spec.md             # the spec the loop consumes
  expected/           # reference outputs (for scorecard comparison)
    metrics-baseline.json
```

### Spec Content

The spec must satisfy these constraints:

| Constraint | Reason |
|---|---|
| 3-5 functions | Enough to exercise the Writer, not overwhelming |
| Clear edge cases | Tests are unambiguous, reducing dispute noise |
| No external dependencies | Pure Go, no imports beyond `std` |
| Compile in Phase A on first attempt | Tester is straightforward, keeps `maxA` at 1 |
| Convergence in Phase B within 2-3 rounds | Writer has clear path to correct implementation |
| Refactorable in Phase C | Code has obvious improvement opportunities |

### Recommended Spec: String Utility Package

```markdown
# String Utility Package

Implement a `stringutil` package with the following functions:

## `Reverse(s string) string`
Return the string with all characters reversed. UTF-8 safe (handle multi-byte runes).
- Empty string returns empty string
- Single character returns itself
- "hello" returns "olleh"

## `Capitalize(s string) string`
Return the string with the first character uppercased, rest unchanged.
- Empty string returns empty string
- "hello" returns "Hello"
- "HELLO" returns "HELLO" (already capitalized)

## `TrimSpace(s string) string`
Return the string with leading and trailing whitespace removed.
- "  hello  " returns "hello"
- "" returns ""
- "   " returns ""

## `IsPalindrome(s string) bool`
Return true if the string reads the same forwards and backwards (case-insensitive, whitespace ignored).
- "racecar" returns true
- "A man a plan a canal Panama" returns true
- "hello" returns false
- "" returns true (empty string is palindrome)
```

### Why this spec

- **4 functions** — exercises the Writer across multiple implementations
- **Clear edge cases** — empty strings, single chars, whitespace handling
- **UTF-8 requirement** — tests the Writer's awareness of Go's `range` vs `[]byte`
- **Case-insensitive palindrome** — requires normalization, obvious refactor target for Phase C
- **No dependencies** — pure `unicode/utf8` and `strings` from stdlib
- **Predictable convergence** — good implementations pass in 2-3 B rounds

## E2E Harness

### Architecture

The harness runs the loop lifecycle through the extension's public API using the mock ExtensionAPI. It simulates the full phase progression by triggering event handlers.

```
test/golden/
  runner.ts           # E2E test runner
  fixtures/           # mock execSync implementations per phase
  golden-project/     # the actual Go project directory
  expected/           # baseline metrics for comparison
```

### Runner Design

The runner:

1. **Creates a mock ExtensionAPI** (from existing mock)
2. **Initializes the extension** via `extensionFactory(api)`
3. **Triggers `/loop`** with the golden spec path
4. **Triggers `agent_settled`** events to drive phase transitions
5. **Mocks `execSync`** to simulate gate results (fail, fail, pass pattern)
6. **Captures all metrics** from `loop-metrics` entries
7. **Asserts thresholds** and produces a scorecard

### Gate Simulation

The harness controls gate outcomes to exercise each transition path:

| Scenario | Phase A | Negotiate | Phase B | Phase C | Expected Outcome |
|---|---|---|---|---|---|
| **Happy path** | pass r1 | agree | pass r1 | pass r1 | done in 4 rounds |
| **B retry once** | pass r1 | agree | fail r1, pass r2 | pass r1 | done in 5 rounds |
| **Dispute conceded** | pass r1 | agree | dispute → concede → pass | pass r1 | done, 1 dispute |
| **Escalation** | pass r1 | agree | fail r1-5 | — | escalated |
| **Phase C refactor fail** | pass r1 | agree | pass r1 | fail r1, pass r2 | done in C retry |

Each scenario is a separate test that captures its own metrics.

### Runner API

```typescript
// Run a scenario and return metrics
async function runScenario(
  scenario: GateScenario,  // sequence of gate results per phase
  specPath: string,
  cwd: string,
): Promise<LoopMetrics>;

// Assert metrics meet thresholds
function assertMetrics(metrics: LoopMetrics, thresholds: Partial<LoopMetrics>): void;

// Compare two runs and produce diff
function compareRuns(a: LoopMetrics, b: LoopMetrics): RunComparison;
```

### GateScenario Type

```typescript
interface GateScenario {
  name: string;
  // Sequence of gate results per phase. "pass" or "fail" per round.
  phaseA: ("pass" | "fail")[];
  negotiate: "agree" | "feedback" | "dispute";
  phaseB: ("pass" | "fail" | "dispute")[];
  phaseC: ("pass" | "fail")[];
  // Expected outcome
  expectedPhase: Phase;
  expectedRounds?: Record<Phase, number>;
}
```

### Assertion Suite

Each scenario asserts these thresholds:

| Metric | Happy Path | B Retry | Dispute | Escalation |
|---|---|---|---|---|
| `finalPhase` | `"done"` | `"done"` | `"done"` | `"escalated"` |
| `gateRuns` | ≤ 4 | ≤ 5 | ≤ 6 | ≤ 6 |
| `compileFails` | 0 | 0 | 0 | 0 |
| `testFails` | 0 | ≤ 2 | ≤ 2 | 5 |
| `roundsByPhase.B` | ≤ 2 | ≤ 3 | ≤ 3 | 5 |
| `disputesRaised` | 0 | 0 | 1 | 0 |
| `filesBlocked` | ≥ 0 | ≥ 0 | ≥ 0 | ≥ 0 |

## Scorecard

Each E2E run produces a scorecard JSON:

```json
{
  "scenario": "happy-path",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "extensionVersion": "0.x.x",
  "commit": "abc123",
  "metrics": { /* LoopMetrics object */ },
  "thresholds": { /* passed thresholds */ },
  "passed": true,
  "failures": []
}
```

### Scorecard Storage

- **Location:** `test/golden/results/`
- **Format:** `<scenario>_<timestamp>.json`
- **Baseline:** `test/golden/expected/metrics-baseline.json` — canonical metrics from a known-good run
- **CI usage:** Compare current run against baseline; fail if metrics degrade beyond tolerance

### Tolerance Bands

Metrics are compared against baseline with tolerance:

| Metric | Tolerance |
|---|---|
| `finalPhase` | exact match |
| `gateRuns` | +50% (don't require exact) |
| `roundsByPhase.B` | +100% (2 → 4 is OK, 2 → 6 is not) |
| `compileFails` | 0 always |
| `disputesRaised` | exact match |

## Integration Points

### `test/golden/runner.ts` (new)

```typescript
import { createMockExtensionAPI } from "../__mocks__/@earendil-works/pi-coding-agent";
import extensionFactory from "../../index";

// Set up the mock with controlled execSync
async function createRunner(cwd: string): Promise<TestRunner>;

// Trigger the full loop lifecycle
async function run(cwd: string, specPath: string, scenario: GateScenario): Promise<LoopMetrics>;

// Assert metrics meet thresholds
function assert(metrics: LoopMetrics, thresholds: MetricThresholds): AssertionResult;
```

### `test/golden/scenarios.test.ts` (new)

```typescript
import { describe, it, expect } from "vitest";
import { runScenario, assertMetrics } from "./runner";

describe("golden E2E — happy path", () => {
  it("completes all phases without escalation", async () => {
    const metrics = await runScenario(scenarios.happyPath, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    assertMetrics(metrics, {
      finalPhase: "done",
      gateRuns: { max: 4 },
      compileFails: { max: 0 },
      roundsByPhase: { B: { max: 3 } },
    });
  });
});

describe("golden E2E — B retry", () => {
  it("recovers from Phase B failure", async () => {
    const metrics = await runScenario(scenarios.bRetry, GOLDEN_SPEC_PATH, GOLDEN_CWD);
    assertMetrics(metrics, {
      finalPhase: "done",
      gateRuns: { max: 6 },
      roundsByPhase: { B: { max: 4 } },
    });
  });
});
```

## Running the E2E Suite

```bash
# Run all golden scenarios
npx vitest run test/golden/

# Run a specific scenario
npx vitest run test/golden/ -t "happy path"

# Update baseline
# (manual: copy results/<latest>.json to expected/metrics-baseline.json)
```

## Invariants

1. **Golden project is deterministic.** The same spec always produces the same set of tests and stubs. No randomness.
2. **Scenarios are isolated.** Each scenario starts from a clean state. No shared mutable state between tests.
3. **Scorecards are append-only.** Old results are never deleted. Baseline is manually updated.
4. **E2E tests pass without graphify.** Graphify is optional. The E2E harness must work with or without it.
