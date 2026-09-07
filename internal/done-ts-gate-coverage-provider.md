# fix-ts-gate-coverage-provider

## Problem

Verified current state as of writing (2026-09-04):

- `src/gates.ts:106-113` — `getTestCommand` returns `"npx vitest run --coverage"` for `typescript`. The command is unconditional: it assumes a vitest coverage provider is installed in the gated project.
- This repo (the dogfood target) has **no** coverage provider: `package.json` devDependencies are `@types/node`, `typebox`, `typescript`, `vitest` — no `@vitest/coverage-v8`, and `vitest.config.ts` has no `coverage` section. Running the gate command here reproduces the failure:
  ```
  $ npx vitest run --coverage
   MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'
  ```
  vitest exits non-zero **before running a single test**.
- `src/gates.ts:44-50` — `runGates` treats the exit code as the verdict (`result.tests = test.exitCode === 0`) and `parseTestOutput` (src/gates.ts:162-186) finds zero `FAIL` lines in the error banner. The gate therefore reports `tests=false, failures=[]` — the log line `Gate fail (0 failures) [compile=true tests=false cov=0%]`.
- `src/events/agent-settled/gate-transition.ts:67` renders exactly that line; `src/transitions.ts` then retries (B/C round increment) until the phase budget exhausts and the run escalates — even though the suite is green.

**Runtime evidence (the artifact this spec is about):** session `01a069ac-de27-758c-957b-9c4f840061ef` (spec `internal/spec-command.md`, 2026-09-03/04). Every B/C gate logged `Gate fail (0 failures) [compile=true tests=false cov=0%]` while the Writer's own `npm test` runs in the same session showed `1150 passed, 12 skipped, 0 failed`. B burned rounds 1–5 and escalated; C burned rounds 2–3. The Writer could never see a failure to fix because there was none — the gate tool itself was crashing on the missing provider.

**Provenance of the contradiction:** `bug-coverage-noop-ts.md` (filed 2026-08-18, commit 08b298a) documented that TS coverage was a silent no-op and proposed: add `@vitest/coverage-v8`, configure the provider, and when the provider is absent, never collapse "unmeasurable" into a pass-or-fail signal. The dep was never added. Then the gate-signal-integrity refactor (commits 7496993/04b9519, contract `internal/bug-gate-signal-integrity.md`) removed the `|| echo 'coverage: 0%'` fallbacks and merged coverage into the single test run. `internal/bug-gate-signal-integrity.md:68` pins "vitest coverage provider missing" as *unparseable → skip the coverage sub-check — an environment fact, not a code failure*. But with the merged command, a missing provider no longer yields unparseable output — it yields a **crashed run**, which the exit-code rule (`internal/bug-gate-signal-integrity.md`: exit code is the gate signal) reads as a test failure. The two specs contradict each other; this spec resolves the contradiction in favor of the environment-fact reading, at the command-selection layer.

## Target

`getTestCommand` for `typescript` becomes environment-aware: when a vitest coverage provider is resolvable from the gated project, the gate runs `npx vitest run --coverage` (current behavior, real percentage parsed by the existing `parseCoverage`); when it is not, the gate runs plain `npx vitest run` and the coverage sub-check is skipped with the existing unavailable semantics (coverage stays 0, no sub-check, no new failure mode). Go and Java commands are untouched. No new gate verdict is introduced: a provider-less TypeScript project gates on compile + test exit code only.

## Interface

- New exported pure helper in `src/gates.ts`:
  ```ts
  export function hasVitestCoverageProvider(cwd: string): boolean
  ```
  Implementation: `require.resolve("@vitest/coverage-v8", { paths: [cwd] })` inside try/catch → `true`/`false`. Synchronous, no spawn, no shell. (The probe names v8 specifically because that is the provider `bug-coverage-noop-ts.md` prescribes; a project using `@vitest/coverage-istanbul` instead is out of scope — see Scope.)
