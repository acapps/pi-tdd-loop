# Refactor: Split src/commands.ts into Focused Modules

## Status: open

## Target

`src/commands.ts` is 824 lines containing 10 command handlers plus their helpers.
This violates SRP and makes the file hard to navigate. Split it into focused
modules while preserving the public API (`index.ts` imports `* as Cmd`).

## Behavior

### Current Structure (824 lines, 1 file)

```
src/commands.ts
├── Prompt builders: buildContinuePrompt, buildRestartPrompt, buildPhaseZeroPrompt
├── State helpers: resetPhaseState, resolvePhaseArg, createInitialState
├── /loop helpers: resolveProjectCwd, runPhase0Baseline, applyBranchSetup, enterPhase0Review, rejectLoopStart
├── cmdLoop (exported)
├── cmdStatus (exported)
├── cmdContinue (exported) + isIdleOrDone, formatStatusLines
├── cmdRestart (exported) + handlePhaseRestart
├── cmdDebug (exported) + parseLogBugArgs, showDebugLog, runLogBug, notifyBugSpecResult,
│   SessionEntry interface, DEBUG_LOG_TYPES, isDebugLogEntry, entryTimestamp, extractDebugLogs
├── cmdCancel (exported)
├── cmdApprove (exported)
├── cmdStop (exported)
├── /loop-patch: parsePatchArgs, resolvePatchTargetPhase, cmdPatch (exported)
└── /loop-decompose: parseDecomposeArgs, derivePrefix, buildDecomposePrompt, cmdDecompose (exported)
```

### Target Structure

```
src/commands/
├── index.ts          — re-exports all cmd* functions (public API unchanged)
├── loop.ts           — cmdLoop + helpers (resolveProjectCwd, runPhase0Baseline,
│                       applyBranchSetup, enterPhase0Review, rejectLoopStart,
│                       buildPhaseZeroPrompt, createInitialState, resetPhaseState,
│                       resolvePhaseArg)
├── status.ts         — cmdStatus, cmdContinue, cmdRestart + helpers
│                       (isIdleOrDone, formatStatusLines, handlePhaseRestart,
│                       buildContinuePrompt, buildRestartPrompt)
├── debug.ts          — cmdDebug + log-bug sub-command (parseLogBugArgs,
│                       showDebugLog, runLogBug, notifyBugSpecResult,
│                       SessionEntry, DEBUG_LOG_TYPES, isDebugLogEntry,
│                       entryTimestamp, extractDebugLogs)
├── lifecycle.ts      — cmdCancel, cmdApprove, cmdStop
├── patch.ts          — cmdPatch + helpers (parsePatchArgs, resolvePatchTargetPhase)
└── decompose.ts      — cmdDecompose + helpers (parseDecomposeArgs, derivePrefix,
                        buildDecomposePrompt)
```

### Module Dependencies

```
src/commands/index.ts  →  re-exports from loop, status, debug, lifecycle, patch, decompose
src/commands/loop.ts   →  types, selectors, args, spec-path, phase-max, gates,
                          generic-prompts, reviewer, baseline, git-workflow,
                          languages, commit, prompt, phase-a, metrics
src/commands/status.ts →  types, generic-prompts, phase-max
src/commands/debug.ts  →  types, bug-spec
src/commands/lifecycle.ts → types, phase-a, commit, prompt, generic-prompts
src/commands/patch.ts  →  types, args, spec-path, commit, prompt, selectors
src/commands/decompose.ts → types, args, spec-path, prompt, selectors
```

No circular dependencies: each module imports only from leaf modules (types,
selectors, etc.) and never from sibling command modules.

## Inventory

| File | Action |
|------|--------|
| `src/commands.ts` | **Delete** (replaced by `src/commands/`) |
| `src/commands/index.ts` | **Create** — re-export all `cmd*` functions |
| `src/commands/loop.ts` | **Create** — cmdLoop + ~180 lines of helpers |
| `src/commands/status.ts` | **Create** — cmdStatus/cmdContinue/cmdRestart + ~100 lines |
| `src/commands/debug.ts` | **Create** — cmdDebug + log-bug (~120 lines) |
| `src/commands/lifecycle.ts` | **Create** — cmdCancel/cmdApprove/cmdStop (~60 lines) |
| `src/commands/patch.ts` | **Create** — cmdPatch + helpers (~100 lines) |
| `src/commands/decompose.ts` | **Create** — cmdDecompose + helpers (~50 lines) |
| `index.ts` | **Modify** — change import from `./src/commands` to `./src/commands` (path unchanged, directory module) |
| `test/extension.test.ts` | **Verify** — command count and registration unchanged |
| `test/patch.test.ts` | **Modify** — import path if needed |
| `test/decompose.test.ts` | **Modify** — import path if needed |
| `test/state-divergence-cleanup.test.ts` | **Modify** — file list if it references `src/commands.ts` |
| `test/events/registration-surface.test.ts` | **Verify** — SHA-256 hash of `index.ts` (should be unchanged) |

## Test Strategy

1. **No behavioral change** — this is a pure file reorganization.
2. All existing tests must pass without modification (import paths resolve to the same public API).
3. The `test/state-divergence-cleanup.test.ts` file may reference `src/commands.ts` in its "files that should not exist" or "files that should exist" lists — update accordingly.
4. Run `npx tsc --noEmit` to verify no broken imports.
5. Run `npx vitest run` — all 1340 tests must pass.

## Scope

- **IN:** File split, import path updates, test fixture path updates.
- **OUT:** Changing any command's behavior, adding new commands, changing the public API.

## Acceptance Criteria

1. `src/commands.ts` no longer exists.
2. `src/commands/index.ts` re-exports all 10 `cmd*` functions.
3. Each command module is under 200 lines.
4. `index.ts` (root) imports `* as Cmd from "./src/commands"` — unchanged.
5. `npx tsc --noEmit` passes.
6. `npx vitest run` — all tests pass.
7. No new dependencies introduced.

## Dependencies

None. Pure refactor.

## Findings Log

- The `cmdDebug` + log-bug sub-command (~120 lines) is the largest extraction
  candidate and has the least coupling to other commands.
- `cmdLoop` helpers (`createInitialState`, `resetPhaseState`, `resolvePhaseArg`)
  are also used by `cmdPatch` — they should live in a shared location
  (`src/commands/loop.ts` exports them, `src/commands/patch.ts` imports them).
  Alternatively, move them to `src/types.ts` or a new `src/state-helpers.ts`.
- The `SessionEntry` interface and `DEBUG_LOG_TYPES` constant are only used by
  the debug/log-bug code — they move to `src/commands/debug.ts`.
