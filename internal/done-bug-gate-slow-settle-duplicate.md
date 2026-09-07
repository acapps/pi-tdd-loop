# bug-gate-slow-settle-duplicate

## Problem

Verified current state as of writing (re-checked against the repo at `4aec55d` + working tree, 2026-09-06):

**A duplicate `agent_settled` arriving while a gate run is in flight is not dropped — both settles run the full gate and both apply effects.**

1. **The lock the contract file promises is missing.** `test/gate-signal-integrity.test.ts:22-29` (header NOTE) says: *"the dispatcher-level duplicate-settle lock test (module-local `gateInFlight` in src/events/agent-settled/gate-transition.ts) is deliberately NOT covered here … File it as a follow-up test in test/events/agent-settled/gate-transition.test.ts once the async handler lands."* The async handler landed (branch `gate-coverage`, merged `fc51a53`). The follow-up test was never filed, and the module-local `gateInFlight` guard was never written: `grep -rn "gateInFlight" src/` → 0 hits. `src/events/agent-settled/gate-transition.ts` exports the `NO_GATE` sentinel (`:34-39`) with the comment *"a duplicate settle was dropped while a gate was in flight"* — but nothing in `src/` ever returns it.
2. **Reproduction (2026-09-06, probe `test/lock-probe.test.ts`, deleted after the run):** fire two `handleGateTransition` calls concurrently (`Promise.all`) with valid inputs (mock `pi`, real `ctx.ui`, `lang = getLanguageConfig("go")`, nonexistent `cwd` so the gate errors fast): both promises resolve with a fully applied effect (retry + `sendUserMessage`), `NO_GATE` returned 0 times. Expected: exactly one `NO_GATE`. Fails with `expected +0 to be 1`. The in-flight window is `runGates`'s `execFile` await — wide enough in practice for a second settle to land while the first gate (up to 60s test timeout) is still running.
3. **Why this is a loop bug:** `agent_settled` is the loop's only forward edge. Two settles in one round = two gate runs (double toolchain cost), two effect applications, and two `sendUserMessage` prompts — the Writer sees the same retry prompt twice and the round accounting doubles. In a long gate run (a real `go test ./...` on a large project easily exceeds 10s), any duplicate settle (retry, reconnect, double-fired event from the host) corrupts the round.

## Target

After this fix: a second `agent_settled` arriving while a gate run is in flight for the same loop is dropped — the handler returns the existing `NO_GATE` sentinel (noop effect, no `GateResult`, no prompt, no effect application) and only the first settle's effect lands. The lock is per-loop (module-local, cleared in `finally` so a thrown gate cannot wedge the loop), and the follow-up test the contract file asked for exists in `test/events/agent-settled/gate-transition.test.ts`.

## Interface

