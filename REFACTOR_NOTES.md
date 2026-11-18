# REFACTOR_NOTES — `index.ts` behavior-preserving refactor

Branch: `refactor/split-index` (from `main` @ `cfa0d64`)

## Prime directive
**No behavior changes.** Pure structural refactor. No bug fixes, no renaming of
user-facing names, no registration-order changes, no string/prompt changes, no
config/persisted-state format changes. Findings go here under "Observed issues".

## Scope reality check (important)
The task brief described `index.ts` as ~1950 lines. **It is actually 117 lines
and is already a thin composition root.** Commands, tools, and events are
already fully modularized under `src/`. So this is NOT a "split a giant file"
task — the modularization is done. The only real logic left in `index.ts` is:
the inline `state` initializer, the `debug()` helper, the registration wiring,
the import-time language-init side effect, and the loop-breaker wiring + test
seam. The plan below extracts only those.

## Working-tree caveat
`main` had uncommitted changes from another agent when this branch was created.
They were carried over and are deliberately left **untouched and uncommitted**.
This refactor commits **only** `index.ts` + new modules under `src/` — never
`git add -A`. The baseline below therefore runs against the dirty tree (it
includes the other agent's uncommitted changes), not a pristine `main`.

---

## Phase 0 map

### What the extension host consumes (default export = the only registered entry)
`package.json` → `"extensions": ["./index.ts"]`. The default export is
`function (pi: ExtensionAPI) { ... }`.

### Registered surface (SNAPSHOT — diff against this after every step)

**Commands (11), registration order:**
1. `spec` (via `cmdSpec` from `./src/spec-command`)
2. `loop`
3. `loop-approve`
4. `loop-status`
5. `loop-continue`
6. `loop-restart`
7. `loop-debug`
8. `loop-cancel`
9. `loop-stop`
10. `loop-patch`
11. `loop-decompose`

**Tools (2):** `negotiate_propose`, `negotiate_review`

**Event hooks (`pi.on`), registration order — 7 registrations:**
1. `agent_settled` → `eventAgentSettled`
2. `session_start` → `eventSessionStart`
3. `before_agent_start` → `eventBeforeAgentStart`
4. `tool_call` → `eventToolCall` (path enforcement)
5. `tool_call` → `createRepeatedToolCallHandler` (the repeated-call loop breaker)
6. `turn_start` → `resetCallCounters()` + `resetReconCounters()`
7. `agent_settled` → `resetCallCounters()` + `resetReconCounters()`

**Test-only export:** `__getStateForTest()` (never called in prod).

### Logical sections of `index.ts`
1. Imports (ordered): types, commands barrel, `spec-command`, tools barrel,
   events barrel, tool-call helpers, languages.
2. **Import-time side effect:** `getLanguageConfig("go")` triggers lazy language
   init. Order matters — must run before anything that reads language config.
3. Inline `state` object literal (~50 lines) — initial `LoopState`.
4. `debug()` helper (`pi.appendEntry("loop-debug", ...)`).
5. Command registrations.
6. Tool registrations.
7. Event registrations.
8. `registerLoopBreaker()` (module scope) + `lastState`/`__getStateForTest` seam.

### Module-level mutable state
The `state` object is created **fresh inside the default-export closure** on each
registration, then threaded into every command handler and event factory as a
parameter. It is the single source of truth and lives only in `index.ts`.
Readers/writers: all `cmd*` handlers and all `event*` factories (they receive
`state` as arg 1). No other module-level mutable state exists in this file.

### Import-time side effects / ordering deps
- `getLanguageConfig("go")` at import time (lazy-init trigger).
- Registration order: commands → tools → events → loop breaker. Must be preserved.
- The **second** `tool_call` registration (loop breaker) is intentional and must
  stay as a separate registration — do not consolidate with #4.

### External dependencies / I/O
- `pi ExtensionAPI` — fully mocked in tests (`test/__mocks__/...`).
- `node:fs` / `node:path` — only used inside `src/` submodules, not `index.ts`.
- `typebox` — via the mock.
- No network, no child processes, no env-var reads in `index.ts`.

---

## Phase 1: baseline

- **Typecheck** (`npx tsc --noEmit`): **exit 0, clean.**
- **Tests** (`npx vitest run`): **65 files, 1828 tests, all pass.** Duration ~31s.
- **Lint / build:** none configured (`package.json` has only `test`; `tsconfig`
  has `noEmit`, so typecheck *is* the build gate).

### Characterization tests
Existing suite already covers command/tool/event behavior at 1828 tests. No new
characterization tests needed for the `state.ts` extraction — the initial-state
object is exercised indirectly by the existing pipeline tests. Manual smoke
checklist for host integration is below (can't be unit-tested; host is mocked).

### Manual smoke-test checklist (host integration, can't unit-test)
- [ ] All 11 commands still register under the exact same names.
- [ ] Both tools register (`negotiate_propose`, `negotiate_review`).
- [ ] All 7 event registrations fire in the same order.
- [ ] `/loop` still initializes state to the same defaults (phase=idle, round=0,
      language=go, buildTool=maven, coverageThreshold=80, etc.).
- [ ] `agent_settled` round-advance still works via the `__getStateForTest` seam.

---

## BLOCKER — `index.ts` is byte-pinned by an existing test (M3)

The suite contains `test/events/registration-surface.test.ts`, whose **M3** test
pins `index.ts` to be **byte-identical** via SHA-256 (`ENTRY_SHA256 =
2951ec0c…`). Its contract header (from spec `internal/06-remove-monolith.md`)
makes this an explicit design decision:

> Entry point byte-identical (M3) — pinned by SHA-256.

The prior refactor achieved modularization by moving logic **into** `src/`
modules **while leaving `index.ts` frozen**. The M3 hash has been re-baselined
before, but only for **behavior** changes (adding `/spec`, the `cmdDebug(state,
debug)` fix). A pure structural refactor that changes `index.ts`'s bytes is a new
category the test does not currently permit.

**Consequence:** any extraction *from* `index.ts` (state factory, loop-breaker
wiring, debug helper) changes its bytes and breaks M3. There is no way to shrink
`index.ts` without either (a) leaving it frozen, or (b) explicitly re-baselining
M3 — which overrides a documented, intentional design decision and must be a
human call, not a silent test-edit.

**Action taken:** the `src/state.ts` extraction was tried, M3 failed as
predicted, and the change was fully reverted (index.ts SHA re-verified against
`2951ec0c…`; suite green: 34/34 in that file, 1828 total). Nothing is left
uncommitted from this attempt.

**Decision (2025-08, user): OPTION A — leave `index.ts` frozen.**

`index.ts` is already a thin composition root (~117 lines, not the ~1950 the
brief assumed) and is intentionally frozen by the M3 test. The extension is
already well-modularized under `src/`. There is nothing safe to refactor *inside*
`index.ts` without overriding a documented design decision. The refactor task's
premise does not apply here; the correct outcome is **no change to `index.ts`**.

## Phase 2: planned extraction

1. **`src/state.ts`** — `createState(): { current: LoopState }` factory moving the
   ~50-line object literal out verbatim. `index.ts` imports it.
2. **`src/loop-breaker.ts`** (optional, lower priority) — `registerLoopBreaker(pi,
   debug)` moving the breaker wiring out.

Everything else already lives in its module; no `types.ts`/`constants.ts`/`utils/`
split needed (those dirs already exist and are populated).

## Definition of done
- `index.ts` thin composition root (~55 lines after step 1).
- tsc + tests match baseline (1828 pass, tsc clean).
- Registered surface byte-identical to snapshot above.
- Each commit small + revertible (`refactor: extract <thing>`).
