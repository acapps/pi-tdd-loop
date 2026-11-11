# bug-phase-a-zero-test-prompt

## Problem

When the Phase A zero-test gate fires (no new/modified test files), the retry prompt is `promptTesterCompileRetry` — "Compilation failed. Fix the compilation errors." — with an **empty** error block, because `gate.compile === true`. The Tester never learns the gate is about *missing test files*. It burns all `maxA` rounds believing there is nothing to do, then the loop escalates with a wrong diagnosis.

**Runtime evidence:** Session `01a1c767` (pi-dæmi, spec `docs/enrich-entry-renderer.md`):

- Spec's Test Strategy: "New tests: None — render output is TUI-specific (mock pi stub swallows renderers)."
- Tester correctly writes nothing. Zero-test check fires: `Phase A zero-test check: no new test files detected`.
- Gate log: `Gate pass [compile=true allPassed=true cov=0%]` → retry with `promptTesterCompileRetry("...")` where the compile error is empty.
- Agent: "The error block is empty again. No compilation errors. The spec says no new tests. I've already confirmed this multiple times. There's nothing to do." — 3 rounds, escalate. Same loop on restart.

**Consequence:** Two distinct defects:

1. **Wrong retry prompt (signal integrity).** Same family as `done-bug-gate-signal-integrity.md`: the gate says one thing (zero test files) and the prompt claims another (compile failure). Violates ruleset-role-compliance R1 (corrective, not just prohibitive: re-state the role, name the actual finding, state what to do).
2. **No escape hatch for a legitimate "no new tests" spec.** The spec-authoring Test Strategy template has a "New tests:" line; a spec may legitimately plan zero *new* tests (refactor, TUI-only change). The zero-test gate treats that as a hard fail with no path to agree on the test contract before burning the retry budget.

## Target

1. The zero-test retry prompt names the actual gate finding ("no new or modified test files"), re-states the Tester role, and points at the spec's Test Strategy — not a compile failure.
2. The prompt names the escape hatch: if the spec genuinely requires no new tests, raise it via `negotiate_propose` so the test contract is agreed.
3. A bare "New tests: None" in a spec is a draft-quality Test Strategy — the authoring doc requires naming the verification mechanism instead.

## Fix (implemented)

- `src/constants.ts`: new `RETRY_PROMPTS.TESTER_ZERO_TEST_RETRY`.
- `src/transitions.ts`: Phase A zero-test branch uses `TESTER_ZERO_TEST_RETRY` (was `TESTER_COMPILE_RETRY`). No state/effect shape change.
- `src/languages/{go,java,typescript}.ts` + `src/languages/index.ts`: new `promptTesterZeroTestRetry()` — corrective (R1): role, finding, Test Strategy reference, negotiate escape hatch, language-specific test pattern.
- `src/events/agent-settled/effect-applicator.ts`: `buildRetryPrompt` maps the new key.
- `docs/spec-authoring.md`: "New tests: None" must name the verification mechanism.
- `src/tools/policy.ts` + `src/tools/negotiate.ts` + `src/tools/phase0.ts`: the escape hatch is now open — Phase A × `negotiate_propose` (and escalated × `negotiate_propose`) is a new `escalate` policy row: the plan is surfaced verbatim to the human, the loop pauses, and the agent is told to wait (`/loop-continue`). No auto-transition. See `bug-escalated-no-reentry.md`.

## Tests

- `test/events/agent-settled/gate-transition.test.ts`: zero-test retry sends the zero-test prompt (contains "no new or modified test files", does NOT contain "Compilation failed"); existing zero-test transition tests (retry / escalate / advance) unchanged.
- `test/prompts.test.ts`: `promptTesterZeroTestRetry` per language — corrective content + language-specific test pattern; all-three-languages contract.

## Acceptance Criteria

1. A Phase A zero-test retry prompt never claims a compile failure.
2. The prompt is corrective (role + finding + action) per R1.
3. A spec that genuinely needs no new tests has a named path (negotiate) instead of silent budget burn — Phase A × `negotiate_propose` surfaces the plan to the human and pauses the loop (no auto-transition).
4. Existing zero-test gate behavior (retry at round < maxA, escalate at round >= maxA, advance when tests exist) is unchanged.

## Related

- `internal/bug-phase-a-zero-test-gate.md` — the zero-test gate itself (this spec fixes its signal, not its detection)
- `internal/bug-escalated-no-reentry.md` — the negotiate re-entry path this spec's escape hatch relies on
- `internal/ruleset-role-compliance.md` R1/R3 — corrective gate messages, zero-test gate rule
- `internal/done-bug-gate-signal-integrity.md` — same failure family (gate signal ≠ prompt claim)
