# implement-log-bug-flag

## Problem

Verified current state as of writing (every line re-checked against the repo before this draft; the repo changed between the first draft of this spec and now — `src/events.ts` no longer exists, `src/commands.ts` imports changed — so no line ref from the first draft was reused without re-verification):

**Goal gap.** When a loop run misbehaves (e.g. "frozen at Phase B Step 5"), the evidence lives in the session's `loop-*` custom entries. Capturing it for a follow-up fix is fully manual: run `scripts/extract-session.sh`, hand-assemble a markdown file, write the description by hand.

**The script is machine-bound and disk-only.** `scripts/extract-session.sh:6` hardcodes `SESSION_DIR="$HOME/.pi/agent/sessions/--Users-alancapps-.pi-agent-extensions-loop-go-bak--"` — a path that only exists on the author's machine. No-arg mode (script lines 10–11) fails elsewhere. The script only reads session *files on disk* (line 9), so it cannot serve the live in-process session from inside the extension.

**The in-process equivalent has no capture affordance.** `cmdDebug` (`src/commands.ts:308–320`) ignores its args entirely (line 311: `_args`) and always prints the last 20 entries. There is no way to turn a live session into a spec file.

**Latent bug in the same function.** `extractDebugLogs` (`src/commands.ts:322–338`) reads `entry.ts` (line 335). No producer writes a top-level `ts`: the `loop-debug` producer writes `data.ts` (`index.ts:45`: `pi.appendEntry("loop-debug", { ts: Date.now(), msg })`); the persisted JSONL envelope carries top-level `timestamp` (`scripts/extract-session.sh:36` reads `d.get('timestamp', '')`); the test-mock envelope has no top-level `ts` (`test/extension.test.ts:672–697`: `{type, customType, data}`). So `entry.ts ?` at line 335 is always false and the no-arg display renders `?` for every timestamp.

**Emitted customTypes — closed inventory (22 producer sites, 5 types).** Verified by `grep -rn 'appendEntry(' src/ index.ts` as of writing:

| customType | Producers (file:line) | Payload shape |
|---|---|---|
| `loop-debug` | `index.ts:45` (helper `debug()`, called throughout) | `{ts: number, msg: string}` |
| `loop-state` (14 sites) | `src/commands.ts:192,257,304,354,381`; `src/tools.ts:159,169,286,299,375,388`; `src/events/before-agent.ts:179`; `src/events/agent-settled/review.ts:36`; `src/events/agent-settled/dispute.ts:50` | `{...state.current}` (incl. `phase`, `round`) |
| `loop-refusal` (4 sites) | `src/events/tool-call.ts:81,90,101,114` | line 81/101/114: `{phase, path, tool}`; line 90: `{phase, tool}` (**no `path`**) |
| `loop-negotiate` (1 site) | `src/tools.ts:333` | `{phase, round, action, text≤500}` |
| `loop-dispute` (2 sites) | `src/tools.ts:348` (filed: `{phase, round, disputeCount, claim≤500, text≤500}`); `src/tools.ts:362` (concede: `{phase, round, action: "concede"}` — **no `disputeCount`/`claim`**) | two shapes |

`loop-gate` is emitted by **no** code — it appears only in `extractDebugLogs`'s `validTypes` (`src/commands.ts:325`), a dead filter entry. `loop-event` is emitted by **no** code — it appears only in the not-started proposal `internal/logging-spec.md` and `scripts/extract-session.sh:46`. (First-draft verification miss — see Findings log #1.)

**Doc state.** `README.md:45`: `| `/loop-debug` | Show last 20 debug entries |`. `SPEC.md:235–237`: `### `/loop-debug`` — "Shows the last 20 debug entries (phase transitions, gate results, refusals, disputes)."

**Baseline (as of writing).** `npx tsc --noEmit` → exit 0. `npm test` (`vitest run`, `package.json:15`) → 31 files, 944 tests, 0 failures. Existing `/loop-debug` tests: 2 `it`s inside `describe("/loop-debug command")` at `test/extension.test.ts:351` (its at lines 360 and 370).

