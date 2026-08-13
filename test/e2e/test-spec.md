# Real Test Spec for Loop Extension

## Purpose

Run the loop extension against a known spec, measure both **process** and **code quality**, produce scores. Repeat after changes to validate improvement.

## Two Scores

Every run produces TWO independent scores:

| Score | What It Measures | When Captured |
|-------|------------------|---------------|
| **Process Score** (0-100) | Loop efficiency: rounds used, disputes, completion status | During the run, from loop-metrics entries |
| **Quality Score** (0-100) | Code quality: compiles, tests pass, coverage, edge cases | After completion, by analyzing produced code |

**A good run has HIGH process score AND HIGH quality score.**

## Test Project: String Utility Library

A Go package with 4 functions. Complex enough to measure quality, simple enough to complete reliably.

**Spec file:** `test/e2e/specs/stringutil-spec.md`

## How It Works

1. Create temp Go project directory
2. Place spec file there
3. Run: `pi /loop path/to/spec.md` (with this extension active)
4. Capture process metrics from loop-metrics session entries
5. Wait for loop to complete (done or escalated)
6. If completed: measure produced code's quality
7. Save both scores to scorecard

## Process Score (0-100)

| Metric | Weight | How Measured | Best |
|--------|--------|--------------|------|
| Completion | 40 pts | finalPhase == "done" | 40 (done) vs 0 (escalated) |
| Rounds Used | 30 pts | Total rounds across all phases | Fewer = better, max per phase = 0 pts |
| Disputes | 15 pts | disputesRaised count | 0 disputes = 15, each dispute -5 |
| Gate Efficiency | 15 pts | gateRuns vs theoretical min | Every gate necessary = 15 |

## Quality Score (0-100)

| Metric | Weight | How Measured | Target |
|--------|--------|--------------|--------|
| Compiles | 20 pts | `go build ./...` exit code | Must pass |
| Tests Pass | 25 pts | `go test -json ./...` | 100% pass |
| Coverage | 20 pts | `go test -cover` | ≥ 80% |
| Thoroughness | 15 pts | Test cases per function | ≥ 10 per function |
| Edge Cases | 10 pts | Pattern matching in test files | All 6 patterns found |
| Complexity | 10 pts | Cyclomatic complexity | ≤ 5 per function |

**Total: 100 points**

## Edge Case Patterns Checked

1. Empty string handling
2. Single character handling  
3. UTF-8/multi-byte handling
4. Whitespace handling
5. Zero value handling
6. Case sensitivity handling

## Scorecard Example

```json
{
  "label": "baseline",
  "timestamp": "2025-08-12T...",
  "processScore": 65,
  "qualityScore": 95,
  "combinedScore": 80,
  "process": {
    "finalPhase": "done",
    "gateRuns": 4,
    "roundsByPhase": {"A": 1, "B": 2, "C": 1},
    "disputesRaised": 0
  },
  "quality": {
    "compiles": true,
    "testsPass": true,
    "coverage": 100,
    "edgeCaseCoverage": 83
  }
}
```

## Running the Test

```bash
# Manual run (requires pi installed)
cd /tmp/test-project
pi /loop /path/to/extension/test/e2e/specs/stringutil-spec.md

# Measure quality of produced code
npx tsx -e 'import {measureQuality} from "./test/e2e/quality"; console.log(measureQuality(".", ["Reverse","Capitalize","TrimSpace","IsPalindrome"]).report)'

# Run all tests
npx vitest run
```

## Baseline & Regression

After a deliberate change (prompt, feature):

1. Run test before change → saves `results/before.json` (both scores)
2. Make the change
3. Run test after change → saves `results/after.json` (both scores)
4. Compare: if BOTH scores improve (or quality improves without process degrading), change is good
5. Update baseline if improvement is confirmed

**Score tolerance:** ±5 points per score (LLM output is non-deterministic)

## What Changes Should Improve

| Change | Expected Impact on Process | Expected Impact on Quality |
|--------|---------------------------|---------------------------|
| Better Tester prompt | Fewer disputes, fewer A rounds | More thorough tests, better edge cases |
| Better Writer prompt | Fewer B rounds | Code compiles, passes tests |
| Better Cleaner prompt | Same rounds, cleaner C phase | Lower complexity, cleaner code |
| Higher maxDispute | More disputes before escalate | N/A (more chance to resolve) |
| Coverage threshold increase | More B retries | Higher coverage score |

## Real Run Example

```
Run completed → escalated (Phase B exhausted)
  Process Score: LOW (escalated = 0 completion points)
  Quality Score: N/A (didn't complete)
  
Root cause: Tester wrote wrong test ("AbCa" is not a palindrome)
  Writer disputed 3x → escalated
  
Action: Fix Tester prompt to be more careful with edge case values
  Expected: Process score ↑ (fewer disputes, completes)
            Quality score: depends on whether code is good
```

## Non-Determinism Note

LLM output is non-deterministic. A single run's score may vary. For reliable comparison:
- Run the test 3x before and 3x after a change
- Compare averages
- Use statistical significance testing if available
