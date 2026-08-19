# Remove monolith shim and consolidate the registration surface

## Problem

After specs #1–#5, all handler *logic* lives in the `src/events/` module tree. `src/events.ts` remains as a shim — but it is **not a pure delegator**. Verified against the current file, it owns two things that have nowhere to go unless this spec says where:

1. **Raw-event extraction.** The four `event*` factories cast the raw pi event before calling the handler:
   - `eventBeforeAgentStart`: `const evt = event as { systemPrompt: string }; … systemPrompt: evt.systemPrompt`
   - `eventToolCall`: `const evt = event as { toolName: string; input?: Record<string, string> }; … toolName: evt.toolName, path: evt.input?.path` (`input?.path` is `undefined` for pathless tools — the handler never throws; the extraction is load-bearing)
   - The handlers take *typed* inputs, not raw events. Deleting the shim without relocating the factories loses the extraction and the extension entry point cannot register.
2. **A duplicate `EventCtx`.** The identical interface is defined in both `src/events.ts:15` and `src/events/index.ts:7`; `DebugFn` exists only in the shim.

## Target

Delete `src/events.ts`. The four `event*` factories move into `src/events/index.ts`, which becomes the **registration surface** (the directory barrel, currently type-only, gains its runtime exports). The extension entry point needs **no change**.

## Changes

### 1. Move the four factories verbatim into `src/events/index.ts` (B1)

Move `eventSessionStart`, `eventBeforeAgentStart`, `eventToolCall`, `eventAgentSettled` body-for-body, **including the raw-event extraction lines** (pinned above). Complete import inventory after the move (F1 closes the list — the shim's six import lines are accounted for):

| Shim import (current) | Barrel after move |
|---|---|
| `./events/session-start` (and the 3 sibling handler imports) | **Rewritten**: `./session-start`, `./before-agent`, `./tool-call`, `./agent-settled` (the barrel sits *inside* `src/events/`) — the only **new** import lines |
| `./types` | **Rewritten to `../types`** — but the barrel already has exactly `import type { LoopState } from "../types"` (line 3), so it is **absorbed**: no new line, the moved factories' `LoopState` references bind to it |
| `@earendil-works/pi-coding-agent` | **Unchanged** — the barrel already has the same package import (line 5); the factories' `ExtensionAPI` references bind to it |

- **`EventCtx`/`DebugFn`**: the factories reference the barrel's own `EventCtx` (V1: the shim's duplicate copy is deleted, not re-imported) and the moved `DebugFn` (V2).
- **Header comment** (F4): the barrel's `// --- Events module index ---` block is updated to state that the barrel is the registration surface hosting the four factories.

Factory signatures and return shapes are unchanged — `pi.on(...)` registration keeps the exact same call shape.

### 2. Type surface (V1, V2, V3)

- `EventCtx`: the barrel's existing copy becomes the **sole** definition (the shim's duplicate dies with the file).
- `DebugFn`: moved from the shim, **exported** (the barrel is the type surface; `EventCtx` is already exported from it).
- Existing type re-exports (`SessionStartHandler`, `BeforeAgentHandler`, `ToolCallHandler`, `AgentSettledDispatcher`, `GateHandler*`, `Effect*`, `Review*`, `Negotiate*`, `Dispute*`): **kept as-is**. Verified valid — `tsc --noEmit` passes cleanly against the current barrel; none are stale.

### 3. Delete `src/events.ts`

### 4. Entry point: zero changes (M3)

- Registration lives in the **root `index.ts`** (L8 `import * as Ev from "./src/events";`, L72–75 `pi.on(...)`). The spec's original guess (`src/commands.ts`) was wrong — that file exists but registers tools, not events.
- Node/TS resolution: `./src/events` prefers the file `events.ts`; once deleted, the specifier resolves to `src/events/index.ts` **automatically**. `Ev.eventSessionStart` et al. keep resolving because the barrel now exports the factories. **Do not touch `index.ts`.**

### 5. Test migration (B2) — "all existing tests pass" is false without this