- `getTestCommand` signature gains an optional third parameter, defaulting to the current unconditional behavior so existing call sites and tests keep compiling:
  ```ts
  export function getTestCommand(language: LanguageKey, buildTool?: BuildTool, opts?: { cwd?: string }): string
  ```
  When `language === "typescript"` and `opts.cwd` is provided: return `"npx vitest run --coverage"` if `hasVitestCoverageProvider(opts.cwd)` else `"npx vitest run"`. When `opts.cwd` is absent (direct unit calls), return the current string verbatim.
- `runGates` (src/gates.ts:17-63) passes `{ cwd }` to `getTestCommand` at the single call site (line 44). No other signature changes.
- Persisted state: untouched — `GateResult` shape is unchanged; `lastGateResult` entries from old sessions stay valid.

## Behavior

Decision table for `getTestCommand("typescript", undefined, { cwd })` (first-match-wins; other languages fall through to the existing switch):

| # | Condition | Command returned | Coverage sub-check |
|---|---|---|---|
| 1 | `hasVitestCoverageProvider(cwd)` is true | `npx vitest run --coverage` | runs (existing `parseCoverage` row, src/gates.ts:53-57) |
| 2 | `hasVitestCoverageProvider(cwd)` is false | `npx vitest run` | skipped — `parseCoverage` finds no `All files` line → returns null → `result.coverage` stays 0 (existing "unavailable → skip" semantics, `internal/bug-gate-signal-integrity.md:68`) |
| 3 | `opts.cwd` absent (unit calls) | `npx vitest run --coverage` (today's string, verbatim) | n/a — command selection only |

Go row (`go test -json -cover ./...`) and Java rows (`mvn test -Djacoco.skip=false` / `gradle test`) are unchanged and do not consult the probe.

Side-effect contract: the probe performs only a module resolution read (no writes, no network, no spawn). It runs once per gate, inside `runGates`, before the test `execCommand`. A probe failure of any kind resolves to `false` (plain run) — the probe must never throw out of `getTestCommand`.

Quirks (current behavior, do not fix):

- `parseCoverage`'s TypeScript pattern (`/All files\s*\|\s*\d+\s*\|\s*(\d+(?:\.\d+)?)/`, src/gates.ts:88-90) parses the *statements* column of the v8 table. Kept as-is.
- The 60 s test timeout (src/gates.ts:44) applies to both command forms. A coverage run is slower than a plain run; the timeout is not adjusted in this unit.
- `execCommand` splits the command on whitespace (src/gates.ts:128-135); both command forms are two tokens (`npx`, `vitest`, …) and split identically.

Intended shifts:

- **Provider-less TS projects (including this repo):** before — every B/C gate crashes the test tool and reports `tests=false, failures=[]`, burning rounds to escalation. After — the gate runs plain `vitest run`; a green suite passes the gate with `cov=0%` and no coverage sub-check.
- **Provider-configured TS projects:** no change in command, output, or parsing.
- **Existing unit tests calling `getTestCommand("typescript")` without `cwd`:** no change (row 3 preserves the verbatim string).

Ownership: `src/gates.ts` performs the probe and command selection; `test/gate-signal-integrity.test.ts` asserts it (existing file for this contract — new cases live there, not in a new file).

## Inventory

- `src/gates.ts`: added `hasVitestCoverageProvider` (exported); `getTestCommand` gains `opts` parameter + typescript branch; `runGates` call site (line 44) passes `{ cwd }`. Import pinned: `import { createRequire } from "node:module"` at the top of the file (a named ESM import — this is what makes `vi.mock("node:module")` possible in unit tests; the `createRequire(import.meta.url)` inline form is rejected because a file-level mock cannot intercept it). The probe body is `createRequire(join(cwd, "package.json")).resolve("@vitest/coverage-v8")` in try/catch → `true`/`false` (the anchor file must live inside `cwd` so resolution searches `cwd/node_modules` upward; `paths:` is not used — the anchor-file form is what the Phase 0 probe verified empirically).
- `test/gate-signal-integrity.test.ts`: existing `describe("getTestCommand (B/C single invocation)")` block (lines 152-176) — the typescript case (lines 160-162) is kept for row 3. **Coexistence constraint (Phase 0 blocker 1):** this file's `runGates — exit code is the gate signal` block (lines ~196-270) executes the **real** toolchain in temp cwds (S1 go, S2 ts, 120 s timeouts) and must NOT receive a file-level `vi.mock("node:child_process")` — one `vi.mock` per file applies to the whole file and would break those live tests. The mocked `runGates` wiring cases therefore live in a **new file** `test/gates-provider-wiring.test.ts` (file-level `vi.mock("node:child_process")` + `vi.mock("node:module")`), and `test/gate-signal-integrity.test.ts` gains only the pure `getTestCommand`/`hasVitestCoverageProvider` cases (mocking `node:module` only — safe: that file never mocks `node:child_process`, and the pure functions never spawn).
- `test/nested-vitest.test.ts`: reviewed and **unchanged** — all its tests are `it.skip`'d (pending `internal/bug-slow-gate-signal-tests.md`; the file hangs the suite under vitest 4.1.10 + node 26). Its skipped S2 pin (`args` exactly `["vitest", "run", "--coverage"]`) stays valid for row 1 and is re-enabled by that bug spec's resolution, not by this unit.
- `internal/bug-gate-signal-integrity.md`: no edit required — its row-6 "provider missing → skip" pin is what this unit makes true at the command layer. If Phase 0 finds the wording needs a pointer to this spec, that is a needs-doc finding, not a blocker.
- `bug-coverage-noop-ts.md` (repo root): see Scope — the TS row is closed by this unit; the file is NOT renamed to `done-` because the Java/jacoco row and the "fail with a named reason" semantics remain open. Its header note must record the **deliberate reversal**: the predecessor recommended "provider absent → fail the gate with a named reason"; this spec instead follows `internal/bug-gate-signal-integrity.md:68` (row 6: unmeasurable = environment fact = skip the sub-check, never a fabricated verdict) and degrades to a plain test run. The named-reason semantics stay open for the Java row.

## Test Strategy

- Baseline: `npx vitest run` green (1150 passed, 12 skipped as of writing); `npx tsc --noEmit` clean.
- Per-test disposition in `test/gate-signal-integrity.test.ts`:
  - Kept: the go/java/gradle command pins (lines 155-176) — unchanged, no `cwd` passed.
  - Kept: the existing typescript pin `getTestCommand("typescript")` → `"npx vitest run --coverage"` (row 3).
- New tests (all mock the process/module boundary — no real vitest, no real `node_modules` mutation, per CLAUDE.md TEST SPEED RULE):
  - In `test/gate-signal-integrity.test.ts` (pure, `vi.mock("node:module")` only): Row 1 — mocked `createRequire(…).resolve` resolves → `getTestCommand("typescript", undefined, { cwd: X })` returns the `--coverage` string. Row 2 — resolve throws → returns `"npx vitest run"`; the probe never throws out of `getTestCommand` (assert the call returns, not throws). `hasVitestCoverageProvider` directly: resolvable → true; unresolvable → false; `resolve` throwing a non-Error → false.
  - In `test/gates-provider-wiring.test.ts` (new file; file-level `vi.mock("node:child_process")` + `vi.mock("node:module")`): a typescript `runGates` with the provider absent invokes `vitest` with args `["run"]` (no `--coverage`); with the provider present, `["run", "--coverage"]`. Compile step mocked to exit 0; test step exit 0.
- Untouched: every other test file stays unchanged; the mechanism is that `getTestCommand`'s new parameter is optional and defaults to today's string.
- Live-toolchain rules: not applicable — no test in this unit spawns a real tool. The probe is a module-resolution call, mocked at the `node:module` boundary.

## Scope lines

- `src/gates.ts`: `hasVitestCoverageProvider` added (exported); `getTestCommand` modified (signature + typescript branch); `runGates` modified (one call site); everything else kept.
- `test/gate-signal-integrity.test.ts`: new cases added; existing cases kept.
- `vitest.config.ts`, `package.json`: **not touched** — deliberately. Installing `@vitest/coverage-v8` here would fix only this repo and mask the general case; the dogfood repo stays provider-less so the row-2 path is what the loop exercises on itself.
- `bug-coverage-noop-ts.md`: kept at repo root (not `done-`); its header gains one line noting the TS row is closed by this spec, the Java row + named-reason semantics remain open.

## Acceptance Criteria

- `npx vitest run` green (38 files) and `npx tsc --noEmit` clean.
- In this repo (provider absent), a real B/C gate run logs `Gate pass` on a green suite with `tests=true` and no `MISSING DEPENDENCY` in the gate output. Checker: run the loop's gate command sequence manually (`npx tsc --noEmit && npx vitest run`) — both exit 0; and the new `runGates` wiring test asserts the invoked args lack `--coverage`.
- Grep sweep 1 (functional): `rg -n "vitest run --coverage" src/` → exactly 1 occurrence (the row-1 return in `getTestCommand`).
- Grep sweep 2 (functional): `rg -n "hasVitestCoverageProvider" src/ test/` → defined once in `src/gates.ts`, called at the `getTestCommand` typescript branch, referenced in `test/gate-signal-integrity.test.ts`.
- Grep sweep 3 (textual): `rg -n "coverage provider" internal/bug-gate-signal-integrity.md` unchanged (no edit to that contract in this unit).
- One criterion per decision-table row above (rows 1–3 each have a named test).

## Dependencies

- `internal/bug-gate-signal-integrity.md` — implemented (that is why the exit code is the verdict and `parseCoverage` has the unavailable→skip semantics this unit relies on).
- `bug-coverage-noop-ts.md` (repo root) — predecessor diagnosis; its TypeScript row is closed by this spec, its Java row is not.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | blocker | Test Strategy claimed `test/gate-signal-integrity.test.ts` "already" mocks `execFile` — it does not; its S1/S2 `runGates` tests (lines ~196-270) run the **real** toolchain in temp cwds, and a file-level `vi.mock("node:child_process")` would break them | Accepted. Mocked `runGates` wiring cases moved to new file `test/gates-provider-wiring.test.ts`; `gate-signal-integrity.test.ts` gains only pure-function cases (`vi.mock("node:module")` only) |
| 2 | blocker | The `createRequire` import style was left as an "or" between two alternatives | Accepted. Pinned: named ESM import `import { createRequire } from "node:module"` — required so `vi.mock("node:module")` can intercept it; probe body uses the anchor-file form `createRequire(join(cwd, "package.json")).resolve(…)` (empirically verified by Phase 0: finds a provider in a temp cwd, throws MODULE_NOT_FOUND for empty/nonexistent cwd → false) |
| 3 | needs-doc | `test/nested-vitest.test.ts` was not named in the Inventory | Accepted. Named as reviewed-and-unchanged; all its tests are `it.skip`'d pending `internal/bug-slow-gate-signal-tests.md`, and its skipped S2 pin stays valid for row 1 |
| 4 | needs-doc | The `bug-coverage-noop-ts.md` header note did not record that this spec reverses the predecessor's "fail with named reason" recommendation | Accepted. Scope line now records the deliberate reversal in favor of gate-signal-integrity row 6 |
| 5 | nit | Auto-scan findings 1–4 (table-parsing artifact, empty-input coverage, unspecified false cases, `LanguageKey` `""` input) | Rejected as false positives: table-parsing artifact; empty-input already covered by the "any probe failure → false" contract; false cases are specified in the decision table; `LanguageKey` is a closed union so `""` is not a legal input |
