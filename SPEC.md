# loop — Adversarial 3-Agent Code Generation Loop (Go, Java, TypeScript)

## Invariant Rules

1. **Tests are the spec translation.** The Tester writes tests independently from the Writer. Tests define what "correct" means. Writer implements to pass them.
2. **Adversarial separation.** Tester never sees Writer's implementation. Writer never modifies tests (except via dispute). Each has a different lens on the spec.
3. **Raw signals only.** Gate results are raw `go test -json` output. No LLM summarization of failures.
4. **Agent-driven disputes.** The Writer chooses: fix or dispute. The system provides the mechanism, not the mandate.
5. **Escalation is the safety valve.** Impasse → human. No infinite loops.
6. **Provenance is the session.** Every phase transition, gate result, refusal, and dispute is in the session JSONL. Pre-implementation negotiation uses `loop-negotiate` customType. Phase B disputes use `loop-dispute`. That IS the review artifact.
7. **Enforcement by filename.** `*_test.go` vs `*.go`. No hardcoded directories. Agent decides structure.
8. **Tester owns the contract.** Stub signatures are the API surface. Tester writes both stubs and tests — they are two sides of the same contract. Writer fills in the bodies. Writer must preserve stub signatures (function names, parameter types, return types). Changing a signature is a sign the tests or design is wrong — use dispute.
9. **Single module.** The loop operates on a single `go.mod` at `ctx.cwd`. Multi-module monorepos or workspaces are out of scope; run `/loop` per module.

## Overview

Automated test-driven development cycle using three AI agent roles that take turns, with adversarial negotiation phases between them. Each phase is gated by independent build/test/coverage checks. Phase transitions are driven by `agent_settled`.

**Spec is the target state.** The existing `index.ts` implements a subset of this. The spec describes the full system.

**Multi-language support:** Go, Java (Maven), TypeScript (Vitest/Jest). Language is auto-detected from project files (`go.mod`, `pom.xml`, `package.json`), or explicitly set via `/loop --language java`.

**Constraints:** Single module at `ctx.cwd`. Gate commands are language-specific (see Language Support).

## Agent Roles

| Role | Phases | Responsibility | Allowed Writes |
|------|--------|----------------|----------------|
| **Reviewer** | 0 | Identify ambiguities, missing edge cases, propose clarifications | None (read-only) |
| **Tester** | A | Write the contract: stubs + tests | Test files + source stubs |
| **Writer** | negotiate, B | Propose approach, implement to pass tests, dispute incorrect tests | Source files only |
| **Cleaner** | C | Refactor for readability | Source files only (not test files) |

## Language Support

Three languages are supported. Language is auto-detected from project files, or explicitly set via `--language` flag.

### Go

- **Detection:** `go.mod` exists at `ctx.cwd`
- **Test files:** `*_test.go`
- **Compile:** `go build ./...`
- **Test:** `go test -json ./...` (parsed with `Set`/`Map` for subtest accuracy)
- **Coverage:** `go test -cover ./...`
- **Prompts:** Sentinel errors (`errors.Is`), table-driven tests, `go mod init` for version, `math.Abs` epsilon for floats
- **Enforcement:** Phase A allows `*.go`, `*_test.go`, `go.mod`, `go.sum`, `Makefile`

### Java (Maven)

- **Detection:** `pom.xml` exists at `ctx.cwd`
- **Test files:** `*Test.java` (under `src/test/java`)
- **Compile:** `mvn compile -q`
- **Test:** `mvn test 2>&1` (parsed for `BUILD SUCCESS` / failure lines)
- **Coverage:** `mvn jacoco:report` (optional, falls back to 0% if not configured)
- **Prompts:** Custom exceptions (`assertThatThrownBy`), JUnit 5 `@ParameterizedTest`, AssertJ assertions, records for DTOs, constructor injection
- **Enforcement:** Phase A allows `*.java`, `pom.xml`, `mvnw`, `.mvn`

### TypeScript (Vitest/Jest)