Functional blast radius verified: `index.ts:8` is the only production importer; in tests, `session-start-wiring.test.ts` is the only file that reads `src/events.ts` on disk or imports it by name. (Textual references are handled separately by the F3 prose sweep — the functional check does not cover them.)

**`test/events/session-start-wiring.test.ts`:**

| Location | Change |
|---|---|
| `readEventsSource()` (L310–312) | Path `../../src/events.ts` → `../../src/events/index.ts` (currently ENOENT after deletion) |
| "imports handleSessionStart from ./events/session-start" check (L314–316) | Regex `\.\/events\/session-start(\.js)?['"]` → `\.\/session-start(\.js)?['"]` (path shortened with the move); test renamed to match |
| Error-message string (L323, `${name} should be removed from src/events.ts`) | Re-targeted to `src/events/index.ts` (it is user-visible on failure) |
| Header prose (L5, L8, L18 — "src/events.ts monolith", "stubbing src/events.ts", "removed from src/events.ts") | Re-targeted to the barrel / registration surface |
| "still exports eventSessionStart (registration surface unchanged)" + the three sibling factory assertions (L329–336) | **Kept verbatim.** `../../src/events` now resolves to the barrel; these assertions are exactly what pins the factory surface to the barrel — they pass *because* of change #1, which cross-checks the placement |
| Entry-point seam test (`extensionFactory`, behavioral) | Unchanged — no import-path assertions |

**`test/events/index.test.ts`:**

| Location | Change |
|---|---|
| `await import("../../src/events")` (L26) | Keeps working (resolves to the barrel); the comment "All exports are type-only … no runtime values expected" is stale — update it, and strengthen the vacuous `>= 0` assertion to pin the four factory exports by name: `eventSessionStart`, `eventBeforeAgentStart`, `eventToolCall`, `eventAgentSettled` each `typeof === "function"` (F2) |
| Type-level checks (`EventCtx`, `GateHandlerInput`, `EffectInput`) | Unchanged |

**Prose sweep (F3)** — beyond the two tables above, re-target the remaining textual references so the post-change grep (below) returns zero:

| Location | Reference |
|---|---|
| `src/events/tool-call.ts:5` | Header: "Mirrors the former eventToolCall in src/events.ts" → `src/events/index.ts` |
| `test/events/tool-call-enforcement.test.ts:6` | Header: "…mirror the monolith eventToolCall in src/events.ts" → `src/events/index.ts` |

(Line numbers are as of writing; the sweep criterion is the grep, not the line numbers.)

## Scope lines (final shape)

- `src/events.ts`: **deleted**
- `src/events/index.ts`: barrel = `EventCtx` (sole copy) + exported `DebugFn` + four `event*` factories + existing type re-exports. No other additions.
- Root `index.ts`: **byte-identical**
- No other `src/` file changes (verified: no other importer of the shim)

## Constraints

