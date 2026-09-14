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
src/state-helpers.ts  — resetPhaseState, isIdleOrDone, resolvePhaseArg
                        (shared by loop, status, lifecycle, patch)
src/commands/
├── index.ts          — re-exports all cmd* functions (public API unchanged)
├── loop.ts           — cmdLoop + helpers (resolveProjectCwd, runPhase0Baseline,
│                       applyBranchSetup, enterPhase0Review, rejectLoopStart,
│                       buildPhaseZeroPrompt, createInitialState)
├── status.ts         — cmdStatus, cmdContinue, cmdRestart + helpers
│                       (formatStatusLines, handlePhaseRestart,
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
src/state-helpers.ts     →  types (leaf; resetPhaseState, isIdleOrDone, resolvePhaseArg)
src/commands/index.ts    →  re-exports from loop, status, debug, lifecycle, patch, decompose
src/commands/loop.ts     →  types, selectors, args, spec-path, phase-max, gates,
                            generic-prompts, reviewer, baseline, git-workflow,
                            languages, commit, prompt, phase-a, metrics,
                            state-helpers
src/commands/status.ts   →  types, generic-prompts, phase-max, state-helpers
src/commands/debug.ts    →  types, bug-spec
src/commands/lifecycle.ts → types, phase-a, commit, prompt, generic-prompts,
                            state-helpers
src/commands/patch.ts    →  types, args, spec-path, commit, prompt, selectors,
                            state-helpers
src/commands/decompose.ts → types, args, spec-path, prompt, selectors
```

No circular dependencies: each module imports only from leaf modules (types,
selectors, state-helpers, etc.) and never from sibling command modules.

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
| `src/state-helpers.ts` | **Create** — `resetPhaseState`, `isIdleOrDone`, `resolvePhaseArg` (shared by loop, status, lifecycle, patch) |
| `index.ts` | **Verify** — import path unchanged (directory resolution) |
| `src/tools.ts` | **Modify** — update comment at line 187 (`src/commands.ts` → `src/commands/`) |
| `test/state-validation.test.ts` | **Modify** — update comment at line 20 (`commands.ts` → `src/state-helpers.ts`) |
| `test/extension.test.ts` | **Verify** — command count and registration unchanged |
| `test/patch.test.ts` | **Verify** — import path if needed |
| `test/decompose.test.ts` | **Verify** — import path if needed |
| `test/state-divergence-cleanup.test.ts` | **Verify** — does not list `src/commands.ts` in existence lists (confirmed 2026-09-10) |
| `test/events/registration-surface.test.ts` | **Verify** — SHA-256 hash of root `index.ts` (unchanged) |

## Test Strategy

1. **No behavioral change** — this is a pure file reorganization.
2. All existing tests must pass without modification (import paths resolve to the same public API).
3. The `test/state-divergence-cleanup.test.ts` file may reference `src/commands.ts` in its "files that should not exist" or "files that should exist" lists — update accordingly.
4. Run `npx tsc --noEmit` to verify no broken imports.
5. Run `npx vitest run` — all 1340 tests must pass.

## Scope lines

| Touched file | Removed | Kept | Added |
|---|---|---|---|
| `src/commands.ts` | All 824 lines | — (file deleted) | — |
| `src/commands/index.ts` | — | — | Re-exports of all 10 `cmd*` functions |
| `src/commands/loop.ts` | — | `cmdLoop` + helpers (moved verbatim) | Import statements |
| `src/commands/status.ts` | — | `cmdStatus`/`cmdContinue`/`cmdRestart` + helpers (moved verbatim) | Import statements |
| `src/commands/debug.ts` | — | `cmdDebug` + log-bug helpers (moved verbatim) | Import statements |
| `src/commands/lifecycle.ts` | — | `cmdCancel`/`cmdApprove`/`cmdStop` (moved verbatim) | Import statements |
| `src/commands/patch.ts` | — | `cmdPatch` + helpers (moved verbatim) | Import statements |
| `src/commands/decompose.ts` | — | `cmdDecompose` + helpers (moved verbatim) | Import statements |
| `src/state-helpers.ts` | — | — | `resetPhaseState`, `isIdleOrDone`, `resolvePhaseArg` (extracted from commands.ts) |
| `index.ts` | — | `import * as Cmd from "./src/commands"` (unchanged) | — |
| `src/tools.ts` | — | — | Update comment at line 187: `src/commands.ts` → `src/commands/` |
| `test/state-validation.test.ts` | — | — | Update comment at line 20: `commands.ts` → `src/state-helpers.ts` |

## Scope

- **IN:** File split, import path updates, comment reference updates.
- **OUT:** Changing any command's behavior, adding new commands, changing the public API.

## Acceptance Criteria

1. `src/commands.ts` no longer exists.
2. `grep -rn "commands\.ts" src/ test/ --include="*.ts"` returns 0 hits (no stale textual references).
3. `grep -rn "from.*['\"]\.\.?/commands['\"]" src/ test/ --include="*.ts"` returns 0 hits (no old import paths).
4. `src/commands/index.ts` re-exports all 10 `cmd*` functions.
5. Each command module is under 200 lines.
6. `index.ts` (root) imports `* as Cmd from "./src/commands"` — unchanged.
7. `npx tsc --noEmit` passes.
8. `npx vitest run` — all tests pass.
9. No new dependencies introduced.

## Dependencies

None. Pure refactor.

## Findings Log

- The `cmdDebug` + log-bug sub-command (~120 lines) is the largest extraction
  candidate and has the least coupling to other commands.
- `resetPhaseState`, `isIdleOrDone`, and `resolvePhaseArg` are used by multiple
  command modules (loop, status, lifecycle, patch). They are extracted to
  `src/state-helpers.ts` (leaf module, imports only `types`) to avoid
  sibling-command imports.
- The `SessionEntry` interface and `DEBUG_LOG_TYPES` constant are only used by
  the debug/log-bug code — they move to `src/commands/debug.ts`.
- Two stale textual references to `src/commands.ts` exist outside the file:
  `src/tools.ts:187` (comment) and `test/state-validation.test.ts:20` (comment).
  Both must be updated. Acceptance criterion #2 (grep sweep) catches any others.