- **Detection:** `package.json` with `typescript` in devDependencies
- **Test files:** `*.test.ts`, `*.spec.ts`
- **Compile:** `npx tsc --noEmit`
- **Test:** `npx vitest run --reporter=json` (auto-detects Vitest vs Jest)
- **Coverage:** `npx vitest run --coverage` (optional)
- **Prompts:** Custom error classes, `expect().toThrow()`, `expect().toBeCloseTo(val, 2)` for floats, strict types (`no any`), `describe/it` BDD style
- **Enforcement:** Phase A allows `*.ts`, `package.json`, `tsconfig.json`

## Conversation Phases

### Phase 0 — Baseline + Spec Review

Phase 0 has two steps.

**1. Baseline check (hard gate, no agent).**

The project's existing test suite is run (`go test ./...`, `mvn test`, `npx vitest run` — same per-language commands as the gate runner). All tests must pass before the loop starts; a project with no test files yet is a valid (trivially green) baseline. On failure, `/loop` aborts with the failing tests and state remains `idle` — the loop does not start. A red baseline is not a starting point: the Phase B gate requires *all* tests to pass, so pre-existing failures would be charged against the Writer's round budget.

**2. Spec Review (Reviewer agent).**

Reviewer reads the spec, identifies ambiguities and missing edge cases, proposes concrete test-case clarifications, and surfaces them to the human for approval. The human answers focused questions once, then the loop runs unattended. A spec template and filling prompt derived from observed Phase 0 findings live in `docs/spec-authoring.md`; specs written against it typically clear review in one round.

**Activates automatically** when the spec meets any threshold:
- 3+ functions described
- Any mention of errors, I/O, or concurrency
- Flagged manually via `/loop --review`

For trivial specs (1–2 functions, no I/O, no errors), Phase 0 is skipped.

**Flow:**
1. Reviewer reads the spec.
2. Reviewer enumerates every ambiguity, missing edge case, underspecified behavior.
3. Reviewer proposes concrete test cases for each finding.
4. Reviewer outputs structured findings in Finding format.
5. Human approves, rejects, or modifies each finding.
6. Clarification addendum appended to spec.
7. Phase A receives spec + addendum.

**Finding format:**
```
### Finding N: [Category] — [Function/Feature]

**Ambiguity:** [Quote the unclear phrase]
**Interpretation A:** [One reading]
  - Test: `Func("input")` → `expected`
**Interpretation B:** [Another reading]
  - Test: `Func("input")` → `expected`
**Recommendation:** [Agent's preferred interpretation]
```

**Categories:** Ambiguous phrase, Edge case missing, Underspecified behavior, Example-prose conflict, Type contract gap.

**Enforcement:** Read-only. No file writes. Phase 0 is discussion-only — the Reviewer surfaces findings, the human decides.

### Phase A — Tester writes the contract

Tester reads the spec, then writes both stubs and tests. Stub signatures define the API surface. Tests verify behavior. Together they are the contract.

1. Tester reads the spec.
2. Tester identifies every business rule, edge case, and error path.
3. Tester creates directory structure, writes `*.go` stubs (signatures only, no implementation logic), and writes `*_test.go` as comprehensive table-driven test suites.
4. Tester stops producing tool calls. `agent_settled` fires → gate: `go build ./...` — stubs and tests must compile together.
5. On pass → enter negotiation. On fail → Tester fixes (up to `maxA` rounds).

No explicit completion tool. The agent's silence triggers the gate.

**Enforcement during A:** Tester can write both `*_test.go` and `*.go` files. Writer cannot write or read `*_test.go`.

### Negotiate — Writer proposes, Tester approves

After Phase A, the Writer reads the spec and the tests, then proposes an implementation approach.

1. Writer reads the spec and `*_test.go`.
2. Writer calls `negotiate_propose`:
   - `"agree"` — tests match the spec as-is, Writer proceeds to implement.
   - **proposal text** — describes planned approach: what types, functions, behavior.
3. Tester reviews via `negotiate_review`:
   - `"approve"` — proposal accepted, enter Phase B.
   - **feedback** — Writer revises and proposes again.
4. After `maxNegotiate` rounds without approval → escalate to human.

**This negotiation is about approach, not contract.** The tests already define what "correct" means. Writer is saying "here's how I plan to implement this" — Tester confirms the approach satisfies the spec, or pushes back.

**Negotiation is discussion-only.** No file writes. If the Writer needs to illustrate an approach, they describe it in the proposal text. File writes happen in Phase B. Provenance entries use customType `loop-negotiate`.