## Target

After this change, in the session where a bug was observed, the user runs:

```
/loop-debug --log-bug frozen-at-phase-b-step-5
```

The extension extracts the five emitted `loop-*` entry types in-process (no disk read), and writes `bug-fix-frozen-at-phase-b-step-5.md` into `ctx.cwd` — a self-contained, `/loop`-runnable spec: auto Context (phase/round/spec/language from `state.current`), placeholder prompts for Observed problem / Proposed fix / Acceptance, and the auto-extracted Log excerpt inlined. The no-arg `/loop-debug` keeps its exact display contract except timestamps render from `data.ts`/`timestamp` instead of `?`. `README.md` and `SPEC.md` document the flag. `scripts/extract-session.sh` is untouched (it remains the tool for *past* session files; its hardcoded path is out of scope here).

## Interface

**New module `src/bug-spec.ts`** — 6 exported symbols (4 functions + 2 types), all pure except `writeBugSpec`:

```ts
export function slugBugName(name: string): string;
// lowercase; each run of chars not matching [a-z0-9] → single "-"; trim leading/trailing "-"
// "Frozen at Phase B Step 5" → "frozen-at-phase-b-step-5"; "   " → ""

export function extractLoopLogs(entries: unknown[]): string[];
// pure; one formatted line per emitted-type entry, in input order (see Behavior for formats)

export interface BugSpecInput {
  name: string;      // as given, verbatim — used in the title
  slug: string;      // from slugBugName
  phase: string;     // state.current.phase
  round: number;     // state.current.round
  specPath: string;  // state.current.specPath
  language: string;  // state.current.language
  lines: string[];   // from extractLoopLogs
  now: Date;
}

export function renderBugSpec(input: BugSpecInput): string; // pure; full markdown (see Behavior)

export type BugSpecWriteResult =
  | { ok: true; path: string }
  | { ok: false; reason: "exists" | "write-failed"; message: string };

export function writeBugSpec(cwd: string, slug: string, markdown: string): BugSpecWriteResult;
// NEVER THROWS — every failure path returns a result (Phase 0 finding: a throwing
// writeFileSync would reject the handler and break the one-notify invariant).
// Evaluation order:
//   1. existsSync(join(cwd, `bug-fix-${slug}.md`)) → { ok:false, reason:"exists", message:"" } WITHOUT writing
//   2. writeFileSync(..., markdown, "utf8") inside try/catch:
//        success → { ok:true, path: join(cwd, `bug-fix-${slug}.md`) }
//        throw   → { ok:false, reason:"write-failed", message: err instanceof Error ? err.message : String(err) }
// imports: node:fs (writeFileSync, existsSync), node:path (join) — the only I/O in the module
```

**`cmdDebug` signature change** (`src/commands.ts:308`): `cmdDebug()` → `cmdDebug(state: { current: LoopState }, debug: DebugFn)`. `DebugFn` is already imported (`src/commands.ts:5`, from `./events`, defined at `src/events/index.ts:29`). Registration call site `index.ts:57`: `Cmd.cmdDebug()` → `Cmd.cmdDebug(state, debug)` (`state` wrapper at `index.ts:18`, `debug` helper at `index.ts:44–46` — both in scope). No new imports needed in `index.ts` (`Cmd` is imported at `index.ts:6`).

**Persisted state.** No new `customType` is emitted; no session-entry shape changes; the restore path (`src/events/session-start.ts`) is untouched; pre-change sessions stay valid. The only new artifact is a markdown file in `ctx.cwd`, which no code reads (it is consumed by humans/agents via `/loop`). There is no migration question.

## Behavior

**Handler decision table** (first-match-wins; exactly one `notify` per invocation):

