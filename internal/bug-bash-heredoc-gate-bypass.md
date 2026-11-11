# bug-bash-heredoc-gate-bypass

## Problem

The phase gate system blocks `write` and `edit` tool calls per the phase × tool policy matrix. However, file mutations via the `bash` tool are completely unrestricted. An agent that discovers the `cat > file << 'EOF'` pattern can bypass all phase boundaries.

**Runtime evidence:** Session `01a0f4db-c664-767d-9965-605794365f44` (2026-10-01):

1. **Phase A (Tester):** Agent blocked 2× on `write` to `src/state/checkpoint.go`. Immediately retried via `cat > src/state/checkpoint.go << 'GOEOF'` — succeeded. The file was created.

2. **Phase B (Writer):** Agent blocked 3× on `write` to `test/state/phase0-state-check.test.ts`. Retried via `cat > test/state/phase0-state-check.test.ts << 'EOF'` — succeeded. Also used `rm` to delete and recreate the file multiple times. Total: 34 `cat >` commands to source files in Phase B.

**Consequence:** The entire phase-gate architecture (tool-call handler, refusal logging, scope-check) is advisory-only. The "adversarial 3-agent" separation collapses because any agent can write any file at any time via bash.

## Target

After this fix, file mutations via `bash` are subject to the same phase × tool policy as `write`/`edit`. The agent cannot create or modify files in restricted paths regardless of the tool it uses.

## Interface

The `src/events/tool-call/index.ts` handler already inspects `write` and `edit` calls. Extend it to:

1. **Pattern-detect file mutations in bash commands:** `cat >`, `cat >>`, `echo >`, `echo >>`, `tee`, `sed -i`, `mv`, `cp`, `rm`, `mkdir` (when creating test/ or src/ paths).
2. **Apply the same phase policy:** If the target path is restricted for the current phase, block the bash call with the same refusal message.
3. **Allow-list for benign bash:** `cat file` (read), `grep`, `find`, `ls`, `git status`, `npx vitest`, `tsc`, etc. — commands that don't mutate files in the project.

**Challenge:** Bash is Turing-complete. You can't pattern-match every mutation. Options:
- **Narrow:** Block only `cat >`/`cat >>`/`echo >`/`tee` to project paths (covers 95% of observed bypass).
- **Broad:** Run bash in a sandboxed cwd where writes are no-ops (breaks `npx vitest`, `git`, etc.).
- **Hybrid:** Block direct file writes to `src/` and `test/` paths in bash. Allow all other bash. The agent can still use `write`/`edit` for allowed paths.

**Recommended:** Narrow. The observed bypass pattern is specifically `cat > <project-path>`. Block that. Log a debug entry. The agent will adapt to use `write`/`edit` (which are gated) or find another pattern (which will be caught by the next iteration).

## Tests

- `test/events/tool-call/bash-gate.test.ts`:
  - Phase A: `cat > src/foo.ts` → blocked
  - Phase A: `cat > test/foo.test.ts` → allowed (test files are Phase A's job)
  - Phase B: `cat > test/foo.test.ts` → blocked
  - Phase B: `cat > src/foo.ts` → allowed
  - Phase B: `cat file.ts` (read) → allowed
  - Phase B: `npx vitest run` → allowed
  - Phase B: `echo "x" > src/foo.ts` → blocked
  - Phase B: `sed -i 's/a/b/' src/foo.ts` → blocked
  - Phase B: `rm src/foo.ts` → blocked
  - Phase C: `cat > src/foo.ts` → allowed (Cleaner refactors source)

## Acceptance Criteria

1. In Phase A, `cat > src/state/checkpoint.go` is blocked with the same refusal message as `write`.
2. In Phase B, `cat > test/state/phase0-state-check.test.ts` is blocked.
3. Benign bash commands (reads, test runners, git) are unaffected.
4. The refusal is logged in the session debug trace (same format as existing `Blocked:` entries).
5. No false positives on `npx vitest`, `tsc`, `git`, `grep`, `find`, `ls`, `cat <file>` (read).

## Notes

- This is the **critical** finding from the retrospective. Without it, all other gate logic is theater.
- The `write-loop detector` (already in `src/events/tool-call/index.ts`) handles repeated identical calls. This is different: it's a single call via a different tool.
- The scope-check (`src/scope-check.ts`) checks dirty files at phase boundaries. It will catch the *result* of a bypass, but not prevent it. Prevention is the goal here.
