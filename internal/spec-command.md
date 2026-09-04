# implement-spec-command

## Problem

Verified current state as of writing (re-checked against the repo; baseline: `npx tsc --noEmit` clean, `npm test` green):

The loop is a *consumer* of specs: `/loop <spec-path>` requires a tight, human-authored spec file
(`src/commands.ts:130` `cmdLoop` → `R.readSpec` → `ctx.ui.notify("Spec file not found: ...")` on
missing file). Authoring that spec is manual: `docs/spec-authoring.md` ("Writing Specs for the
Loop") provides the template, the 12 failure classes (A–M), and a filling prompt, but nothing in
the extension produces a spec. The user's workflow is bimodal:

1. **Spec-writing sessions** — time to write feature requests into `internal/` (the backlog
   convention in `internal/README.md`: `NN-<slug>.md` active, `done-<name>.md` archived).
2. **Implementation sessions** — time only to kick off `/loop <spec>` and leave; the loop must
   be self-sufficient.

The constraint driving this unit: the user's local LLMs can afford one such action per session —
spec-writing *or* implementation, not a monolithic goal→code pipeline. So the two modes must be
two separate entry points that share the engine, with the spec file as the durable handoff
artifact. Today there is no command for mode 1: the user hand-writes the spec against the
template, in the same chat, without the repo-grounding discipline the template demands.

## Target

A new `/spec` command and an Author agent role. `/spec` runs one Author turn (no loop state, no
gates, no phases): the Author reads the goal, verifies claims against the repo, and writes a
tight spec file into the backlog. The command exits; the produced file is later fed to the
existing `/loop <spec>` unchanged. `/loop`, the phase machine, `LoopState`, and all existing
prompts are untouched.

After: `/spec --slug foo --out internal/ <goal>` produces `internal/foo.md` shaped to the
`docs/spec-authoring.md` template, with the goal embedded, a verification-stamp header, a
pre-seeded `## Findings log`, and a footer pointing at `/loop internal/foo.md`.

## Interface

New module `src/spec-command.ts` (mirrors `src/bug-spec.ts`: pure functions + one I/O function):

- `slugSpecName(name: string): string` — delegates to `slugBugName` (`src/bug-spec.ts:12`);
  exported for testability. Same pinned cases as `slugBugName`: `"   "` → `""`,
  `"Fix the Gate Runner"` → `"fix-the-gate-runner"`.
- `resolveGoal(goalArg: string, cwd: string): string | null` — if `goalArg` starts with `@`
  (strip one leading `@`) or is an existing path (absolute as-is; relative resolved against
  `cwd`, then process cwd — same resolution order as `readSpec`, `src/reviewer.ts:28`), read the
  file and return its text. Otherwise return `goalArg` verbatim. Returns `null` when a file
  was referenced but not found.
- `readRubric(cwd: string): string | null` — `readSpec("docs/spec-authoring.md", cwd)`
  (`src/reviewer.ts:28`); `null` when the file is missing.
- `renderAuthorPrompt(input: AuthorPromptInput): string` — pure. `AuthorPromptInput` fields:
  `goal: string`, `slug: string`, `outDir: string` (relative, display form), `rubric: string | null`,
  `now: Date`. Returns the full Author prompt (Behavior → verbatim pins).
- `cmdSpec(state: { current: LoopState }, pi: ExtensionAPI, debug: (msg: string) => void)` —
  returns `{ description: string; handler: (args: string, ctx: CommandContext) => Promise<void> }`
  with the same `CommandContext` shape as the existing commands (`src/commands.ts:20`:
  `ui.notify`, `ui.setStatus`, `sessionManager.getEntries`, `cwd`).
- `index.ts` — one registration line: `pi.registerCommand("spec", Cmd.cmdSpec(state, pi, debug));`
  next to the existing registrations (`index.ts:36`–`index.ts:42`).

Argument parsing (in `cmdSpec`, whitespace-split, mirroring the `parseLoopArgs` style in
`src/selectors.ts:56`; no new shared parser):

- `--slug <name>` / `--slug=<name>` — optional. Defaults to the slug of the goal's first
  non-flag token.
- `--out <dir>` / `--out=<dir>` — optional. Defaults to `internal/`.
- Remaining non-flag tokens joined with `" "` = the goal. A goal starting with `@` or an
  existing path is read as a file (see `resolveGoal`).

`LoopState` is passed but only read (`state.current.phase` for the stamp); `/spec` never
mutates it and never calls `pi.appendEntry`.

## Behavior

`cmdSpec` handler decision table (first-match-wins; `notify` is the pinned UI sink):

| # | Case | Behavior |
|---|------|----------|
| 1 | No goal tokens (empty args or flags only) | `notify(usage, "warning")`, return. Usage text verbatim: `Usage: /spec [--slug <name>] [--out <dir>] <goal...>` |
| 2 | `--slug` name slugifies to `""` (e.g. `--slug "!!!"`) | `notify("Usage: /spec [--slug <name>] [--out <dir>] <goal...>", "warning")`, return |
| 3 | Goal references a file (`@`-prefixed or path) that does not exist | `notify("Goal file not found: <arg>", "error")`, return |
| 4 | `docs/spec-authoring.md` missing | Author runs WITHOUT the rubric: prompt uses the fallback block (Behavior → verbatim pins); `notify("docs/spec-authoring.md not found — Author runs without the template.", "warning")` BEFORE the turn; handler still proceeds |
| 5 | Happy path | `debug("spec: author turn for slug <slug>")`; `pi.sendUserMessage(renderAuthorPrompt(...), { triggerTurn: true })`; `notify("Author: writing <outDir>/<slug>.md. Review it, then run /loop <outDir>/<slug>.md", "info")`; `ui.setStatus("loop", "spec author (one-shot — no loop state)")`; return |

Row 4 ordering: the warning fires before `sendUserMessage`. Rows 1–3 fire exactly one notify
and no `sendUserMessage`.

`renderAuthorPrompt` output (the full prompt, verbatim-pinned):

```
You are the AUTHOR. Write one tight, /loop-ready spec file for the goal below.

Goal:
---
${goal}
---

Output file: ${outDir}/${slug}.md   (create parent directories if needed)

${rubricSection}

Rules — each closes an observed spec failure class; violating one costs a review round later:
1. VERIFY, don't remember. Before writing, check every file, line, function, and caller
   claim against the repo NOW; re-verify after drafting. Mark line references "as of
   writing". (class A)
2. PIN VERBATIM. Every user-visible string and every order-sensitive branch goes in the
   spec exactly as written in code. (classes B, F)
3. CLOSE EVERY LIST. Count items, name the last, or state the grep that proves
   completeness — including dead code. (class C)
4. OWN EVERY BEHAVIOR. Name the module that performs each behavior and the test file
   that asserts it. (classes D, E)
5. PLAN THE TESTS. Per-test dispositions (kept / rewritten old→new / removed + why) and
   one new test per newly pinned behavior. (class D)
6. UNIT SIZING. One verb, one object, one unit. If the goal is bigger, the spec is the
   first unit plus a "Backlog" section listing the remaining units in dependency order —
   do not merge units into one spec.
7. PRESERVE QUIRKS. Odd-but-current behavior goes in the quirks list marked "current
   behavior, do not fix". (class G)
8. TYPE FACTS. Pin signatures, non-exported types, union exhaustiveness; if persisted
   state is touched, name the saved shape, restore path, and compatibility strategy.
   (classes J, L)
9. LIVE-TOOLCHAIN TESTS. Any test that spawns a real tool must state fixture
   buildability, tool-absence skip, sized timeout, and verdict field — and dry-run the
   fixture's commands before submitting. (class M)

Write the file with exactly this shape (omit sections the template marks optional for
this unit; keep the Findings log even when empty):

${templateOutline}

Self-check before finishing: every factual claim has a line number or a named observed
artifact; every list is closed; every user-visible string is verbatim; every acceptance
criterion names a checker that can see it.

When the file is written, stop producing tool calls. Do not write any other file.
```

`${rubricSection}`: when the rubric is present —
`The template, failure classes, and filling rules live in docs/spec-authoring.md — read it first and follow it.`
When absent (case 4) —
`No template file is available in this repo. Follow the rules below and the standard spec
sections: Problem, Target, Interface, Behavior, Inventory, Test Strategy, Scope lines,
Acceptance Criteria, Dependencies, Findings log.`

`${templateOutline}` (always present, the closed list of required sections):

```
# <slug>
## Problem
## Target
## Interface
## Behavior
## Inventory
## Test Strategy
## Scope lines
## Acceptance Criteria
## Dependencies
## Findings log
```

Prompt-header stamp: the first line of the *file* is instructed to be `# <slug>`; the Author
also appends, as the second line, a generation stamp — pinned rule in the prompt:
`> Generated by /spec on ${now.toISOString()} — goal: <first 120 chars of the goal, newlines
collapsed to spaces>`. (The Author writes this; the extension never writes the file itself.)

`cmdSpec` reads `state.current.phase` only for `debug` output:
`debug("spec: author turn for slug " + slug + " (loop phase: " + state.current.phase + ")")`.

## Inventory

- Files:
  - `src/spec-command.ts` — added (new module; the five functions + `AuthorPromptInput` interface above)
  - `src/commands.ts` — untouched (no exports from it are needed; `CommandContext` is a local interface — `cmdSpec` re-declares the same structural shape in `src/spec-command.ts`)
  - `src/selectors.ts` — untouched (`parseLoopArgs` is not reused: its flag set and positional semantics differ)
  - `src/bug-spec.ts` — untouched (imported, not modified)
  - `src/reviewer.ts` — untouched (imported: `readSpec`)
  - `index.ts` — one line added (registration)
  - `test/spec-command.test.ts` — added (new regression file; no existing file covers this module)
  - `test/extension.test.ts` — one describe block added (`/spec command`), mirroring the `/loop-debug` block's `buildTestAPI`/`findCommand` pattern
  - `README.md` — one line in the command table + a short "Two workflows, one engine" paragraph
  - `docs/spec-authoring.md` — one sentence added to the intro: the document is also the Author agent's contract (the `/spec` command feeds it to the Author)
  - `SPEC.md` — one paragraph added after the Phase 0 section: the loop is a spec consumer; `/spec` is a separate one-shot producer that writes to the backlog; it is not a loop phase and does not touch `LoopState`
- Imports: `src/spec-command.ts` adds `import { slugBugName } from "./bug-spec"`, `import { readSpec } from "./reviewer"`, `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`, `import type { LoopState } from "./types"`. No other file gains an import except `index.ts` (none — `Cmd` is already imported as a namespace; `cmdSpec` is referenced through it).
- Call sites: `index.ts` registers `Cmd.cmdSpec`; no existing call site changes.
- Exports: `src/spec-command.ts` exports `slugSpecName`, `resolveGoal`, `readRubric`, `renderAuthorPrompt`, `AuthorPromptInput`, `cmdSpec`. Nothing re-exported from `index.ts`.

## Test Strategy

- Baseline: `npm test` green as of writing (see Problem). All existing tests kept unchanged;
  the mechanism: `cmdSpec` is additive (new file + one registration line), so no existing
  assertion flips.
- New tests, `test/spec-command.test.ts` (pure-function level; no process spawning, no
  `npx`, no temp-dir project scaffolding):
  - `slugSpecName` — delegates to `slugBugName`; pin `"   "` → `""`, `"Fix the Gate Runner"`
    → `"fix-the-gate-runner"`, `"a--b__c"` → `"a-b-c"`.
  - `resolveGoal` — goal string returned verbatim; `@file` form reads (mock
    `node:fs` via `vi.mock`, per the repo's ESM-mock rule — `vi.spyOn` on node builtins
    does not work); relative path resolves against `cwd` first, then process cwd; missing
    file → `null`.
  - `readRubric` — returns file text when present, `null` when absent (mocked fs).
  - `renderAuthorPrompt` — output contains, in order: the role line `You are the AUTHOR.`,
    the goal between `---` fences, the output-file line `Output file: internal/foo.md`,
    all nine numbered rules, the closed template outline (all ten `##` headings), the
    `> Generated by /spec on <iso>` stamp instruction, and `stop producing tool calls`.
    Rubric-present and rubric-null variants pin the two `${rubricSection}` texts. Goal
    truncation: a 200-char goal appears in the stamp at 120 chars with newlines collapsed.
- New tests, `test/extension.test.ts` (`/spec command` describe block; command level, mocked
  `pi` — the existing `buildTestAPI` pattern; no toolchain):
  - No goal → usage warning, `sendUserMessage` not called.
  - `--slug "!!!"` → usage warning, no turn.
  - Missing goal file (`@nope.md`) → `notify("Goal file not found: @nope.md", "error")`,
    no turn.
  - Happy path → `sendUserMessage` called once with a string containing `You are the
    AUTHOR.`; `notify` called once with `Author: writing internal/foo.md. Review it, then
    run /loop internal/foo.md`; `ui.setStatus` called with key `"loop"`; `pi.appendEntry`
    NOT called; `state.current.phase` unchanged (still `"idle"`).
  - `--out` flag respected in the notify text and the prompt's `Output file:` line.
  - Rubric-missing case: mock cwd without `docs/spec-authoring.md` → warning notify fires
    (order: before the turn) and the prompt contains the fallback block.
- Untouched: `test/bug-spec.test.ts`, `test/reviewer.test.ts`, all event/transition/gate
  tests — no shared code path is modified.

## Scope lines

- `src/spec-command.ts` — added; final shape: imports, `AuthorPromptInput`, `slugSpecName`,
  `resolveGoal`, `readRubric`, `renderAuthorPrompt`, `cmdSpec`. No other exports.
- `index.ts` — kept; one line added in the Commands block.
- `README.md` — kept; command table gains `| /spec [options] <goal> | One-shot Author: writes a /loop-ready spec into the backlog (no loop state) |`; new short paragraph.
- `docs/spec-authoring.md` — kept; one sentence in the intro.
- `SPEC.md` — kept; one paragraph after Phase 0.

## Acceptance Criteria

- `npx tsc --noEmit` clean (the test run does not type-check).
- `npm test` green, including the new `test/spec-command.test.ts` and the new
  `/spec command` block in `test/extension.test.ts`; suite stays in the seconds-to-~20s
  range (no new process spawns).
- Grep sweep (functional): `rg "cmdSpec" src index.ts` → exactly the definition, the
  registration, and the test imports.
- Grep sweep (textual): `rg "/spec " README.md SPEC.md` → the new doc lines only; no
  existing `/loop` doc line mentions `/spec` beyond the new paragraph.
- No `appendEntry` call in `src/spec-command.ts` (grep: `rg "appendEntry" src/spec-command.ts`
  → no matches) — `/spec` is stateless by contract.
- One criterion per pinned item above: usage text, notify texts, prompt pins, and the
  decision-table rows each have a named test (Test Strategy).

## Dependencies

- `src/bug-spec.ts` (`slugBugName`) — implemented, `done-` archived provenance in
  `internal/log-bug-spec.md`.
- `src/reviewer.ts` (`readSpec`) — implemented (`done-phase-0-spec-review.md`).
- `docs/spec-authoring.md` — exists; this unit adds one sentence to it, nothing more.
- The `internal/` backlog convention (`internal/README.md`) — exists; the default `--out`
  targets it.

## Findings log

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| - | - | (empty after a clean Phase 0) | - |
