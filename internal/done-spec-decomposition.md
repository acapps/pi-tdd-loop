# implement-spec-decomposition

## Problem

Verified current state as of writing: the loop operates on a single spec file
(`/loop <spec-path>`). The spec is read in full, reviewed in Phase 0, and
handed to the Tester/Writer/Cleaner as one unit. There is no mechanism to:

1. Break a large spec into sub-tasks
2. Run the loop sequentially on each sub-task
3. Track which sub-tasks are done and which remain

A spec like "implement a REST API with 12 endpoints" goes through the loop
as a single unit. The Tester writes tests for all 12 endpoints in Phase A.
The Writer implements all 12 in Phase B. If the Writer struggles with
endpoint 7, the entire loop is stuck — there's no way to say "do endpoints
1-6 first, then 7-12."

The `/spec` command (`src/spec-command.ts`) can *write* a spec but doesn't
*decompose* one. The `internal/index.md` has a "Dependencies" column for
spec documents, but it's manual bookkeeping, not loop-aware.

## Target

A new command `/loop-decompose <spec-path>` reads a spec, breaks it into
sub-specs (one per independently-testable unit), writes them to
`internal/` with a shared prefix, and prints a recommended execution order.
The user then runs `/loop` on each sub-spec sequentially.

The decomposition is LLM-driven (one Author turn), not heuristic. The Author
reads the spec, identifies independently-testable units, and writes each as
a standalone spec file that passes `validateSpecStructure`. The sub-specs
reference the parent spec and their position in the sequence.

**This is a new command, not a modification to the existing loop.** The loop
itself is unchanged. The decomposition is a pre-loop step: split the spec,
then run the loop on each piece.

## Interface

New function in `src/commands.ts`:

```ts
export function cmdDecompose(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
): { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> };
```

Registered as `/loop-decompose` in `index.ts`.

**Args**: `<spec-path> [--out <dir>] [--prefix <slug>]`

- `<spec-path>`: the spec to decompose (required)
- `--out <dir>`: output directory (default: `internal/`)
- `--prefix <slug>`: filename prefix for sub-specs (default: derived from
  spec filename, e.g. `rest-api` → `rest-api-1.md`, `rest-api-2.md`, ...)

**Output**: The Author writes N sub-spec files and a summary file
`<prefix>-index.md` with:

```markdown
# <prefix> — Sub-spec Index

Parent: <spec-path>
Decomposed: <timestamp>
Units: N

| # | File | Scope | Depends On |
|---|---|---|---|
| 1 | <prefix>-1.md | <one-line scope> | — |
| 2 | <prefix>-2.md | <one-line scope> | 1 |
| ... | | | |

Run: /loop <prefix>-1.md, then /loop <prefix>-2.md, ...
```

**Prompt to the Author** (one turn, `sendPrompt`):

```
Read the spec at <spec-path>. Break it into independently-testable units.
Each unit must:
1. Be implementable and testable in a single /loop run
2. Have a clear, self-contained scope (no "and other related things")
3. Reference the parent spec and its position in the sequence
4. Pass the spec template (all required sections present)

Write each unit as <out>/<prefix>-<N>.md.
Write a summary at <out>/<prefix>-index.md with the table above.

Rules:
- Maximum 5 units. If the spec needs more, group related endpoints/features.
- Each unit's "Dependencies" section lists the units it depends on.
- The last unit may be an "integration" unit that tests the whole system.
- Do NOT modify the parent spec.
```

## Behavior

**Command handler flow**:

| Row | Condition | Action |
|---|---|---|
| 0 | No args | Usage message, return |
| 1 | Spec file not found | Error notification, return |
| 2 | Spec file exists | Read spec, build prompt, `sendPrompt`, return |

The Author runs in a single turn. The command does NOT change loop state —
it's a stateless operation like `/spec`. The `state` parameter is accepted
for registration consistency but not used.

**Quirks list**:
- The Author may write more or fewer units than expected. The command does
  not validate the output — the user reviews the files.
- The sub-specs are NOT automatically run. The user runs `/loop` on each
  one manually.
- If the spec is already small (one unit), the Author writes a single
  sub-spec that is essentially a copy of the parent with the index
  reference added.

**Intended shifts**:
- None. This is a new command. Existing commands and the loop are unchanged.

**Ownership**:
- `src/commands.ts` owns `cmdDecompose`.
- `index.ts` registers the command.
- `test/extension.test.ts` asserts the command is registered.
- `test/decompose.test.ts` (new) asserts the prompt construction.

## Inventory

**Files touched:**
- `src/commands.ts` — add `cmdDecompose`
- `index.ts` — register `/loop-decompose`
- `test/extension.test.ts` — update command count (9 → 10)
- `test/decompose.test.ts` — new: prompt construction, arg parsing

**Imports added:**
- `src/commands.ts`: none new (uses existing `sendPrompt`, `readFileSync`)

**Call sites:**
- `index.ts`: `pi.registerCommand("loop-decompose", cmdDecompose(state, pi, debug))`

## Test Strategy

- **Baseline**: 1245 tests passing.
- **New tests** (`test/decompose.test.ts`):
  - `cmdDecompose` with no args → usage message
  - `cmdDecompose` with non-existent spec → error notification
  - `cmdDecompose` with valid spec → `sendPrompt` called with the
    decomposition prompt
  - `cmdDecompose` with `--out` and `--prefix` → prompt includes the
    correct paths
- **Updated tests**:
  - `test/extension.test.ts`: command count 9 → 10
- **Untouched**: the loop itself, all existing commands, all existing
  phases.

## Scope lines

- `src/commands.ts`: kept + `cmdDecompose` added
- `index.ts`: kept + 1 new `registerCommand`
- `test/extension.test.ts`: kept + command count updated
- `test/decompose.test.ts`: added

## Acceptance Criteria

- `npx tsc --noEmit` clean
- `npx vitest run` green (1245 + new tests)
- `grep -r "loop-decompose" src/ index.ts test/` returns ≥ 3 matches
- `grep -r "cmdDecompose" src/ test/` returns ≥ 2 matches
- The command does NOT modify `LoopState` (no phase change, no round
  increment)

## Dependencies

None. This is a standalone command. It reads a spec file and sends a prompt
to the Author. It does not interact with the loop state machine.

## Findings log

(empty — clean Phase 0)
