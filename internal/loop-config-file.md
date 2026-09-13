# implement-loop-config-file

## Problem

Verified current state as of writing: all loop configuration is via
command-line flags parsed by `parseLoopArgs` (`src/selectors.ts:64`):

| Flag | Type | Default |
|---|---|---|
| `--coverage <N>` | number | 80 |
| `--language <L>` | go\|java\|typescript | auto-detect |
| `--branch [name]` | string | (no branch) |
| `--timeout <N>` | number | 60 |
| `--no-auto-approve` | boolean | false (auto-approve on) |

There is no project-level configuration file. Every `/loop` invocation needs
the full flag set, or the user relies on defaults. A project that always runs
with `--coverage 90 --timeout 120` must type those flags every time.

The `LoopState` interface (`src/types.ts:7`) stores all of these values, but
they are only set at `/loop` start from `parseLoopArgs` output. There is no
persistence across invocations.

## Target

A `loop.config.json` file at the project root (or `.pi/loop.config.json`)
provides project-level defaults for the loop flags. Command-line flags
override the config file. The config file is optional — its absence changes
nothing. The config is read at `/loop` start, merged with CLI flags (CLI
wins), and the merged values are passed to `createInitialState`.

Config file shape (all fields optional):

```json
{
  "coverage": 90,
  "language": "go",
  "timeout": 120,
  "autoApprove": false,
  "branch": true,
  "maxA": 3,
  "maxNegotiate": 3,
  "maxB": 5,
  "maxC": 3,
  "maxDispute": 3,
  "maxTurnsPerPhase": 5
}
```

## Interface

New function in `src/selectors.ts`:

```ts
export function loadLoopConfig(cwd: string): Partial<LoopArgs>;
```

Reads `loop.config.json` from `cwd` (or `.pi/loop.config.json`). Returns
`{}` if the file doesn't exist or is invalid JSON. Invalid JSON logs a
warning via `console.warn` (no `ctx` available at parse time) and returns
`{}`.

New function in `src/selectors.ts`:

```ts
export function mergeLoopArgs(cli: LoopArgs, config: Partial<LoopArgs>): LoopArgs;
```

CLI values override config values. A CLI value of `undefined` means "not
specified on the command line" → use the config value. Both `undefined` →
use the default.

The `LoopArgs` interface (`src/selectors.ts`) gains no new fields — it
already has `coverage`, `language`, `branch`, `timeout`, `autoApprove`.
The config file additionally supports `maxA`, `maxNegotiate`, `maxB`,
`maxC`, `maxDispute`, `maxTurnsPerPhase` which are currently hardcoded
defaults in `createInitialState`. These are added to `LoopArgs` as
optional fields.

## Behavior

**Resolution order** (first non-undefined wins):
1. CLI flag (from `parseLoopArgs`)
2. Config file (from `loadLoopConfig`)
3. Hardcoded default (in `createInitialState`)

**Config file discovery**:
- Check `<cwd>/loop.config.json` first
- Then `<cwd>/.pi/loop.config.json`
- First one that exists wins. Neither exists → `{}`.

**Invalid config**:
- File not valid JSON → `console.warn("loop.config.json: invalid JSON — using defaults")`, return `{}`
- File has unknown fields → ignore them (forward-compatible)
- File has a field with wrong type (e.g. `"coverage": "high"`) → ignore that field, use default

**Quirks list**:
- `--branch` is a flag (boolean) on the CLI but a string (branch name) in
  `LoopArgs`. The config file uses `"branch": true` for "use default name"
  and `"branch": "my-branch"` for a specific name. The merge logic must
  handle both.
- `--no-auto-approve` sets `autoApprove: false` on the CLI. The config file
  uses `"autoApprove": false` for the same effect. The merge must treat
  `autoApprove: false` from CLI as "explicitly set" (not "absent").

**Intended shifts**:
- `createInitialState` currently hardcodes `maxA: 3`, `maxNegotiate: 3`,
  `maxB: 5`, `maxC: 3`, `maxDispute: 3`, `maxTurnsPerPhase: 5`. These become
  overridable via config. The hardcoded values remain as fallback defaults.

**Ownership**:
- `src/selectors.ts` owns `loadLoopConfig` and `mergeLoopArgs`.
- `src/commands.ts` calls them in `cmdLoop`.
- `test/selectors.test.ts` asserts the merge logic and file reading.

## Inventory

**Files touched:**
- `src/selectors.ts` — add `loadLoopConfig`, `mergeLoopArgs`; extend
  `LoopArgs` with `maxA?`, `maxNegotiate?`, `maxB?`, `maxC?`, `maxDispute?`,
  `maxTurnsPerPhase?`
- `src/commands.ts` — call `loadLoopConfig` + `mergeLoopArgs` in `cmdLoop`;
  pass merged values to `createInitialState`
- `src/types.ts` — no change (LoopState already has all the fields)
- `test/selectors.test.ts` — new tests for `loadLoopConfig` + `mergeLoopArgs`
- `test/extension.test.ts` — update `cmdLoop` tests if they assert on
  hardcoded defaults

**Imports added:**
- `src/selectors.ts`: `import { readFileSync, existsSync } from "node:fs"`

**Call sites:**
- `cmdLoop` in `src/commands.ts`: currently calls `parseLoopArgs(args)` then
  `createInitialState(...)`. Becomes: `parseLoopArgs(args)` →
  `loadLoopConfig(cwd)` → `mergeLoopArgs(cli, config)` →
  `createInitialState(merged)`.

## Test Strategy

- **Baseline**: 1245 tests passing.
- **New tests** (`test/selectors.test.ts`):
  - `loadLoopConfig` with no file → `{}`
  - `loadLoopConfig` with valid JSON → parsed object
  - `loadLoopConfig` with invalid JSON → `{}` + warning logged
  - `loadLoopConfig` with unknown fields → fields ignored
  - `loadLoopConfig` with wrong type → field ignored
  - `mergeLoopArgs` CLI wins over config
  - `mergeLoopArgs` config fills in CLI gaps
  - `mergeLoopArgs` both empty → defaults
  - `mergeLoopArgs` `autoApprove: false` from CLI is "set" (not "absent")
  - `mergeLoopArgs` `branch: true` from config → default branch name
- **Updated tests**:
  - `test/extension.test.ts`: `cmdLoop` tests that assert on default values
    (e.g. `coverageThreshold: 80`) — these still pass because the config
    file doesn't exist in the test environment.
- **Untouched**: `src/types.ts`, `src/state-validation.ts` (no shape change).

## Scope lines

- `src/selectors.ts`: kept + 2 new functions + 6 new optional fields on
  `LoopArgs`
- `src/commands.ts`: kept + 2 new calls in `cmdLoop`
- `test/selectors.test.ts`: kept + ~10 new tests
- `test/extension.test.ts`: kept (no changes expected)

## Acceptance Criteria

- `npx tsc --noEmit` clean
- `npx vitest run` green (1245 + new tests)
- `grep -r "loadLoopConfig\|mergeLoopArgs" src/ test/` returns ≥ 4 matches
- Config file is NOT required: running `/loop` in a directory without
  `loop.config.json` behaves exactly as before
- CLI flags override config: `/loop --coverage 95` with
  `loop.config.json` `"coverage": 80` → 95

## Dependencies

None.

## Findings log

(empty — clean Phase 0)
