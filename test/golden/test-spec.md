# Measurable Test Specification for Loop Extension

## Purpose

Define a repeatable, scored test suite that measures loop quality so we can answer:
**"Did this change (prompt, feature, refactor) make the extension better?"**

## Test Tiers

| Tier | Name | What It Measures | Mock Level |
|------|------|-------------------|------------|
| **T1** | Transition Contract | State machine correctness — transitions, round accounting, escalation | Full mock of gates |
| **T2** | Metrics Accuracy | Metrics capture every signal correctly | Pure function tests |
| **T3** | Scoreboard Regression | End-to-end quality scores across scenarios | Simulated runs with controlled gates |

**T1 and T2 already exist** (unit tests for transitions, metrics). This spec focuses on **T3** — the measurable scoreboard.

## Scoring Model

### Composite Quality Score (0-100)

```
Score = convergence × 0.40
      + enforcement × 0.20
      + dispute     × 0.15
      + coverage    × 0.15
      + efficiency  × 0.10
```

### Sub-Score Definitions

| Sub-Score | Weight | Formula | Best | Worst |
|-----------|--------|---------|------|-------|
| **Convergence** | 40% | `100 - (roundsUsed / maxRounds) × 100` per phase, averaged | 100 — completes in 1 round per phase | 0 — exhausts all retries |
| **Enforcement** | 20% | `100 - (blockedWrites / totalWriteAttempts) × 100` | 100 — zero false blocks, all violations caught | 0 — everything blocked or nothing enforced |
| **Dispute** | 15% | Based on dispute outcome: conceded=50, defended=100, escalated=0 | 100 — no disputes needed or all resolved cleanly | 0 — disputes caused escalation |
| **Coverage** | 15% | `min(finalCoverage / threshold, 1.0) × 100` | 100 — coverage ≥ threshold | 0 — no coverage |
| **Efficiency** | 10% | `100 - (extraneousGateRuns / totalGateRuns) × 100` | 100 — every gate run was necessary | 0 — many redundant gate runs |

### Convergence Score Detail

Per-phase convergence, then averaged:

```
phaseConvergence(phase) = 100 × (1 - roundUsed / phaseMax)

Example: Phase B, round 2 of maxB=5 → 100 × (1 - 2/5) = 60
         Phase B, round 1 of maxB=5 → 100 × (1 - 1/5) = 80

Overall convergence = average of active phases' convergence scores
```

### Enforcement Score Detail

Tracks two things:
- **False positives**: Writer tried to write allowed files but was blocked → penalty
- **False negatives**: Writer wrote disallowed files and wasn't blocked → penalty

```
enforcement = 100 - (falsePositives + falseNegatives) / expectedBlocks × 100
```

For simulation tests, this is inferred from the scenario's `filesBlocked` metric vs expected.

### Dispute Score Detail

```
No disputes: 100
Dispute defended (test was correct): 80
Dispute conceded (test was wrong, fixed): 50
Dispute escalated: 0
Multiple disputes: average
```

### Efficiency Score Detail

Extraneous gate runs = gate runs beyond the theoretical minimum for the scenario.

```
happyPath: theoretical min = 4 gates (A, B, C + negotiate). Extra = gateRuns - 4.
bRetry: theoretical min = 5 gates. Extra = gateRuns - 5.
```

## Scenarios

Each scenario defines the gate sequence, expected state, and scoring expectations.

### Scenario 1: Happy Path

```
Phase A:  compile pass (round 1)
Negotiate: Writer agrees
Phase B:  tests pass, coverage ≥ 80% (round 1)
Phase C:  tests pass (round 1)
Result: done
```

| Metric | Expected |
|--------|----------|
| gateRuns | 3 (A compile, B test+cover, C test) |
| roundsByPhase | A=1, negotiate=1, B=1, C=1 |
| compileFails | 0 |
| testFails | 0 |
| finalCoverage | ≥ 80 |
| disputesRaised | 0 |
| **Score** | **~95-100** (optimal) |

### Scenario 2: B Retry (one failure)

```
Phase A:  compile pass (round 1)
Negotiate: Writer agrees
Phase B:  tests fail (round 1) → tests pass (round 2)
Phase C:  tests pass (round 1)
Result: done
```

| Metric | Expected |
|--------|----------|
| gateRuns | 4 (A compile, B fail, B pass, C test) |
| roundsByPhase.B | 2 |
| testFails | 1 |
| **Score** | **~75-85** (one retry) |