### Phase B — Writer implements

Writer writes correct code to pass all tests.

1. Writer reads `*_test.go` and `*.go` stubs. Writer preserves stub signatures — fills in function bodies without changing names, parameter types, or return types.
2. Writer implements the code.
3. Writer stops producing tool calls. `agent_settled` fires → gate: `go test -json ./...` + `go test -cover ./...` (≥`coverageThreshold`%).

#### B pass → Phase C

All tests pass and coverage ≥ threshold: transition to Phase C.

#### B fail → Fix or Dispute

Tests fail. The Writer agent **chooses** its response:

**Option 1: Blind retry** — Writer reads the raw failure output, fixes the code, stops producing tool calls. `agent_settled` fires, gate re-runs. No tools involved. Appropriate when the failure is clearly an implementation bug. The round cap is the pressure mechanism — cosmetic edits that don't fix the failure still consume rounds.

**Option 2: Dispute** — `state.phase === "B"` so the system knows this is a dispute context (not pre-implementation negotiation). Writer calls `negotiate_propose` claiming the test is wrong (e.g., "Test `TestX/empty_input` expects nil but the spec says return zero-value"). Tester responds via `negotiate_review`:
   - `"approve"` (concede) — Tester agrees the test is wrong. Tester updates `*_test.go`. Gate re-runs. Phase B retries.
   - **defense text** — Tester says the test is correct. Writer must fix code. Phase B retries. Writer may raise a new dispute in a subsequent round with additional evidence.

After `maxDispute` dispute rounds without resolution → escalate.

**Round accounting:** One gate run = one round, regardless of whether it was a blind retry or a dispute exchange. Implementation attempts + dispute cycles combined are capped at `maxB`. If exhausted → escalate.

**Enforcement during dispute:** When Tester calls `negotiate_review` with `"approve"`, the handler sets a flag (`state.disputeMode = true`), transitions the Tester into a turn to fix `*_test.go`. The enforcement override lasts for that one turn only — cleared when `agent_settled` fires and the gate runs. Provenance entries use customType `loop-dispute` (distinct from `loop-negotiate`).

### Phase C — Cleaner refactors

1. Cleaner reads the spec, tests, and current implementation.
2. Cleaner refactors `*.go` files (not `*_test.go`):
   - No method over 200 lines
   - Return early, return often
   - Extract helpers for logical sub-tasks
   - Clear names over clever compressions
3. Gate: `go test ./...` — all tests must still pass. Coverage is not checked in Phase C; refactoring may restructure code without changing test surface. If coverage matters, the human re-runs the full loop.

#### C pass → done

All tests pass: loop complete.

**Spec archive:** the spec file is renamed with a `done-` prefix at the B→C boundary — the moment the implementation is complete and the gate is green (e.g. `spec.md` → `done-spec.md`). Archiving happens before Phase C so a crash in Phase C still leaves the work marked done. The rename is idempotent (an already `done-`-prefixed file is left untouched), never overwrites an existing file, and is skipped silently if the spec file is missing.

#### C fail → retry

Tests fail after refactoring. Cleaner fixes and retries (up to `maxC` rounds).
If exhausted: mark done, keep original implementation.

## Commands

### `/loop [--language L] [--coverage N] <spec-path>`

Starts the loop at Phase A. Language is auto-detected from project files (`go.mod`, `pom.xml`, `package.json`), or explicitly set.

Before any agent runs, the Phase 0 baseline check runs: the existing test suite must be green (or absent). If it is red — or the test runner is unavailable — the command aborts with the failing tests, state stays `idle`, and the loop does not start.

```
Usage: /loop path/to/spec.md
       /loop --coverage 90 path/to/spec.md
       /loop --language java path/to/spec.md
       /loop --language typescript --coverage 85 path/to/spec.md
```

`--language L` — go (default), java, typescript
`--coverage N` — overrides the default 80% threshold.

### `/loop-status`

Shows current state as structured text. Example:

```
Phase: B, round 3/5
  compile: ✓
  tests: ✗ (2 failures)
  coverage: 74% (threshold: 80%)
  failures:
    - TestX/empty_input: expected nil, got zero-value
    - TestY/overflow: panic
  last action: Writer dispute — Tester defended
```

