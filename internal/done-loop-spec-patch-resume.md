# implement-loop-spec-patch-resume

## Problem

Verified current state as of writing: when the loop escalates (budget
exhausted, repeated failures, human stop), the user has three options:

1. `/loop-continue` — restart from the current phase with a fresh round
   counter. The spec is unchanged. The Tester/Writer get the same spec text.
2. `/loop-restart <phase>` — jump to a specific phase. Same spec.
3. `/loop <spec-path>` — full restart from Phase 0. Same spec (or a new one).

None of these support **patching the spec mid-loop**. The common escalation
scenario is: the Writer can't pass a test because the spec was ambiguous or
wrong. The user realizes the spec needs a correction (e.g., "the endpoint
returns 404, not 400"). Today, the user must:

1. Edit the spec file manually
2. Run `/loop <spec-path>` (full restart, losing all progress)
   OR `/loop-continue` (same spec text, the correction is not picked up
   because the spec is re-read from disk but the phase/round state is
   preserved)

Wait — actually, `/loop-continue` DOES re-read the spec from disk
(`cmdContinue` in `src/commands.ts:311` calls `buildContinuePrompt` which
includes the spec path, and the next phase's prompt tells the agent to read
the spec). So if the user edits the spec file and runs `/loop-continue`,
the agent will see the updated spec. But:

- There's no record of what changed in the spec
- The phase/round state is preserved, so the loop resumes where it left off
  with the corrected spec — but the Tester's tests (written in Phase A)
  may encode the old (wrong) behavior
- The user has to manually decide whether to restart from Phase A (to
  rewrite the tests) or Phase B (to fix the implementation)

The gap: **no "spec patch" workflow**. The user wants to say "here's a
correction to the spec, re-run from Phase A with the corrected spec, and
keep the Phase A round counter so I don't burn my A budget again."

## Target

A new command `/loop-patch <spec-path> [--from <phase>]` that:

1. Re-reads the spec from disk (the user has already edited it)
2. Records the patch in the session (a `loop-spec-patch` entry with the
   timestamp and spec path)
3. Resets the round counter for the specified phase and all subsequent
   phases
4. Advances to the specified phase (default: `A`)
5. Sends a prompt that tells the agent the spec was patched and which
   sections to pay attention to

The command is a variant of `/loop-restart` that additionally:
- Re-reads the spec (restart does this implicitly, but patch makes it
  explicit)
- Records the patch event (provenance)
- Resets round counters (restart does this, patch makes it explicit)
- Sends a "spec was patched" prompt (restart sends a generic "restart from
  phase X" prompt)

## Interface

New function in `src/commands.ts`:

```ts
export function cmdPatch(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
): { description: string; handler: (args: string, ctx: CommandContext) => Promise<void> };
```

Registered as `/loop-patch` in `index.ts`.

**Args**: `[--from <phase>]` (spec path is optional — if omitted, uses the
current `state.current.specPath`)

- `--from <phase>`: which phase to restart from (default: `A`). Valid
  values: `A`, `negotiate`, `B`, `C`.

**Prompt** (sent via `sendPrompt`):

```
The spec at <specPath> has been patched. Re-read it carefully.
Restarting from Phase <phase> (round 1).
Focus on the changes — the previous tests/implementation may encode the old behavior.
```

**State mutations**:
- `state.current.phase` = specified phase
- `state.current.round` = 1
- `state.current.turnsThisPhase` = 1
- `state.current.lastGateResult` = undefined
- `state.current.dispute` = `{ status: "none" }`
- `state.current.lastProposal` = ""
- `state.current.negotiateReprompted` = false
- `state.current.negotiateProposed` = false
- `state.current.negotiateFeedback` = ""
- `state.current.justTransitioned` = true
- `state.current.lastPhase` = old phase (for provenance)

**Session entry** (via `pi.appendEntry`):

```json
{
  "type": "custom",
  "customType": "loop-spec-patch",
  "data": {
    "specPath": "<path>",
    "fromPhase": "<old phase>",
    "toPhase": "<new phase>",
    "ts": "<ISO timestamp>"
  }
}
```

## Behavior

**Decision table**:

| Row | Condition | Action |
|---|---|---|
| 0 | Loop is `idle` | "Loop is not running. Use /loop <spec> to start." |
| 1 | Loop is `done` | "Loop is complete. Use /loop <spec> to start a new loop." |
| 2 | No `--from` arg, loop is `escalated` | Use the phase it escalated from (`lastPhase`) |
| 3 | No `--from` arg, loop is active (A/negotiate/B/C) | Use `A` (default) |
| 4 | `--from` arg provided | Use the specified phase |
| 5 | Spec file not found (if spec path was given) | Error notification, no state change |
| 6 | All valid | Mutate state, commit, send prompt, return |

**Quirks list**:
- `/loop-restart` does NOT re-read the spec file. It just changes the phase
  and sends a prompt. The agent reads the spec when it gets the prompt.
  `/loop-patch` is the same — it doesn't validate the spec content, it just
  records that a patch happened and tells the agent to re-read.
- The `loop-spec-patch` session entry is informational. It's not read by
  any code path. It's for the human reviewing the session JSONL.

**Intended shifts**:
- None. This is a new command. Existing commands are unchanged.

**Ownership**:
- `src/commands.ts` owns `cmdPatch`.
- `index.ts` registers the command.
- `test/extension.test.ts` asserts the command is registered.
- `test/patch.test.ts` (new) asserts the state mutations and prompt.

## Inventory

**Files touched:**
- `src/commands.ts` — add `cmdPatch`
- `index.ts` — register `/loop-patch`
- `test/extension.test.ts` — update command count
- `test/patch.test.ts` — new: state mutations, prompt, session entry

**Imports added:**
- `src/commands.ts`: none new

**Call sites:**
- `index.ts`: `pi.registerCommand("loop-patch", cmdPatch(state, pi, debug))`

## Test Strategy

- **Baseline**: 1245 tests passing.
- **New tests** (`test/patch.test.ts`):
  - `cmdPatch` with idle state → "not running" message
  - `cmdPatch` with done state → "complete" message
  - `cmdPatch` with escalated state, no `--from` → uses `lastPhase`
  - `cmdPatch` with active state, no `--from` → uses `A`
  - `cmdPatch` with `--from B` → phase set to B, round 1
  - `cmdPatch` → spec path preserved from state
  - `cmdPatch` → `loop-spec-patch` entry appended
  - `cmdPatch` → prompt includes "has been patched"
  - `cmdPatch` → dispute reset, negotiate flags cleared
- **Updated tests**:
  - `test/extension.test.ts`: command count updated
- **Untouched**: all existing commands, the loop state machine, gates.

## Scope lines

- `src/commands.ts`: kept + `cmdPatch` added
- `index.ts`: kept + 1 new `registerCommand`
- `test/extension.test.ts`: kept + command count updated
- `test/patch.test.ts`: added

## Acceptance Criteria

- `npx tsc --noEmit` clean
- `npx vitest run` green (1245 + new tests)
- `grep -r "loop-patch" src/ index.ts test/` returns ≥ 3 matches
- `grep -r "loop-spec-patch" src/ test/` returns ≥ 2 matches
- The command resets round to 1 and turnsThisPhase to 1
- The command appends a `loop-spec-patch` session entry

## Dependencies

None.

## Findings log

(empty — clean Phase 0)
