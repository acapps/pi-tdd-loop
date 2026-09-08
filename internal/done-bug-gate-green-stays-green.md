# bug-gate-green-stays-green

## Problem

Verified current state as of writing (re-checked against the repo; runtime evidence: session `01a0167f-f4b0-719a-ab7e-ed9e975d65b7`, 2026-08-18, and a manual reproduction in `/tmp` with the repo's `go 1.26.6`):

**The `green stays green` regression test is unpassable by construction, and the Writer's prompt gives it no exit but to grind.**

1. **The test builds a test-only Go module.** `test/gate-signal-integrity.test.ts:232-250` (`exit 0 + no FAIL lines → allPassed true (green stays green)`) calls `makeGoCwd(...)` (`:273-278`), which writes `go.mod` + `main_test.go` only — no non-test `.go` file. In such a module:
   - `go build ./...` exits **1** with `no packages to build` (reproduced: `go build ./...` → exit 1, `go test -json -cover ./...` → exit 0).
   - `runGates` (`src/gates.ts:35-41`) runs the compile check first and **returns early** on `compile.exitCode !== 0` — the test step never runs, so the assertion `outcome.result.tests === true` can never be reached via a `kind: "result"` outcome. The only path to green is the fallback branch `expect(outcome.kind).toBe("error")` — but `go build` failing is a *result* (compile=false), not an *error*, so that branch fails too. **The test cannot pass.** (Reproduced 2026-08-18: `npx vitest run test/gate-signal-integrity.test.ts -t 'green stays green'` → 1 failed.)
   - The same module shape is used by the S1 test (`:193-215`) — but S1 *expects* red, so the compile-early-return happens to satisfy it. S1 passes for the wrong reason: it is not exercising the exit-code signal at all, it is exercising the compile check.
2. **The Writer is told to fix source, never the test — and the dispute channel is soft.** `buildWriterPrompt` (`src/events/before-agent.ts:160-166`): `Preserve stub signatures. Dispute wrong tests via negotiate_propose.` — "Dispute wrong tests" is permissive, not mandatory, and `negotiate_propose` from Phase B is only wired for the negotiate phase (`src/commands.ts:64`, `src/events/agent-settled/negotiate.ts`). In Phase B proper, calling `negotiate_propose` has no defined transition. So when the Writer hits a test that is wrong *by construction*, the prompt offers a tool that does nothing and a prohibition (`Do not modify *.test.ts`) — the remaining option is to keep editing source and re-running.
3. **Observed behavior (session evidence):** the Writer ran the S1 test **~40 times in a row** (session lines 766–875, identical command, all passing), then the session ends mid-loop — no gate pass, no transition, no Done. It was grinding a passing test while the failing, unpassable one (`green stays green`) sat unaddressed. Separately, the `corrupted language → throws` test uses `expect(async () => await f()).toThrow(...)`, which cannot catch an async rejection (needs `.rejects.toThrow()`); the Writer spent ~50 min on vitest flags and a throwaway repro file instead of disputing it.

**Why this is a loop bug, not just a bad test:** the contract file is the Tester's artifact, the Writer's only source of truth in Phase B, and the gate's only input. When the contract is unpassable, the loop has no failure mode for "the contract is wrong" — only "the Writer is slow". The session burned ~30 minutes and ended without a result.

## Target

After this fix: (1) the `green stays green` and S1 tests construct a **buildable** module (a non-test `main.go`), so the compile check passes and the test step's exit code is actually the signal under test; (2) the Writer's Phase B prompt makes the dispute **mandatory and reachable**: when a test is unpassable by construction, the Writer must call `negotiate_propose` (the tool is registered in Phase B), and a proposal from Phase B routes to the existing dispute flow (Tester review → concede/fix or defend/retry); (3) `docs/spec-authoring.md` gains the live-toolchain failure class so the Tester does not write these tests again.

## Interface

- `test/gate-signal-integrity.test.ts` (contract fix, done by the Tester in a dispute-fix turn, not the Writer):
  - `makeGoCwd` gains a required non-test file: writes `main.go` (`package main\n\nfunc main() {}\n`) alongside `main_test.go`. Both live tests (S1 `:193`, green-stays-green `:232`) then compile.
  - S1 additionally gains the negotiated `it.skipIf` + 30s timeout per `internal/bug-negotiate-drift.md` (the agreement that never landed).
  - `test/events/agent-settled/index.test.ts:140-144` (`corrupted language → throws`): `expect(async () => await handleAgentSettled(input)).toThrow(...)` → `await expect(handleAgentSettled(input)).rejects.toThrow(/Language not available/)`.
- `src/events/before-agent.ts` (`buildWriterPrompt`): the message line `Preserve stub signatures. Dispute wrong tests via negotiate_propose.` becomes:
  `Preserve stub signatures. If a test is wrong or unpassable by construction, stop and call negotiate_propose with the dispute — do not keep editing source to satisfy it.`
  Verbatim pin (this exact string, in the prompt).
- `src/events/agent-settled/index.ts` (dispatcher): `negotiate_propose` arriving in Phase B (not the negotiate phase) is routed to `handleNegotiateSettled` with the current state — i.e. the dispute flow works from B, not only from the negotiate phase. (Mechanism: the dispatcher's step that currently only fires in `phase === "negotiate"` also fires in `phase === "B"` when `state.awaitDisputeFix` is unset; the Tester-review round then runs in the negotiate phase via the existing `advanceToPhaseNegotiate` — no new phase.)
- `docs/spec-authoring.md`: new failure class + template line + filling-prompt rule (see Inventory).

## Behavior

Decision table: Writer calls `negotiate_propose` in Phase B (first-match-wins):

| # | Condition | Effect |
|---|-----------|--------|
| 1 | `state.phase === "B"` and the proposal is a dispute (not 'agree') | `state.awaitDisputeFix` unset, phase → `negotiate` round 1 with the proposal recorded (existing `handleNegotiateSettled` path); Tester reviews via `negotiate_review` |
| 2 | Tester approves the dispute | existing: `awaitDisputeFix = true`, Tester-fix turn (`buildDisputeFixPrompt`, `src/events/before-agent.ts:168-181`) — the Tester fixes the contract file |
| 3 | Tester defends the test | existing: Writer retry in B with the defense text |
| 4 | `state.phase === "B"` and the proposal is 'agree' | no-op with debug note (nothing to do) — current behavior for 'agree' in the negotiate phase, extended |

- Verbatim pins: the dispute-fix prompt (row 2) is unchanged: `You are the TESTER (dispute fix). You conceded that the Writer's dispute was valid.\nFix the test(s) to match the spec.\nAfter fixing, stop producing tool calls.`
- Side-effect contract: `state.specPath` unchanged; `turnsThisPhase` resets on the phase change as today; persistence via the existing `pi.appendEntry("loop-state", ...)` path.
- Ownership: `src/events/agent-settled/index.ts` owns row 1's routing; `src/events/agent-settled/negotiate.ts` owns rows 2–3 (existing); `test/events/agent-settled/dispute-from-b.test.ts` (new file) asserts rows 1–3.

Quirks list:
- `expect(async () => await f()).toThrow()` in `test/events/agent-settled/index.test.ts:142` *passes today* when the function throws synchronously before the first `await` — it only fails for rejections. The corrupted-language path throws inside `getLanguageConfig` (synchronously, before any `await` in `handleAgentSettled`), so the test's outcome depends on where the throw lands relative to the first await. Current behavior, do not fix beyond the `.rejects` rewrite — the rewrite makes the assertion robust to either.

Intended shifts:
- The Writer can now leave Phase B via `negotiate_propose`. Before: the tool existed but the dispatcher ignored it in B (the Writer's only options were edit source or stop). After: a dispute from B is a first-class transition. Existing tests that assert "Writer in B cannot propose" — grep `negotiate_propose` in `test/events/agent-settled/`: 0 hits as of writing, so no flip.

## Inventory

- Files:
  - `test/gate-signal-integrity.test.ts`: `makeGoCwd` + `main.go`; S1 `it.skipIf` + 30s (per bug-negotiate-drift); green-stays-green unchanged beyond the fixture.
  - `test/events/agent-settled/index.test.ts`: 1 assertion rewritten (`.rejects.toThrow`).
  - `src/events/before-agent.ts`: 1 prompt line (verbatim above).
  - `src/events/agent-settled/index.ts`: dispatcher routing for B-phase proposals.
  - `test/events/agent-settled/dispute-from-b.test.ts`: new, 3 tests (rows 1–3).
  - `docs/spec-authoring.md`: failure class M (below) + template line + filling-prompt rule 11 + self-check line.
- Imports: `index.ts` adds `handleNegotiateSettled` (already imported for the negotiate phase — 0 new imports).
- Call sites: `buildWriterPrompt` is called from 2 sites (`src/events/before-agent.ts` Phase B entry + the retry effect's prompt key) — both get the new line via the shared builder.
- Exports: none new.

## Test Strategy

- **Baseline:** `npx vitest run` green for `test/gate-signal-integrity.test.ts` **except** `green stays green` (1 failing, 38 passing) — verified 2026-08-18. `test/events/agent-settled/index.test.ts`: the corrupted-language test fails (verified in the session: `expected [AsyncFunction] to throw an error`).
- **Flips (counted):** 2 — `green stays green` (fixture gains `main.go`; assertion unchanged), corrupted-language (`.rejects` rewrite; assertion intent unchanged).
- **New tests:** 3 (dispute-from-b rows 1–3) + S1 skipIf probe test (go present → runs; go absent via PATH manipulation → skipped, not passed).
- **Untouched:** every other assertion in both files. Mechanism: the fixture change only adds a file; the `.rejects` rewrite asserts the same error message.

## Scope lines

- `test/gate-signal-integrity.test.ts`: fixture + S1 skipIf/timeout.
- `test/events/agent-settled/index.test.ts`: 1 line.
- `src/events/before-agent.ts`: 1 line.
- `src/events/agent-settled/index.ts`: routing block.
- `docs/spec-authoring.md`: 1 failure class + 3 template/prompt lines.
- Everything else: untouched.

## Acceptance Criteria

1. `npm test` green, full `vitest run`; `green stays green` passes **and** its passing run shows `go test` actually executing (the test's own debug/timeout proves the compile step passed — criterion checked by the test body asserting `kind: "result"`, which is only reachable post-compile).
2. `npx tsc --noEmit` clean.
3. Grep sweep: needle `unpassable by construction` — exactly 1 hit in `src/events/before-agent.ts`; needle `dispute-from-b` — 1 file in `test/events/agent-settled/`; needle `rejects.toThrow` — ≥1 hit in `test/events/agent-settled/index.test.ts`.
4. `docs/spec-authoring.md` failure-class table has 13 rows (M added); the filling prompt has rule 11.
5. Session-level check (manual, one run): a Writer that calls `negotiate_propose` in Phase B produces, in the session log, a Tester `negotiate_review` round and then either a Tester-fix turn or a Writer retry (verify via `scripts/extract-session.sh`).

## Dependencies

- `bug-negotiate-drift.md`: the S1 skipIf/30s fix is specified there; this spec's `makeGoCwd` fix is independent but should land in the same Tester-fix turn to avoid a second contract rewrite.
- `bug-gate-signal-integrity.md`: implemented (uncommitted) as of writing; this spec assumes its `GateOutcome`/async shape is the current one.

## Findings log

| # | Severity | Finding | Disposition |
|---|-----------|---------|-------------|
| 1 | blocker | `green stays green` is unpassable by construction (test-only module → `go build` exit 1 → compile early-return); reproduced 2026-08-18 | Accepted — fixture gains `main.go` |
| 2 | blocker | S1 passes for the wrong reason (compile early-return, not exit-code signal); the negotiated skipIf/30s never landed in the file | Accepted — tracked in `bug-negotiate-drift.md`, fixed in the same Tester-fix turn |
| 3 | needs-doc | `expect(async () => await f()).toThrow()` cannot catch async rejections; the corrupted-language test's pass/fail depends on throw location vs first await | Accepted — `.rejects.toThrow` rewrite |
| 4 | needs-doc | The Writer's dispute tool is unreachable in Phase B; the prompt says "dispute wrong tests" permissively while the dispatcher ignores the call in B | Accepted — mandatory wording + B-phase routing |
| 5 | nit | The session's ~40× identical S1 reruns were grinding a *passing* test while the failing one sat unaddressed — a debugging-hygiene symptom of #4, not a separate bug | Rejected as in-scope here; the mandatory-dispute path removes the incentive to grind |
