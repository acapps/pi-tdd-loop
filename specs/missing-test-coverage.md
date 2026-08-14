# Missing Test Coverage

## Overview

Three critical areas lack proper test coverage:
1. `src/commands.ts` — only tested indirectly via extension.test.ts
2. `src/reviewer.ts` `findIssues` and `extractFunctions` — complex regex-based heuristics, no direct tests
3. `test/golden/` — hundreds of tests that validate data fixtures, not behavior

**Spec is the target state.**

## Problem 1: commands.ts Untested

The command handlers (`cmdLoop`, `cmdContinue`, `cmdRestart`, `cmdApprove`, `cmdCancel`, `cmdStatus`, `cmdDebug`) are only tested via the extension integration tests. The helper functions are completely untested:

| Function | Status |
|---|---|
| `buildContinuePrompt` | Untested — builds prompts for each phase |
| `buildRestartPrompt` | Untested — builds restart prompts |
| `resolvePhaseArg` | Untested — parses "A" → "A", "b" → "B", etc. |
| `createInitialState` | Untested — creates initial LoopState |
| `resetPhaseState` | Untested — resets round, dispute flags |
| `isIdleOrDone` | Untested — phase check |

### Target: Direct unit tests for command helpers

```typescript
// test/commands.test.ts

describe("buildContinuePrompt", () => {
  it("returns tester prompt for Phase A", () => {
    const state = makeState({ phase: "A" });
    const prompt = buildContinuePrompt(state);
    expect(prompt).toContain("TESTER");
    expect(prompt).toContain("spec.md");
  });

  it("returns negotiate prompt for negotiate phase", () => {
    const state = makeState({ phase: "negotiate", round: 1 });
    const prompt = buildContinuePrompt(state);
    expect(prompt).toContain("WRITER");
    expect(prompt).toContain("negotiate_propose");
  });
});

describe("resolvePhaseArg", () => {
  it("accepts uppercase", () => expect(resolvePhaseArg("A")).toBe("A"));
  it("accepts lowercase", () => expect(resolvePhaseArg("b")).toBe("B"));
  it("accepts negotiate", () => expect(resolvePhaseArg("negotiate")).toBe("negotiate"));
  it("rejects invalid phase", () => {
    expect(() => resolvePhaseArg("X")).toThrow();
  });
});

describe("createInitialState", () => {
  it("sets default coverage to 80", () => {
    const state = createInitialState("spec.md", "go", "maven", undefined);
    expect(state.coverageThreshold).toBe(80);
  });

  it("accepts custom coverage", () => {
    const state = createInitialState("spec.md", "go", "maven", 95);
    expect(state.coverageThreshold).toBe(95);
  });
});
```

### Acceptance Criteria for commands.ts
- [ ] `buildContinuePrompt` tested for all phases (A, negotiate, B, C)
- [ ] `buildRestartPrompt` tested for all phases
- [ ] `resolvePhaseArg` tested for valid/invalid inputs
- [ ] `createInitialState` tested for defaults and overrides
- [ ] `resetPhaseState` tested for flag clearing

## Problem 2: findIssues / extractFunctions Untested

The spec analysis engine has complex regex-based heuristics but no direct tests:

| Function | Purpose | Status |
|---|---|---|
| `extractFunctions` | Parse spec text → list of function signatures | Untested |
| `findIssues` | Detect ambiguities, missing edge cases, underspecified behavior | Partially tested via analyzeSpec |
| `extractContext` | Extract surrounding text for readable errors | Untested |

### Target: Direct unit tests

```typescript
// test/reviewer.test.ts — findIssues section

describe("extractFunctions", () => {
  it("parses backtick-quoted signatures", () => {
    const spec = "## \`Reverse(s string)\` string";
    const funcs = extractFunctions(spec);
    expect(funcs).toHaveLength(1);
    expect(funcs[0].name).toBe("Reverse");
    expect(funcs[0].params).toBe("s string");
  });

  it("parses arrow signatures", () => {
    const spec = "- Capitalize(s) → string";
    const funcs = extractFunctions(spec);
    expect(funcs[0].name).toBe("Capitalize");
    expect(funcs[0].returnType).toBe("string");
  });

  it("associates description with function via heading", () => {
    const spec = `## Reverse(s string) string

Reverses the input.