### Scenario 3: Dispute Conceded

```
Phase A:  compile pass (round 1)
Negotiate: Writer agrees
Phase B:  tests fail → Writer disputes → Tester concedes → Tester fixes test → tests pass (round 2)
Phase C:  tests pass (round 1)
Result: done
```

| Metric | Expected |
|--------|----------|
| disputesRaised | 1 |
| disputesConceded | 1 |
| roundsByPhase.B | 2 |
| **Score** | **~60-70** (dispute conceded reduces dispute score) |

### Scenario 4: Escalation (B exhausted)

```
Phase A:  compile pass (round 1)
Negotiate: Writer agrees
Phase B:  tests fail × 5 (rounds 1-5)
Result: escalated
```

| Metric | Expected |
|--------|----------|
| gateRuns | 6 (A compile + 5 B gates) |
| roundsByPhase.B | 5 |
| testFails | 5 |
| finalPhase | escalated |
| **Score** | **~5-15** (convergence=0, dispute=0) |

### Scenario 5: A Retry (compile fail recovery)

```
Phase A:  compile fail (round 1) → compile pass (round 2)
Negotiate: Writer agrees
Phase B:  tests pass (round 1)
Phase C:  tests pass (round 1)
Result: done
```

| Metric | Expected |
|--------|----------|
| gateRuns | 4 (A fail, A pass, B pass, C pass) |
| roundsByPhase.A | 2 |
| compileFails | 1 |
| **Score** | **~70-80** (compile fail in A) |

### Scenario 6: C Exhaustion (cleaner fails 3x, marks done)

```
Phase A:  compile pass (round 1)
Negotiate: Writer agrees
Phase B:  tests pass (round 1)
Phase C:  tests fail × 3 (rounds 1-3)
Result: done (cleaner failed)
```

| Metric | Expected |
|--------|----------|
| roundsByPhase.C | 3 |
| testFails | 3 |
| finalPhase | done |
| **Score** | **~40-50** (C exhausted) |

## How to Run

```bash
# Run all scoreboard tests
npx vitest run test/golden/scoreboard.test.ts

# Run a specific scenario
npx vitest run test/golden/scoreboard.test.ts -t "happy-path"

# Compare two runs (after saving scorecards)
npx vitest run test/golden/regression.test.ts
```

## How to Update Baselines

After a deliberate improvement (prompt change, feature):

1. Run the scoreboard tests: `npx vitest run test/golden/scoreboard.test.ts`
2. Check `test/golden/results/` for the new scorecard JSON
3. If scores improved, copy to baseline:
   ```bash
   cp test/golden/results/<latest>.json test/golden/expected/metrics-baseline.json
   ```
4. Commit both the code change and the new baseline together

## What to Measure When Changing Prompts

When you change a prompt (e.g., the Writer prompt in `generic-prompts.ts`):

1. Save current run as `baseline`
2. Make the prompt change
3. Save new run as `prompt-v2`
4. Run comparison: the scoreboard shows which metrics changed and whether the composite score improved
5. Decision: keep change if score improves OR if specific metrics improve with acceptable trade-offs

## What to Measure When Adding Features

For feature additions (e.g., new enforcement rules, new phase):

1. Run scoreboard BEFORE the feature — saves baseline
2. Add the feature
3. Run scoreboard AFTER — saves new run
4. Compare: regression tests fail if any score drops beyond tolerance
5. Tolerance bands prevent false alarms from noisy metrics (e.g., `gateRuns` ±50%)

## Scoreboard JSON Schema

```json
{
  "scenario": "happy-path",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "extensionVersion": "0.1.0",
  "commit": "abc123",
  "score": 95,
  "subScores": {
    "convergence": 100,
    "enforcement": 100,
    "dispute": 100,
    "coverage": 100,
    "efficiency": 100
  },
  "metrics": { /* LoopMetrics */ },
  "thresholds": { /* MetricThresholds */ },
  "passed": true,
  "failures": []
}
```

## Invariants

1. **Deterministic given same gates.** Same gate sequence → same metrics → same score.
2. **Scores are additive.** Sub-scores sum to composite score with weights.
3. **Baselines are manually updated.** Tests compare against baseline; human decides to update.
4. **Tolerance bands prevent noise.** Metrics have acceptable deviation ranges.
5. **Every scenario has a minimum score threshold.** If a scenario drops below its threshold, it's a regression.