Failure output is truncated for readability. Full details available via `/loop-debug`.

### `/loop-continue`

After escalation, restart from the current phase with a fresh round counter. The `coverageThreshold` and other limits persist from the original `/loop` invocation (stored in `LoopState`). Files remain in their last-modified state on disk.

### `/loop-restart <phase>`

Restart the loop from a specific phase. E.g., `/loop-restart B` jumps to Phase B with round 1. Limits (including `coverageThreshold`) persist from `LoopState`.

### `/loop-debug`

Shows the last 20 debug entries (phase transitions, gate results, refusals, disputes). With `--log-bug <name>` (multi-word names allowed; `--log-bug=<x>` equivalent), it extracts the session's five emitted `loop-*` entry types in-process (no disk read) and writes `bug-fix-<slug>.md` into the working directory — a self-contained, `/loop`-runnable spec:

- Title `# Bug: <name>` (name verbatim) + `> Resolve with: /loop bug-fix-<slug>.md`
- `## Context` — auto-filled from `state.current`: `phase=<phase>, round=<round>, spec=<specPath>, language=<language>` (or `no active loop` when idle)
- `## Observed problem` / `## Proposed fix` — placeholder prompts (fill in before running the loop)
- `## Log excerpt` — one formatted line per loop entry, in session order (`(no loop events found in this session)` when none)
- `## Acceptance` — baseline bullet + a fill-in check

Name is slugified (lowercase; non-`[a-z0-9]` runs → `-`; trimmed). Empty name → usage warning, no file. An existing `bug-fix-<slug>.md` → error notify, original file untouched. A missing/unwritable working directory → error notify (`Failed to write bug-fix-<slug>.md: <message>`); the write never throws.

### `/loop-cancel`

Stop the loop, return to idle state.

## Tools

### `negotiate_propose`

**Called by:** Writer

**Parameters:** `plan` (string) — implementation approach, or `"agree"` to accept tests as-is, or a dispute claim referencing the spec.

**Use contexts:**
- **Post-Phase A negotiation:** Writer proposes how they plan to implement. `"agree"` skips to Phase B.
- **Phase B dispute:** Writer claims a specific test is wrong and why.

**Effect:** Records the proposal. Transitions turn to Tester for `negotiate_review`. The handler checks `state.phase` to determine context: `"negotiate"` applies `maxNegotiate` cap, `"B"` applies `maxDispute` cap.

### `negotiate_review`

**Called by:** Tester

**Parameters:** `decision` (string) — `"approve"` to accept, or feedback text.

**Use contexts:**
- **Post-Phase A negotiation:** Approve Writer's approach, or suggest changes.
- **Phase B dispute:** `"approve"` (concede — test is wrong, Tester will fix it), or defense text (test is correct, Writer must fix code).

**Effect:**
- `"approve"` during `"negotiate"` phase → transition to Phase B.
- `"approve"` during `"B"` phase (dispute concede) → Tester gets one turn to fix `*_test.go`, then gate re-runs.
- Feedback / defense → Writer revises (increment round).
- Round ≥ phase limit (`maxNegotiate` or `maxDispute`, determined by `state.phase`) → escalate.

## Gate Runner

Three independent gates evaluated in order. Commands are language-specific. The Phase 0 baseline check reuses the Tests command before the loop starts; it is exit-code-based (a valid baseline is "all tests pass" or "no tests exist"), not a per-phase gate.

| Gate | Go | Java (Maven) | TypeScript (Vitest) | Parse |
|------|-----|--------------|---------------------|-------|
| Compile | `go build ./...` | `mvn compile -q` | `npx tsc --noEmit` | success/fail + error text |
| Tests | `go test -json ./...` | `mvn test 2>&1` | `npx vitest run --reporter=json` | per-test/subtest pass/fail |
| Coverage | `go test -cover ./...` | `mvn jacoco:report` (optional) | `npx vitest run --coverage` (optional) | percentage, threshold ≥ `coverageThreshold` |

Per-phase gate requirements:

| Phase | Gate | Pass Condition |
|-------|------|----------------|
| A | Compile | `go build` succeeds (stubs + tests compile together) |
| B | Tests + Coverage | All pass AND ≥ `coverageThreshold`% |
| C | Tests | All pass (coverage not checked — refactoring may restructure without changing test surface) |