- `src/events/agent-settled/gate-transition.ts`:
  - Module-local `let gateInFlight = false` (module scope, matching the contract file's "module-local" note).
  - In `handleGateTransition`, before `runGates`: `if (gateInFlight) return NO_GATE;` then `gateInFlight = true;` and a `try { … } finally { gateInFlight = false; }` around the `runGates` await + `applyEffect`.
  - `NO_GATE` is unchanged (already exported; its doc comment now matches reality).
- `test/events/agent-settled/gate-transition.test.ts` (follow-up test the contract file asked for):
  - New describe: "duplicate settle while gate in flight".
  - Test 1: two concurrent `handleGateTransition` calls (mocked `runGates` held open via `vi.spyOn` on the gates module — the existing file already mocks `runGates`; hold the first promise open with a deferred, fire the second, assert `NO_GATE` + `applied === false`, then resolve the first and assert it applied exactly once).
  - Test 2: after a settled gate (resolved), a subsequent settle runs normally (lock cleared — no wedge).
  - Test 3 (wedge regression): the first gate's `runGates` rejects/throws → the lock is still cleared (the `finally`), the next settle runs.
  - The live-toolchain variant (real `runGates`, nonexistent cwd, `Promise.all` of two calls → exactly one `NO_GATE`) is the probe above; include it only if it stays under 5s — otherwise the mocked deferred is sufficient and the live variant is dropped (documented in a comment).

## Behavior

Decision table (first-match-wins):

| # | Condition | Effect |
|---|-----------|--------|
| 1 | `handleGateTransition` called and `gateInFlight === false` | `gateInFlight = true`; run the gate as today; `finally` clears the lock; return the normal output |
| 2 | `handleGateTransition` called and `gateInFlight === true` | return `NO_GATE` immediately — no `runGates`, no `applyEffect`, no `sendUserMessage`, no `lastGateResult` |
| 3 | The in-flight gate throws or returns `kind: "error"` | lock cleared in `finally`; error handling is unchanged (`computeGateErrorTransition`); the next settle runs the gate again |

- Verbatim pins: none new. The `NO_GATE` object and its comment stay byte-identical.
- Side-effect contract: `state.current.lastGateResult` is still set only by the dispatcher on a real result (G3 unchanged); a dropped settle writes nothing to state (the dispatcher's `gate.applied === false` path already no-ops).
- Ownership: `src/events/agent-settled/gate-transition.ts` owns rows 1–3; `test/events/agent-settled/gate-transition.test.ts` owns the follow-up tests.
- Quirks: the lock is module-global, not per-`LoopState` — fine today because one extension instance serves one loop; if multi-loop support ever lands, the key must become per-state (noted, not built).
- Intended shifts: before, a duplicate settle double-ran the gate and double-prompted; after, it is a silent noop. The `NO_GATE` export goes from dead code to live code. No existing test asserts "both settles run" (grep `NO_GATE` in `test/`: only the import in this spec's probe — 0 hits in the permanent suites), so no test flips.

## Inventory

- Files:
  - `src/events/agent-settled/gate-transition.ts`: +1 module-local variable, +1 early return, +1 `try/finally` wrap.
  - `test/events/agent-settled/gate-transition.test.ts`: +1 describe, 3 tests (rows 1–3).
- Imports: none new (the test file already imports `runGates` and the handler).
- Call sites: `handleGateTransition` is called from exactly one site (`src/events/agent-settled/index.ts:170`); the dispatcher already handles `applied === false` without writing state.
- Exports: none new (`NO_GATE` already exported).

## Test Strategy

- **Baseline:** `npx vitest run` green (1154 passed / 12 skipped as of `4aec55d` + working tree). The probe `test/lock-probe.test.ts` fails with `expected +0 to be 1` (reproduced 2026-09-06).
- **Flips (counted):** 0 — no existing assertion changes behavior.
- **New tests:** 3 (rows 1–3 above).
- **Untouched:** every other assertion in `test/events/agent-settled/gate-transition.test.ts`; the whole suite.
- **Speed:** the mocked-deferred tests are instant; the optional live variant must stay under 5s or be dropped (CLAUDE.md test-speed rule; the probe ran in <1s with a nonexistent cwd).

## Scope lines

- `src/events/agent-settled/gate-transition.ts`: the guard + `try/finally`.
- `test/events/agent-settled/gate-transition.test.ts`: the new describe block.
- Everything else: untouched.

## Acceptance Criteria

1. `npx tsc --noEmit` clean.
2. `npx vitest run` green, full suite; the 3 new tests pass.
3. The probe scenario (two concurrent settles, nonexistent cwd) returns exactly one `NO_GATE` — re-run the probe from this spec's Problem §2 before deleting it.
4. Grep sweep: needle `gateInFlight` in `src/events/agent-settled/gate-transition.ts` — ≥2 hits (declaration + check); needle `NO_GATE` in `src/` — returned, not just defined.
5. Red-against-pre-fix: the 3 new tests fail (or the probe fails) when run against the pre-fix `gate-transition.ts` (stash the source change, run, unstash).

---

## Resolution (merged, 2026-09-06)

**The lock landed as specified:**
- `src/events/agent-settled/gate-transition.ts`: module-local `let gateInFlight = false` (declaration + check + set + `finally` clear — 4 hits); `handleGateTransition` returns the existing `NO_GATE` sentinel on a duplicate settle (no `runGates`, no `applyEffect`, no `sendUserMessage`, drop logged via `debug`); the `runGates` await + effect application is wrapped in `try/finally` so a throwing gate cannot wedge the loop.
- `NO_GATE` went from dead code to live code (`return NO_GATE` at `gate-transition.ts:60`). The dispatcher's `applied === false` path already no-ops state, so a dropped settle writes nothing.
- `test/events/agent-settled/gate-transition.test.ts`: new describe "duplicate settle while gate in flight" with the 3 spec'd tests — (1) concurrent settle → `NO_GATE` reference-identity, `runGates` called exactly once, zero prompts/UI on the dropped settle, first gate applies exactly once after its deferred resolves; (2) post-settle lock cleared (no wedge); (3) wedge regression (rejecting `runGates` → `finally` clears the lock, next settle runs). The live-toolchain probe variant (Problem §2) is deliberately not in the unit suite per the CLAUDE.md test-speed rule — the mocked deferred pins the same contract at the unit boundary (documented in the test header).
- Red-verified: with the source fix stashed, test 1 fails at `expect(result2).toBe(NO_GATE)` (the duplicate settle double-ran the gate); tests 2-3 pass pre-fix (they pin the lock's *clearing*, which the pre-fix code trivially satisfies by having no lock).
- Full suite: 1173 passed / 0 failed; `tsc --noEmit` clean.

**Residual (noted in the spec, not built):** the lock is module-global, not per-`LoopState` — fine while one extension instance serves one loop; multi-loop support must key it per-state.