- **No behavioral change** = full `npm test` green (unit + golden + e2e). The seam test in `session-start-wiring.test.ts` is the end-to-end regression guard for the registration path.
- No factory signature or return-shape change — `pi.on` registration is byte-for-byte the same calls.
- `tsc --noEmit` clean after deletion (no dangling import of the removed file; the barrel's re-exports stay valid).

## Acceptance Criteria

- [ ] `src/events.ts` does not exist
- [ ] Four `event*` factories in `src/events/index.ts`, verbatim including raw-event extraction; imports use the shortened `./X` paths (B1)
- [ ] `EventCtx` has exactly one definition (the barrel's); `DebugFn` moved and exported (V1/V2)
- [ ] Root `index.ts` byte-identical; registration unchanged (M3)
- [ ] `session-start-wiring.test.ts` migrated per table; `index.test.ts` comment updated + four-factory runtime-export assertion added (B2/F2)
- [ ] Prose sweep: `grep -rn "events\\.ts" src/ test/ index.ts` returns **zero** lines (all 7 known references re-targeted: `tool-call.ts:5`, wiring-test L5/L8/L18/L311/L323, enforcement-test L6) (F3)
- [ ] Barrel header comment updated to name the registration surface (F4)
- [ ] Existing type re-exports intact and `tsc --noEmit` clean (V3)
- [ ] `npm test` fully green (unit + golden + e2e)

## Dependencies

Depends on #1–#5 — **all done** (01 wired session-start; 02/03 implemented tool-call and before-agent; 04 implemented agent-settled; 05 extracted the effect applicator). The shim currently delegates to all four modules, which is the precondition for a deletion-only refactor.

## Risks

Low. Deletion-only refactor; the only moving code is the four small factories plus two one-line types, and the only test edits are path/regex/comment updates. The named-import assertions in the wiring test double as the placement cross-check.

## Phase 0 review findings

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| R0 | — | Auto-generated "I/O without error handling" finding | **Rejected.** No I/O in this spec — it's import wiring + a file deletion. Nothing to error-handle; the faithful behavior of the moved factories is unchanged |
| B1 | Blocking | Shim owns raw-event extraction, not just delegation — spec never said where extraction goes; entry point can't call handlers with raw events | **Accepted (verified: extraction lines in `eventBeforeAgentStart`/`eventToolCall`, incl. the load-bearing `input?.path`).** Reviewer's recommendation adopted verbatim: factories move into `src/events/index.ts` as the registration surface, extraction lines pinned |
| B2 | Blocking | Existing tests import the shim by name; deletion breaks "all existing tests pass" without a migration step | **Accepted, scope narrowed (verified).** Precise blast radius: `readEventsSource()` reads the file on disk (ENOENT) + one import regex + stale comments. The named-import assertions (L329–336) and `index.test.ts`'s dynamic import **survive unchanged** *because* the factories land in the barrel — the wiring test's "registration surface unchanged" assertions now pin the placement itself. Migration table added |
| M3 | Minor | Registration is in root `index.ts` (L72–75), not `src/commands.ts`; `./src/events` resolves to the directory automatically after deletion | **Accepted (verified: `index.ts:8` is the sole importer; `src/commands.ts` registers tools only).** Spec now pins "entry point byte-identical" and documents the resolution fallback |
| M4 | Minor | Pick one convention: barrel vs individual-module imports | **Accepted: barrel-only.** The old spec's "import individual handlers in the entry point" was wrong in two ways — the entry point calls *factories*, not handlers, and M3's zero-change rule makes any import edit scope creep. Barrel is the single registration surface |
| V1 | (found during verification) | `EventCtx` is currently defined in **both** the shim and the barrel | **Accepted.** Deletion removes the shim copy; spec pins the barrel's copy as sole canonical definition |
| V2 | (found during verification) | `DebugFn` exists only in the shim | **Accepted.** Moved to the barrel and exported, consistent with `EventCtx`'s export |
| V3 | (found during verification) | Barrel's type re-exports needed validity checking before "keep as-is" could be pinned | **Accepted.** `tsc --noEmit` passes cleanly against the current barrel; all re-exported type names exist in their modules; pinning them as kept, with tsc as the acceptance check |
| F1 | Residual | "One mechanical difference" missed a second import rewrite: shim's `import type { LoopState } from "./types"` must become `../types` in the barrel (barrel L3 is the proof) | **Accepted (verified: shim L7 `./types`; barrel L3 `../types` already present).** Import inventory now a 3-class table: handler-module rewrites (the only new lines), `./types`→`../types` (absorbed by existing barrel import), package import (unchanged) — the list is closed |
| F2 | Residual | `index.test.ts` "module is importable" comment stale; vacuous `>= 0` assertion should pin the factory exports | **Accepted.** Migration table + acceptance criterion now name all four factory exports explicitly |
| F3 | Residual | No post-change sweep; stale `src/events.ts` prose references survive deletion (grep found 7 across src/ + test/), incl. two files the earlier functional blast-radius check never inspected | **Accepted — verification gap acknowledged.** The earlier "blast radius verified" covered only functional references (imports/reads); the filtered grep excluded prose. Sweep criterion added: zero `events\.ts` matches across `src/`, `test/`, `index.ts`, with all 7 sites enumerated |
| F4 | Residual (cosmetic) | Barrel header comment still reads "Re-exports and shared types" once it hosts the factories | **Accepted.** Header update added to Changes #1 + scope line + acceptance criterion |
