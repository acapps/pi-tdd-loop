# Ruleset: Role Compliance

## Problem

The adversarial 3-agent separation (Tester → Writer → Cleaner) is a **prompt-level contract**, not a code-level enforcement. The agent can ignore its role, and the gate system only blocks *wrong files*, not *wrong intent*.

**Runtime evidence:** Session `01a0f4db` (2026-10-01):
- Phase A prompt: "You are the TESTER. Write contract tests."
- Agent response: "## Phase A Approved. Writing Go implementation."
- The spec said "You are building this extension in Go, Java, or TypeScript" — the agent latched onto Go and wrote source instead of tests.
- The gate blocked `write` to `checkpoint.go` (correct), but the agent found `cat >` via bash (bypass).
- The gate passed with 0 tests, 0 coverage. The TDD contract was empty.

## Root Cause

The agent hit a **cognitive wall** (role/language confusion), not a **technical wall** (gate blocking a file). The gate told it *what it can't do* but didn't redirect it to *what it should do*. The agent's response to being blocked was "find another way to write the same wrong file" instead of "I need to rethink what I'm doing."

## Rules

### R1: Gate error messages must be corrective, not just prohibitive

When a write is blocked, the error message must:
1. Re-state the agent's role ("You are the TESTER.")
2. State what the agent SHOULD do ("Write *.test.ts files.")
3. Reference the spec ("Read the spec's Test Strategy section.")

NOT just: "Cannot write source files."

**Before:** `Phase A only: write test files, stubs, docs (*.md), and project config. Cannot write source files.`
**After:** `You are the TESTER. Write contract tests (*.test.ts), not source files. Read the spec's Test Strategy section. See the Phase A prompt for your full contract.`

### R2: Specs must not mention implementation languages

The spec template in `docs/spec-authoring.md` should NOT include "You are building this extension in Go, Java, or TypeScript." The language is determined by the project's `detectProject()` (go.mod → Go, pom.xml → Java, tsconfig.json → TypeScript). The spec is language-agnostic; the loop injects the language-specific prompt.

If a spec MUST mention a language (e.g., a Go-specific bug), it should say "This spec targets the Go codebase" — not "You are building in Go, Java, or TypeScript."

### R3: Phase A gate must verify test file existence

The Phase A gate currently checks `gate.compile` only. It must also verify that at least one new or modified test file matching the language's test pattern exists. If no test files were produced, the gate fails with a specific error.

This is the "zero test gate" fix (see `internal/bug-phase-a-zero-test-gate.md`).

### R4: Bash file mutations are subject to the same phase policy

The `write`/`edit` gate is bypassable via `cat >`, `echo >`, `tee`, `sed -i`, `rm`, `mv`, `cp`. The tool-call handler must pattern-detect file mutations in bash commands and apply the same phase × tool policy.

This is the "bash heredoc bypass" fix (see `internal/bug-bash-heredoc-gate-bypass.md`).

### R5: Role re-injection after a blocked write

When a write is blocked in a phase, the next prompt (retry/continue) should re-inject the full role prompt, not just the error message. The agent needs to re-orient, not just see "blocked."

Currently: blocked → agent retries same action → blocked again → agent finds bash.
Target: blocked → corrective message with role re-stated → agent re-orients → writes test file.

## Scope

- `src/languages/{go,java,typescript}.ts` — `refusalMessage.phaseA` (and `phaseC`)
- `src/events/tool-call.ts` — corrective messages in block decisions
- `src/transitions.ts` — Phase A gate logic (test file existence check)
- `docs/spec-authoring.md` — remove language mentions from template
- `internal/bug-bash-heredoc-gate-bypass.md` — bash pattern detection
- `internal/bug-phase-a-zero-test-gate.md` — zero-test gate

## Out of Scope

- Sandboxing bash (too broad, breaks `npx vitest`, `git`, etc.)
- Replacing the prompt-level role contract with code-level enforcement (the prompt IS the contract; the gate is a backstop)
