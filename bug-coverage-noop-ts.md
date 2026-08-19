# Bug: Coverage gate is a silent no-op for TypeScript (and faked for Java)

## Context

Observed in sessions `01a011fa` (spec 09) and `01a0155a` (spec 10): every single gate log line reads `cov=0%` — 8+ gates across Phases A/B/C — while the loop was invoked with the default `--coverage 80`. The coverage threshold is therefore never enforced in TypeScript projects, despite SPEC.md advertising "build/test/coverage" gates.

## Observed problem

`checkCoverage` (`src/gates.ts:134-146`) runs the language command and matches `coverage:\s+(\d+\.?\d*)%` against the output:

- **TypeScript** (`src/gates.ts:150`): `npx vitest run --coverage 2>&1 || echo 'coverage: 0%'`. Vitest without a configured coverage provider (our `vitest.config.ts` has none — no `@vitest/coverage-v8` dependency, no `coverage` section) prints a summary like `Tests  1017 passed (1017)` with **no** `coverage: N%` line. The regex misses → `COVERAGE_UNAVAILABLE` (-1) → `gates.ts:44` `if (coverage > 0)` is false → `result.coverage` stays 0 → gate passes with `cov=0%`.
- **Java** (`src/gates.ts:149`): `mvn test ... || echo 'coverage: 0%'` — plain `mvn test` prints no coverage at all (needs jacoco), so the `||` branch literally fabricates `coverage: 0%`, which the regex *accepts* as a real 0. Java coverage is likewise never measured.
- **Go** (`src/gates.ts:148`): `go test -cover ./...` prints `coverage: 85.2% of statements` per package — this one works.

Net effect: for 2 of 3 languages the advertised coverage gate is fiction. A spec can set `--coverage 95` and the loop will pass at any actual coverage.

## Proposed fix

1. **TypeScript**: parse vitest's real coverage output. Add `@vitest/coverage-v8` as a devDependency and configure `coverage.provider: "v8"` in `vitest.config.ts`; parse the `All files | % Stmts` summary line (or use `--reporter=json` coverage output) instead of the `coverage: N%` regex. Fallback when the provider is absent: report `COVERAGE_UNAVAILABLE` and **fail the gate with a named reason** ("coverage tool not configured") instead of silently passing at 0.
2. **Java**: add a jacoco plugin invocation (`mvn jacoco:report` or the surefire+jacoco combo) and parse the jacoco CSV/XML totals; same unavailable-then-fail fallback.
3. **Gate semantics**: distinguish "coverage measured and below threshold" (fail, current behavior) from "coverage unmeasurable" (fail with a distinct message, or warn+pass if the user explicitly passed `--coverage 0`). Never let unmeasurable collapse to 0 and pass.
4. Update `SPEC.md`'s gate description and the `--coverage` docs to state the tooling requirement per language.

## Acceptance

- In a TS project without a coverage provider: gate output names the missing coverage tooling (no silent `cov=0%` pass), and the failure message is distinguishable from a real below-threshold failure.
- In a TS project with `@vitest/coverage-v8` configured: a real percentage appears in the gate log and a sub-threshold run fails the gate.
- Java: same two properties with jacoco.
- Go behavior unchanged.
- `npm test` green; new unit tests cover the three parser branches (measured / below threshold / unavailable).

## Evidence

Session `01a0155a` (spec 10), `loop-debug` entries: `Gate fail (11 failures) [compile=true tests=false cov=0%]`, `Gate pass [compile=true tests=true cov=0%]` ×2 — all phases, all gates, zero coverage ever measured. Same pattern throughout session `01a011fa` (spec 09).