## Trim(s string) string

Trims whitespace.`;
    const funcs = extractFunctions(spec);
    expect(funcs[0].description).toContain("Reverses");
    expect(funcs[1].description).toContain("Trims");
  });

  it("filters out keyword names (function, if, for, return)", () => {
    const spec = "if (x) doSomething(); function foo() {}";
    const funcs = extractFunctions(spec);
    expect(funcs.some(f => f.name === "function")).toBe(false);
    expect(funcs.some(f => f.name === "if")).toBe(false);
  });
});

describe("extractContext", () => {
  it("returns surrounding text around a match", () => {
    const text = "The function properly handles input and output correctly.";
    const ctx = extractContext(text, "properly");
    expect(ctx).toContain("function");
    expect(ctx).toContain("properly");
    expect(ctx).toContain("handles");
  });

  it("adds ellipsis for truncated context", () => {
    const text = "A very long spec document that mentions properly somewhere in the middle of all this text.";
    const ctx = extractContext(text, "properly", 20);
    expect(ctx).toMatch(/^…/);
    expect(ctx).toMatch(/…$/);
  });

  it("returns the word itself if not found", () => {
    const ctx = extractContext("no match here", "missing");
    expect(ctx).toBe("missing");
  });
});
```

### Acceptance Criteria for reviewer internals
- [ ] `extractFunctions` tested for all signature formats (backtick, arrow, heading)
- [ ] `extractFunctions` tested for description association
- [ ] `extractFunctions` tested for keyword filtering
- [ ] `extractContext` tested for normal, truncated, and not-found cases
- [ ] `findIssues` tested for each finding category with known input/output

## Problem 3: Golden Tests Are Data Validation, Not Behavior Tests

`test/golden/scenarios.test.ts` has 200+ tests, most of which validate that threshold objects have the right values:

```typescript
// Current — data validation, not behavior
it("thresholdsHappyPath: gateRuns max is 4", () => {
  expect(thresholdsHappyPath.gateRuns).toEqual({ max: 4 });
});

// This would be caught by TypeScript. It's not a test.
```

### Target: Reduce data validation tests, add behavior assertions

The current tests should be consolidated into fewer, higher-value tests:

```typescript
// Consolidated — behavior test
describe("golden scenarios — behavior", () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`${name}: completes with expected phase`, async () => {
      const metrics = await runScenario(scenario, SPEC_PATH, CWD);
      expect(metrics.finalPhase).toBe(scenario.expectedPhase);
    });

    it(`${name}: gate runs match expected rounds`, async () => {
      const metrics = await runScenario(scenario, SPEC_PATH, CWD);
      if (scenario.expectedRounds) {
        for (const [phase, expectedRound] of Object.entries(scenario.expectedRounds)) {
          expect(metrics.roundsByPhase[phase]).toBeGreaterThanOrEqual(expectedRound);
        }
      }
    });
  }
});
```

### Acceptance Criteria for golden tests
- [ ] Reduce scenario tests from 200+ to < 50 by removing data validation tests
- [ ] Each scenario has at least one behavior assertion (finalPhase, roundsByPhase)
- [ ] Threshold preset tests consolidated into single parameterized test
- [ ] Fixture builder tests consolidated or removed (TypeScript catches regressions)

## Summary of Test Counts

| Area | Current | Target |
|---|---|---|
| commands.test.ts | 0 | ~15 new tests |
| reviewer.test.ts (findIssues/extractContext) | 15 correctness tests | +10 more for internals |
| golden/scenarios.test.ts | 200+ (mostly data validation) | < 50 (behavior-focused) |
| **Net change** | +25 behavior tests, -150 data validation tests |

## Acceptance Criteria (Overall)

- [ ] commands.test.ts created with 15+ tests
- [ ] reviewer.test.ts extended with extractFunctions and extractContext tests
- [ ] golden scenarios tests reduced from 200+ to < 50
- [ ] All existing tests still pass
- [ ] No behavioral changes — this is test quality improvement only

## Migration Plan

1. **Step 1**: Write commands.test.ts (isolated, low risk)
2. **Step 2**: Write extractFunctions and extractContext tests (needs export or direct import)
3. **Step 3**: Consolidate golden scenario tests (reduce count, improve quality)
4. **Step 4**: Verify all tests pass