## State Machine

```
idle
  │ /loop [--coverage N] <spec-path>
  ▼
Phase A (Tester writes contract)
  │ compile pass ──────────────┐
  │ compile fail               │
  ▼                            │
Tester writes stubs + tests    │
  │                            │
  ▼                            │
Gate: go build                 │
  │                            │
  ▼                            │
Negotiate ◄────────────────────┘
  │ approve ───────────────────┐
  │ feedback (round < max)     │
  │ escalate (round ≥ max)     │
  ▼                            │
Writer proposes                │
  │                            │
  ▼                            │
Tester reviews ◄───────────────┘
  │
  ▼
Phase B (Writer implements)
  │ all pass ──────────────────┐
  │ some fail                  │
  ▼                             │
Writer implements              │
  │                             │
  ▼                             │
Gate: go test + cover          │
  │                             │
  ▼                             │
Writer: fix or dispute?        │
  │ ┌──────────────────────────┘
  │ │
  ▼ ▼
blind retry    negotiate_propose (dispute)
  │         │
  ▼         ▼
Writer fixes  Writer claims test wrong
  │         │
  ▼         ▼
Gate re-run  negotiate_review
  │         │ "approve" ──► Tester fixes test, gate re-runs, retry B
  │         │ "defend"  ──► Writer fixes code, retry B
  │         │
  │         ▼
  │    (round < maxDispute) ──► retry B ◄────────┘
  │    │
  │    ▼ (round ≥ maxDispute)
  │    escalated
  │         │
  └─────────┘
              │
              ▼
Phase C (Cleaner refactors)
  │ tests pass ────────────────┐
  │ tests fail                 │
  ▼                             │
Cleaner refactors              │
  │                             │
  ▼                             │
Gate: go test                  │
  │                             │
  ▼                             │
tests pass ──► done            │
  │                             │
  ▼                             │
(round < maxC) ──► retry C ◄───┘
  │
  ▼ (round ≥ maxC)
done (cleaner failed)
```

## Enforcement Rules

Enforcement is language-specific. File patterns (`*_test.go`, `*Test.java`, `*.test.ts`) and Phase A whitelists are per-language config.

| Phase | Can Read | Can Write | Blocked |
|-------|----------|-----------|---------|
| 0 (Reviewer) | Spec only | N/A | All file writes |
| A (Tester) | Spec, project files | Test files + source stubs | N/A (Tester owns contract) |
| negotiate | Spec, test files, stubs | N/A (tools only) | File writes |
| B (Writer) | All project files | Source files (implementation) | Test files |
| B (dispute, Tester) | All project files | Test files only | Non-test source |
| C (Cleaner) | All project files | Source files (refactor) | Test files |

## Limits

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `maxA` | 3 | Tester contract compile fix rounds |
| `maxNegotiate` | 3 | Pre-implementation negotiation rounds before impasse |
| `maxB` | 5 | Total B rounds (implementation + dispute cycles combined). One gate run = one round. |
| `maxDispute` | 3 | Dispute rounds before escalate (subset of maxB). One gate run = one round. |
| `maxC` | 3 | Cleaner refactor retry rounds |
| `coverageThreshold` | 80 | Minimum coverage percentage for B pass (overridden by `--coverage` flag) |

## Escalation

Escalation means: stop the loop, notify the human, mark phase as `escalated`.

**File state:** Files remain on disk in their last-modified state (which may be broken). The session JSONL contains full provenance — every tool call, file write, gate result. That IS the audit trail.

**Human affordances (via commands):**
- `/loop-status` — inspect current phase, round, last gate result, dispute history.
- `/loop-continue` — restart from the current phase with a fresh round counter. Starts from whatever state files are in after human intervention.
- `/loop-restart <phase>` — jump to a specific phase (e.g., `/loop-restart B`).
- `/loop-cancel` — stop and return to idle.
- `/loop <spec-path>` — full restart from Phase A, resets limits to defaults.

**Limit persistence:** `coverageThreshold` and other parameters are stored in `LoopState` (persisted via session entries). `/loop-continue` and `/loop-restart` preserve them. Only a fresh `/loop <spec-path>` resets to defaults.