| # | Condition (evaluated in order) | Branch | Side effects (order) | notify (level) |
|---|---|---|---|---|
| 1 | `--log-bug` present, slug non-empty, write succeeds | log-bug success | write file → `debug(\`log-bug: wrote ${path}\`)` | `` `Wrote bug-fix-${slug}.md\nNext: fill in Observed problem / Proposed fix, then /loop bug-fix-${slug}.md` `` (`info`) |
| 2 | `--log-bug` present, slug empty (name empty, whitespace-only, or no `[a-z0-9]` after slugify) | usage | none | `"Usage: /loop-debug --log-bug <name>"` (`warning`) |
| 3 | `--log-bug` present, `writeBugSpec` returns `{ok:false, reason:"exists"}` | collision | none (file untouched) | `` `bug-fix-${slug}.md already exists. Pick a different name.` `` (`error`) |
| 4 | `--log-bug` present, `writeBugSpec` returns `{ok:false, reason:"write-failed"}` (writeFileSync threw — e.g. cwd missing or unwritable) | write failure | none (no file created) | `` `Failed to write bug-fix-${slug}.md: <message>` `` (`error`) — `<message>` is the result's `message` field |
| 5 | no `--log-bug` in args | legacy (today's code) | none | `` `Loop debug (${logs.length} entries):\n${logs.slice(-20).join("\n")}` `` (`info`) — unchanged |

**Argument parsing (pinned).** Whitespace-split like `parseLoopArgs` (`src/selectors.ts:50`). `--log-bug` as a token: consume all following tokens that do not start with `--`, join with `" "` as the name (so `/loop-debug --log-bug Frozen at Phase B Step 5` works). `--log-bug=<x>`: name is the remainder of that token verbatim. No other flags exist for this command. **Tail (pinned):** `--log-bug` as the final token (nothing after it) → name = `""` → row 2 (usage); a `--`-prefixed token stops name consumption and is otherwise ignored in both modes (consistent with quirk 1); positional tokens before `--log-bug` are ignored in log-bug mode. In the legacy branch (row 5), args are ignored exactly as today (quirk 1).

**`extractLoopLogs` — filter and formats (verbatim pins).**
Filter: `entry.type === "custom"` and `customType` ∈ {`loop-debug`, `loop-state`, `loop-refusal`, `loop-negotiate`, `loop-dispute`} — the 5 emitted types, nothing else (no `loop-gate`, no `loop-event`). Field access: payload from `entry.data`; if `data` is absent, fall back to the entry's top level (robust to both envelope directions). `ts` resolution, in order: `data.ts` (number, epoch ms → `new Date(n).toISOString()`) → top-level `timestamp` (string, used as-is) → `-`. One line per entry, in input order (no re-sort):

- `loop-debug`: `[<ts>] [debug] <msg>`
- `loop-state`: `[<ts>] [state] phase=<phase> round=<round>`
- `loop-refusal`, `path` present: `[<ts>] [refusal] <phase>: blocked write to <path>`; `path` absent (the `tool-call.ts:90` shape): `[<ts>] [refusal] <phase>: blocked <tool>` — explicit branch; the bash script prints a dangling `"blocked write to "` here, a gap we deliberately do not mirror
- `loop-negotiate`: `[<ts>] [negotiate] <action>: <text>` with `text` truncated to 80 chars
- `loop-dispute`, `claim` present: `[<ts>] [dispute] #<disputeCount>: <claim>` (80-char truncation); else `action` present: `[<ts>] [dispute] <action>`; else: `[<ts>] [dispute] <JSON.stringify(data)>` (100-char truncation)
- any other `customType`, or non-custom entry: excluded (no line)

**`renderBugSpec` output — verbatim pin** (`<…>` = interpolated; blank lines as shown):

```markdown
# Bug: <name>

> Generated by /loop-debug --log-bug on <now.toISOString()>
> Resolve with: /loop bug-fix-<slug>.md

## Context

- Loop state at logging time: phase=<phase>, round=<round>, spec=<specPath>, language=<language>
```
(the single Context bullet is the line above when `phase !== "idle"`, else: `- Loop state at logging time: no active loop`)
```markdown

## Observed problem

Describe the misbehavior: what you expected, what happened, where. (Fill in before running the loop.)

## Proposed fix

Describe the fix approach the Writer should take. (Fill in before running the loop.)

## Log excerpt

<lines joined by "\n"; if lines is empty: (no loop events found in this session)>

## Acceptance

- The observed problem no longer reproduces.
- <fill in: specific check>
```

Empty placeholder sections are a feature: Phase 0 flags underspecified behavior, so an unfilled spec is caught by the existing review gate before code is written — no new enforcement needed.

**Side-effect contract (complete).** File writes: at most one, on the log-bug flow after the usage check, `join(cwd, "bug-fix-" + slug + ".md")`, utf8. `notify`: exactly one per invocation — every decision-table row ends in exactly one notify, and `writeBugSpec` never throws, so no path can skip it. `pi.appendEntry` / `pi.sendUserMessage`: none. Mutations of `state.current`: none (read-only). `debug()`: one call, row 1 only (pattern matches existing commands, e.g. `src/commands.ts:303`).

**Quirks (current behavior, do not fix):**
1. Legacy branch ignores *all* args, including unknown flags — kept (only `--log-bug` is special-cased; nothing else is validated).
2. Legacy display counts all entries but shows only the last 20 (`.slice(-20)`, `src/commands.ts:315`) — kept.
3. Legacy per-line format `[<ts>] <customType>: <120-char JSON slice>` (`src/commands.ts:336`) — kept; the new formats apply only to the file's Log excerpt.
4. `loop-gate` stays in `extractDebugLogs`'s `validTypes` (`src/commands.ts:325`) — dead entry (no producer), preserved for the legacy display; the new filter excludes it.
5. `scripts/extract-session.sh`: the `sort` pipe and its refusal-line dangling-space gap — untouched (separate tool).

**Intended shifts (before → after):**
1. Legacy no-arg display timestamp: `?` (line 335's `entry.ts` never exists — verified above) → ISO value from `data.ts`, falling back to `timestamp`, falling back to `-`. Existing display tests keep passing because none assert the `?` text (Test Strategy).
2. `index.ts:57` registration: `Cmd.cmdDebug()` → `Cmd.cmdDebug(state, debug)` — factory arity grows; the only `cmdDebug` call site in src is this registration (grep: no other call site, no test imports it — tests reach it via `findCommand`).
3. The new excerpt covers exactly the 5 emitted types. When `internal/logging-spec.md` (not started) lands its `loop-event` producer, *that* spec must extend `extractLoopLogs`'s filter — not this unit.

**Ownership.** `slugBugName` / `extractLoopLogs` / `renderBugSpec` / `writeBugSpec` → `src/bug-spec.ts`, asserted in `test/bug-spec.test.ts` (new). Command routing, arg parsing, and the notify strings → `src/commands.ts` `cmdDebug`, asserted in the existing `describe("/loop-debug command")` block (`test/extension.test.ts:351`). Registration → `index.ts:57`, covered by the existing "registers all 7 commands" test (`test/extension.test.ts:83`, unchanged — still 7 commands).

## Inventory

**Files (7 touched; last: SPEC.md):**
1. `src/bug-spec.ts` — added (new)
2. `src/commands.ts` — modified (1 import line added; `cmdDebug` 308–320 rewritten; 1 line replaced at 335; nothing removed)
3. `index.ts` — modified (line 57 only)
4. `test/bug-spec.test.ts` — added (new)
5. `test/extension.test.ts` — modified (additive `it`s inside the describe at line 351; 0 lines removed)
6. `README.md` — modified (line 45 replaced; short paragraph added after the Commands table)
7. `SPEC.md` — modified (lines 236–237 replaced by the expanded `/loop-debug` block; nothing removed outside it)

Untouched (closed): `scripts/extract-session.sh` (0 lines), `src/events/**`, `src/languages/**`, `src/baseline.ts`, all other src and test files. Last untouched item: `src/baseline.ts`.

**Imports (every line accounted for):**
- `src/commands.ts`: existing 9 import lines (3–11) unchanged; +1 added: `import { slugBugName, extractLoopLogs, renderBugSpec, writeBugSpec } from "./bug-spec";`
- `src/bug-spec.ts`: 2 lines, new file: `import { writeFileSync, existsSync } from "node:fs";` and `import { join } from "node:path";`
- `index.ts`: 0 import changes (`Cmd` already imported at line 6)
- `test/bug-spec.test.ts`: imports `../src/bug-spec` + `node:fs`/`node:os` (mkdtemp) — new file

**Call sites (closed):** `cmdDebug` — defined `src/commands.ts:308`, registered exactly once at `index.ts:57`. `writeBugSpec` — called exactly once (inside `cmdDebug`, log-bug flow after the usage check). `extractLoopLogs` / `renderBugSpec` / `slugBugName` — called once each in `cmdDebug`; test-only elsewhere.

**Exports (closed, 6 new symbols):** the 4 functions + `BugSpecInput` + `BugSpecWriteResult` from `src/bug-spec.ts` — exported for unit-testability (assertion lives with the code). No existing export is removed or renamed. `cmdDebug`'s exported signature changes (shift 2).

**Dead code:** none removed. The `loop-gate` entry in `validTypes` is dead but pinned in place (quirk 4).

## Test Strategy

**Baseline (as of writing):** 944/944 tests, 31 files, `tsc --noEmit` clean. `vitest run` does not type-check (`package.json:15` has no tsc step) — type-level facts are checked by `npx tsc --noEmit` (Acceptance #2).

**Existing tests: 0 rewritten, 0 removed.** The three assertions touching changed code are named, with the reason each survives:
- `test/extension.test.ts:83` "registers all 7 commands" — asserts command count/names; no command is added or removed.
- `test/extension.test.ts:360` "shows empty debug log" — asserts the exact string `"Loop debug (0 entries):\n"`; zero entries means no timestamp is rendered, so the ts fix (shift 1) cannot touch it.
- `test/extension.test.ts:370` "shows debug entries after loop start" — asserts `/Loop debug \(\d+ entries\)/`; regex over count, not timestamp text.

"0 flips" is therefore proven per-test, not asserted wholesale.

**New tests — `test/bug-spec.test.ts` (new file, 26 cases):**
- `slugBugName` (6): `"Frozen at Phase B Step 5"` → `"frozen-at-phase-b-step-5"`; `"already-slug"` unchanged; `"   "` → `""`; `"a--b"` → `"a-b"`; `"über"` → `"ber"` (non-`[a-z0-9]` runs → single dash, trimmed); leading/trailing punctuation trimmed.
- `extractLoopLogs` (12): one case per emitted type with its real payload shape (7) — including refusal-with-path vs refusal-without-path (`tool-call.ts:90` shape) and both dispute shapes (`tools.ts:348` filed, `tools.ts:362` concede); `data.ts` epoch → ISO, missing ts → `-` (2); exclusion: non-custom entry, unknown `customType`, and specifically a `loop-gate` entry (asserts the dead-type exclusion) (2); order preserved across interleaved types (1).
- `renderBugSpec` (5): section headings present in order; title contains the name verbatim; idle phase → `"no active loop"` Context line vs active-phase line; empty lines → `(no loop events found in this session)`; placeholder prompt strings present verbatim.
- `writeBugSpec` (3): writes into a real `fs.mkdtemp` dir → `{ok:true}` + file exists with exact content; pre-existing file → `{ok:false, reason:"exists"}` and file content byte-identical; non-existent cwd (`join(tmp, "no-such-dir")`) → returns `{ok:false, reason:"write-failed"}` without throwing (Phase 0 finding).

**New tests — `test/extension.test.ts` (added to the describe at line 351, 9 cases):** log-bug success (point `_mockCtx.cwd` at a fresh `mkdtemp`; assert the success notify string verbatim + file on disk + every section of the Behavior-pinned template: title, Resolve-with line, 5 H2 sections); `--log-bug=name` equals form ≡ space form; multi-word space-form name; empty name → usage notify, no file; collision → error notify, original file untouched; write failure (point `_mockCtx.cwd` at a non-existent path) → error notify matching the pinned prefix `Failed to write bug-fix-<slug>.md:` (the error message varies by environment, so assert the prefix); session with no loop entries → file contains the no-events line; idle state → `"no active loop"` Context; no-args still shows last 20 AND a seeded entry with `data.ts` renders its ISO timestamp (covers shift 1 end-to-end).

## Scope lines

| File | Removed | Kept | Added | Enforced by |
|---|---|---|---|---|
| `src/bug-spec.ts` | — | — (new) | 6 exports + 2 imports | tsc (exit 0) |
| `src/commands.ts` | 0 lines | imports 3–11, all other functions byte-identical | 1 import; rewritten `cmdDebug` (308–320); 1 replaced line (335) | tsc + diff inspection |
| `index.ts` | 0 lines | 77 of 78 lines | 1 replaced line (57) | diff inspection |
| `test/bug-spec.test.ts` | — | — (new) | ~26 cases + imports | vitest |
| `test/extension.test.ts` | 0 lines | all existing `it`s | 9 `it`s | vitest |
| `README.md` | 0 lines | everything outside line 45 + new paragraph | line 45 text: `| `/loop-debug` | Show last 20 debug entries; `--log-bug <name>` writes `bug-fix-<name>.md` |` | grep sweep (Acceptance #4) |
| `SPEC.md` | 0 lines outside 236–237 | everything outside the `/loop-debug` block | expanded block: flag form, file location, every section of the pinned Behavior template, collision/usage/write-failure behavior | grep sweep (Acceptance #4) |

## Acceptance Criteria

1. `npm test` → green, 32 files (31 + `test/bug-spec.test.ts`), 944 + 35 tests, 0 failures. Checker: `vitest run`.
2. `npx tsc --noEmit` → exit 0. Checker: tsc (vitest does not type-check — stated).
3. Functional sweep: `rg -n "cmdDebug" src/ index.ts` → exactly 2 matches (definition `src/commands.ts:308`, registration `index.ts:57`); `rg -n "writeBugSpec" src/ index.ts` → exactly 3 (definition in `src/bug-spec.ts`, import line + call site in `src/commands.ts`). Checker: ripgrep.
4. Textual sweep: `rg -c "log-bug" README.md SPEC.md` → ≥ 1 in each file (flag documented in both); `rg -n "log-bug" scripts/` → 0 matches (script untouched). Checker: ripgrep.
5. Dead-type sweep: `rg -n "loop-gate" src/bug-spec.ts` → 0 matches; `rg -n "loop-gate" src/commands.ts` → exactly 1 (legacy `validTypes` preserved, quirk 4); `rg -n "loop-event" src/bug-spec.ts` → 0 matches. Checker: ripgrep.
6. Every verbatim-pinned string (usage/collision/write-failure/success notifies, the 8 format lines, all markdown headings, both placeholder prompts) appears in at least one test assertion. Checker: vitest (the new tests).
7. Post-implementation agent check (manual): in a live session containing loop entries, `/loop-debug --log-bug test-name` produces `bug-fix-test-name.md` with every section of the Behavior-pinned template (title, Resolve-with line, 5 H2 sections); deleting the file and re-running regenerates it identical except the `Generated by … on <timestamp>` line. Checker: the agent, by reading the file.

## Dependencies

- **01–06 (events refactor): no dependency either way.** Those units targeted the `src/events.ts` monolith and its wiring; that file no longer exists (verified: `ls src/` shows `events/` dir, no `events.ts`; `src/commands.ts:5` imports `DebugFn` from `./events` = the directory index). This unit touches only `src/commands.ts:308–338`, `index.ts:57`, and docs — zero line overlap with any 01–06 target.
- **Stale backlog table (out of scope, logged):** `internal/README.md` still lists 01–06 as Ready/not-started while the repo shows the events modularization landed (wired at `index.ts:74–77`). `internal/06-remove-monolith.md` cites L72–75 for the same `pi.on(...)` block — a 2-line drift, approximately current. This spec does not fix the table.
- **`logging-spec.md` (not started):** its `loop-event` producer does not exist yet (`src/logging.ts` absent, verified). When it lands, that spec must extend `extractLoopLogs`'s filter (intended shift 3). No action in this unit.
- **`missing-test-coverage.md` ("commands.ts helpers untested"):** this unit adds `test/bug-spec.test.ts` + 8 command-level cases — partially addresses it, no conflict.

## Findings log

Findings #1–#4 are the first draft of this spec (same file, superseded); all verified against the repo in this rework.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | First draft filtered 7 `customType`s including `loop-event` and `loop-gate`; neither is emitted by any code (verified: `grep -rn 'appendEntry(' src/ index.ts` → 0 producers; `loop-gate` appears only at `src/commands.ts:325`; `loop-event` only in `internal/logging-spec.md` and `scripts/extract-session.sh:46`) | **Accepted.** Spec now pins the 5 emitted types with per-type producer citations (Problem table); the exclusion is asserted in tests (Acceptance #5) |
| 2 | needs-doc | First draft's `loop-dispute` format assumed the filed payload only; the concede producer (`src/tools.ts:362`) emits `{phase, round, action}` with no `disputeCount`/`claim` | **Accepted.** Three-branch dispute format pinned in Behavior |
| 3 | needs-doc | First draft assumed `cmdDebug` already receives `state`; it receives nothing (`index.ts:57`: `Cmd.cmdDebug()`) | **Accepted.** Signature change pinned in Interface + intended shift 2 + call-site inventory |
| 4 | needs-doc | First draft's refusal line mirrored the bash script, which prints `blocked write to ` + empty string when `path` is absent (`data.get('path', '')` in the script) — a dangling artifact for the `tool-call.ts:90` shape | **Accepted.** New formatter pins an explicit missing-`path` branch; the script gap is recorded as quirk 5, not mirrored |
| 5 | needs-doc | First draft (previous revision) cited `src/commands.ts` imports and the existence of `src/events.ts`; both are stale — the repo changed in between (baseline imports added, monolith deleted) | **Accepted.** Every line ref in this draft was re-verified after the change; the stale `internal/README.md` table is logged under Dependencies, not silently fixed |
| 6 | needs-doc | **Phase 0 feedback (this round):** the write-throw path was unspecified — a throwing `writeFileSync` (bad/unwritable cwd) would reject the handler with zero notify, breaking the one-notify invariant, and no decision-table branch covered it | **Accepted.** `writeBugSpec` pinned never-throwing (try/catch, `reason: "exists" \| "write-failed"`); decision-table row 4 added with the pinned error string; side-effect contract states the invariant explicitly; +1 unit test (non-existent cwd) |
| 7 | needs-doc | Author verification misses found in the patch pass after review (repo edited between draft and patch): mock envelope ref 652–668 → 672–697 (reviewer-flagged; 672–697 is the verified `api._mockEntries` literal range); `package.json:14` → `:15`; `index.ts` `pi.on` block 60–63 → 74–77; undefined "7 sections" phrasing; miscounted "7 format lines" (actually 8) | **Accepted.** All refs re-verified at patch time; phrasings replaced with pinned counts (8 format lines; 5 H2 sections + title + Resolve-with line) |
| 8 | needs-doc | **Phase 0 feedback (round 2, bookkeeping only, no design change):** (a) Acceptance #6 was unsatisfiable — it required the write-failure notify string in a test assertion, but no planned test exercised decision-table row 4 at the command level; (b) Acceptance #3's `writeBugSpec` rg count was 2, but the identifier lands on 3 lines (definition + import line + call site) — the checker would have failed the spec's own implementation | **Accepted.** +1 command-level test (bad `_mockCtx.cwd` → pinned `Failed to write bug-fix-<slug>.md:` prefix assertion; extension count 8 → 9, total 944 + 35); sweep count corrected to 3 with per-line breakdown |
