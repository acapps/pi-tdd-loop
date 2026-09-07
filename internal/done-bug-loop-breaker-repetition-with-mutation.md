# bug-loop-breaker-repetition-with-mutation

## Problem

Verified current state as of writing (code re-checked against the repo at `b9bd8db` after `bug-confirm-approval` merged; baseline: `npx tsc --noEmit` clean, `npx vitest run` → 37 files, 1128 passed / 12 skipped, ~15s):

**The repeated-tool-call breaker shipped in `bug-confirm-approval` only catches byte-identical calls. An agent that mutates a single argument per retry evades it entirely, and in the run that motivated the breaker it did exactly that.**

1. **The key is byte-exact over the whole input object.** `src/events/tool-call/index.ts` (`canonicalCallKey`, lines 41-52): key = `toolName + JSON.stringify(canonicalize(event.input))` where `canonicalize` recursively sorts keys. Key-order noise is normalized; *any* value change is not. `grep -rn foo src/` and `grep -rn foo src/ --include=*.ts` are distinct keys with independent counters.
2. **Observed evasion (runtime evidence: session `01a077b8-6c6c-702a-879e-2479ea23eba3`, the implementation run of `bug-confirm-approval` itself, Phase C, ~100 iterations):** the Writer agent ping-ponged between `grep` and `cat` with *slightly mutated* arguments — and, while probing a test failure, created `test/dbg.test.ts` ~50 times via the `write` tool with the path held constant and only the file *content* mutated (a new probe each time). Every call was a fresh key → every counter stayed at 1 → the 5-call limit was never reached → no block, no notice, no turn termination. The turn ran to ~100 tool calls and ~1 hour of wall-clock until the user intervened.
3. **The spec that shipped the breaker anticipated this and closed it as out-of-scope.** `internal/done-bug-negotiate-confirm-approval-loop.md` (Behavior §4) pins the key as "the complete input object, recursively key-sorted" and names the whole-input-object key as a *deliberate* choice — its justification is only that narrowing to `path` would merge distinct writes to the same file. It never considered the reverse direction: the whole-object key is what makes *mutation* the cheapest evasion, because the agent needs exactly one byte of difference per call to reset the counter, and a probe loop (write → run → read output → adjust) is precisely a mutation loop.
4. **The test suite pins the evasion surface as the contract.** `test/events/tool-call-breaker.test.ts` (lines 6-15) states the pinned contract in its header: "distinct counters for two writes to the same path with different content" — the test at line 139 ("two writes to the same path with different content → distinct counters (whole-input-object key)") is a first-class acceptance test of the prior spec (its Breaker pin). Fixing this bug *flips that test*: it is not an addition, it is a rewrite. The prior spec's "intended behavior" is this bug's "current behavior" — the class-G drift the template warns about, one spec later.
5. **The user-visible notice is false in the very situation it exists for.** The verbatim notice (`src/events/tool-call/index.ts:30-31`) says "the agent repeated the same tool call 5x" and tells the user to ESC + `/loop-continue`. Under mutation evasion the breaker never fires, so the user gets no signal at all while the loop burns the turn — the failure is silent, not noisy.

**Why this is a loop bug, not a model quirk:** the breaker is the loop's only in-turn protection — `turnsThisPhase` advances only on settle, so a single hung turn is invisible to loop detection (the prior spec's own finding 3, which the breaker was written to close). A protection with a one-byte escape hatch provides no protection against the agent it is protecting against: agents know their own tool schemas and can always vary an argument.

## Target

After this fix: the breaker keys on the *skeleton* of a call — tool name plus the identity fields of its input (which file, which pattern, which command's program and flags) — with opaque payloads (file contents, heredoc bodies) excluded from the key. A retry loop that mutates only the payload of the same logical call (re-`write` of the same path with new content, re-`bash` of the same command with a new heredoc, re-`grep` of the same pattern with a new `limit`) counts into one counter and is blocked at the 5th call, with the same block/terminate/notice contract as today. A loop that genuinely changes the *logical* call (different path, different pattern, different program) still gets a fresh counter. The existing byte-exact key is kept as a fallback for tools whose input shape the skeleton map does not cover (custom tools).

## Interface

No new state fields, no new commands, no new tools. Changes inside the existing module `src/events/tool-call/index.ts`:

- New exported function `commandSkeleton(command: string): string` — the bash skeletonizer (Behavior §2). Exported for direct unit testing, mirroring the `canonicalCallKey` precedent.
- New exported constant `SKELETON_FIELDS: Record<string, readonly string[]>` — the per-tool field map (Behavior §1). Exported so the sweep test and unit tests can assert the map's shape.
- `canonicalCallKey(toolName: string, input: unknown): string` — **signature unchanged**; its *algorithm* changes: it now builds the key from the skeleton (tool name + selected fields, each normalized per Behavior §2) instead of the whole canonicalized input object. Return type stays `string`.
- `REPEATED_CALL_LIMIT = 5` — unchanged.
- `ToolCallEventResult` contract — unchanged: the installed SDK's `tool_call` handler result is `{ block?: boolean; reason?: string; terminate?: boolean }` (verified against `@earendil-works/pi-coding-agent` v0.85.0, `dist/core/extensions/types.d.ts`, `ToolCallEventResult`). There is no `pi.interrupt()` on `ExtensionAPI` (verified; the only interrupt surface is the TUI keybinding `app.interrupt`) — that verification from the prior spec remains valid and is re-confirmed here.
- `ToolCallEvent` input shapes (verified against the installed SDK's tool schemas, `dist/core/tools/*.d.ts`): `bash { command: string; timeout?: number }`; `read { path: string; offset?: number; limit?: number }`; `write { path: string; content: string }`; `edit { path: string; edits: { oldText: string; newText: string }[] }`; `grep { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }`; `find { pattern: string; path?: string; limit?: number }`; `ls { path?: string; limit?: number }`; custom tools: `Record<string, unknown>`. The skeleton map (Behavior §1) is written against exactly these shapes.

**Persisted state:** none touched. The counter map is per-turn in-memory; nothing is appended, saved, or restored by this change.

## Behavior

### 1. Skeleton field map (src/events/tool-call/index.ts)

`SKELETON_FIELDS` selects, per tool name, the input fields that identify the *logical* call. Fields not in the map are excluded from the key (the payload). Evaluation is first-match-wins on tool name:

| Tool | Skeleton fields | Excluded (payload) | Rationale |
|---|---|---|---|
| `bash` | `command` (skeletonized, §2) | `timeout` | timeout wobble is retry noise, not a different call |
| `read` | `path` | `offset`, `limit` | re-reading the same file at a different window is the same logical call — the observed grep/cat ping-pong shape |
| `write` | `path` | `content` | the ~50x `test/dbg.test.ts` probe loop: same path, mutated content, one counter |
| `edit` | `path` | `edits` | same rationale as write |
| `grep` | `pattern`, `path`, `glob` | `ignoreCase`, `literal`, `context`, `limit` | a different pattern is a different search; `limit` wobble is retry noise |
| `find` | `pattern`, `path` | `limit` | same as grep |
| `ls` | `path` | `limit` | |
| (any other / custom tool) | **fallback: all fields, whole canonicalized input object** (today's algorithm) | — | unknown shapes get the conservative byte-exact key; no skeleton to guess |

The fallback row is the compatibility pin: a custom tool registered by another extension is keyed exactly as it is today, so this change cannot alter another extension's breaker behavior.

### 2. Bash command skeleton (src/events/tool-call/index.ts)

`commandSkeleton(command: string): string`:

1. Strip heredoc bodies: remove every line from a line that *starts* (after leading whitespace) with `<<` or `<<-` through its terminating delimiter line (delimiter = the word after `<<`, quoted or bare). The heredoc marker line itself is kept, with the delimiter word — `cat <<'EOF'` stays, the body between it and `EOF` goes.
2. Collapse whitespace: every run of spaces/tabs/newlines becomes a single space; trim.
3. That is the skeleton. No tokenization beyond whitespace: `grep -rn foo src/` and `grep -rn foo src/` (trailing space) skeletonize identically; `grep -rn foo src/` and `grep -rn foo src` are distinct (different logical calls — different search root).

Verbatim pins (unit-test rows):

- `commandSkeleton("cat <<'EOF'\nprobe v1\nEOF")` → `"cat <<'EOF'"`
- `commandSkeleton("cat <<'EOF'\nprobe v2\nEOF")` → `"cat <<'EOF'"` (same skeleton, different body)
- `commandSkeleton("grep -rn foo src/ ")` → `"grep -rn foo src/"`
- `commandSkeleton("npx vitest run test/a.test.ts")` → `"npx vitest run test/a.test.ts"` (unchanged — no heredoc)

Rationale pin: the skeletonizer deliberately does *not* parse the shell. Quoted strings containing newlines, `$(...)` subshells, and backticks are treated as opaque text subject to whitespace collapse only — a full shell parse is out of scope (it would be a new module, not a one-function fix), and the observed evasion shape (heredoc body, whitespace, payload argument) is covered without it. A command that differs only inside a `$(...)` substitution is a distinct key — accepted limitation, pinned here.

### 3. Key construction (src/events/tool-call/index.ts)

`canonicalCallKey` builds: `toolName + ":" + JSON.stringify(selected, sortedKeys)` where `selected` is the object of the map's fields present in `input` (absent optional fields are simply absent — `{path}` and `{path, limit}` for `grep` are the *same* key because `limit` is not a selected field; and `{pattern, path}` with `path` undefined serializes as `{"pattern":...}` after dropping undefined — pinned: selected fields with `undefined` values are dropped from `selected` before stringify). For the fallback (custom) tools, `selected` is the whole canonicalized input object — today's algorithm, byte-for-byte.

The `canonicalize` helper (recursive key sort) is kept and applied to `selected` as before.

### 4. Breaker contract (unchanged, re-pinned)

Everything downstream of the key is untouched: per-turn `Map<string, number>` counter; cleared on `turn_start` and `agent_settled` (the prior spec's pinned reset set, both verified on the installed SDK's `ExtensionAPI.on` overloads); at the 5th call for a key, return `{ block: true, terminate: true, reason }` with the verbatim notice, append the `loop-debug` entry `Loop breaker: ${count}x ${toolName} with identical args — blocking call`, and send the user message. **One notice-text change (pinned):** the verbatim notice becomes:

> `Loop breaker: the agent repeated the same tool call 5x. The call was blocked; if the repetition continues, interrupt the turn (ESC) and run /loop-continue.`

— *unchanged*. (The debug entry's "identical args" wording is now slightly loose — the args differ in payload — but the debug entry is machine-internal; the user notice stays verbatim to avoid re-pinning every test that asserts it. Pinned: no notice change.)

### 5. Quirks list

- **`edit` keyed on `path` only means a genuine multi-edit session on one file (5 distinct logical edits) is blocked at the 5th.** Current behavior after this fix; accepted — the loop's phases rarely need 5 edits to one file in one turn, and the block is recoverable (ESC + `/loop-continue`). Pinned, not worked around.
- **The `read` tool's `offset`/`limit` exclusion means paging through one large file (5 windows) is blocked at the 5th window.** Same acceptance as above.
- **Two `bash` calls whose commands differ only in whitespace are now the same counter** (today they are distinct keys). Intended shift, not a quirk — this is the fix's purpose for the whitespace-mutation shape.

### 6. Intended shifts

- The prior spec's "two writes to the same path with different content → distinct counters" behavior (its Breaker pin, `test/events/tool-call-breaker.test.ts:139`) is **inverted**: same path, different content → same counter. This is the intended shift; the old test is rewritten, not deleted (Behavior §1, `write` row).
- Any future custom tool gets today's byte-exact key via the fallback row — no shift.

## Inventory

- Files: `src/events/tool-call/index.ts` (skeleton map + `commandSkeleton` + `canonicalCallKey` rewrite — the only source file touched); `test/events/tool-call-breaker.test.ts` (rewrites + additions, Test Strategy); `index.ts` (untouched — the registration and reset wiring are unchanged); `src/events/tool-call.ts` (path enforcement — untouched, per the prior spec's do-not-consolidate pin).
- Imports: `src/events/tool-call/index.ts` gains none (still imports `ExtensionAPI`, `ToolCallEvent`, `ToolCallEventResult` types from `@earendil-works/pi-coding-agent`).
- Exports added: `commandSkeleton` (string → string), `SKELETON_FIELDS` (Record, for test assertion). `canonicalCallKey`, `createRepeatedToolCallHandler`, `resetCallCounters`, `REPEATED_CALL_LIMIT` stay exported with unchanged signatures.
- Call sites of `canonicalCallKey`: exactly one production call site (`bumpCounter` in the same file) plus the test file. No other module imports it (verified: `rg 'canonicalCallKey' src/ index.ts` → only `src/events/tool-call/index.ts`).

## Test Strategy

- Baseline: 1128 passed / 12 skipped (37 files), verified at `b9bd8db`.
- Per-test disposition in `test/events/tool-call-breaker.test.ts`:
  - "is toolName + JSON of the whole input object" (canonical key shape) — **rewritten**: asserts the skeleton key shape (`write:{"path":"a.ts"}` for a write input; the exact serialized form is pinned in the test, not paraphrased).
  - "key order is irrelevant (recursively sorted)" — kept, rewritten inputs (key-order of the *selected* fields).
  - "nested objects are sorted too" — **removed**: no nested objects are selected for any built-in tool; the fallback (custom tools) keeps `canonicalize`, which is covered by the fallback tests below.
  - "different tool names never collide" — kept.
  - "undefined input serializes stably" — kept (fallback path).
  - "two writes to the same path with different content → distinct counters" (line 139) — **rewritten, flipped**: same path, different content → **same counter**; the 5th write (with 4 prior mutated-content writes) blocks. This is the regression test for the observed `test/dbg.test.ts` probe loop.
  - all breaker-contract tests (4→not blocked, 5→block+notice+debug, 6→sticky, reset, batch-caveat) — kept unchanged; they exercise the counter, not the key.
- New tests:
  - `commandSkeleton`: the 4 verbatim rows in Behavior §2, plus a heredoc with a bare (unquoted) delimiter, a command with no heredoc, and a multi-line command with mixed tabs/spaces (whitespace collapse).
  - `SKELETON_FIELDS` shape: the 7 built-in rows exist with exactly the pinned field lists; an unknown tool name is not in the map (fallback applies).
  - Evasion regression (the bug): 5 `bash` calls with the same command but a different heredoc body each → 5th blocked; 5 `read` calls on the same path with different `offset` → 5th blocked; 5 `grep` calls with the same `pattern`/`path` and different `limit` → 5th blocked.
  - Distinct-logical-call regression: 5 `grep` calls with 5 different `pattern` values → nothing blocked; 5 `write` calls to 5 different `path` values → nothing blocked.
  - Fallback: 5 calls to a custom tool name (e.g. `negotiate_propose`) with byte-identical input → 5th blocked (byte-exact key preserved for unknown shapes); 5 calls with one field mutated → nothing blocked (fallback is still byte-exact — pinned, so the fallback's conservatism is a test, not an assumption).
  - Undefined-selected-field drop: `grep` with `{ pattern, path }` where `path` is explicitly `undefined` → same key as `{ pattern }` alone.
- Untouched: `test/events/registration-surface.test.ts` (the `ENTRY_SHA256` pin covers `index.ts` only, which this spec does not modify — verified: the hash is over `index.ts` content; no re-baseline needed). All other test files stay green by construction: the counter contract, the reset wiring, and the registration surface are unchanged, and no other test imports `canonicalCallKey` (grep-verified above).
- Live-toolchain rules: N/A — all tests use `createMockExtensionAPI`, no real process spawns (CLAUDE.md TEST SPEED RULE).

## Scope lines

- `src/events/tool-call/index.ts`: added `SKELETON_FIELDS` + `commandSkeleton`; rewritten `canonicalCallKey` (algorithm, not signature); `canonicalize` kept; everything else in the file kept (counter, reset, handler factory, block path, notice text).
- `test/events/tool-call-breaker.test.ts`: 2 rewrites (key shape, flipped same-path test), 1 removal (nested-sort test, with the fallback test as its replacement coverage), ~10 additions.
- `index.ts`: untouched.
- `src/events/tool-call.ts`: untouched.

## Acceptance Criteria

- Full test run green: `npx vitest run` — 37 files, the baseline 1128 plus the new tests, minus the 1 removal; `npx tsc --noEmit` clean (vitest does not type-check).
- Grep sweep (functional): `rg 'SKELETON_FIELDS|commandSkeleton' src/` → hits only in `src/events/tool-call/index.ts`; `rg 'canonicalCallKey' src/ index.ts` → only `src/events/tool-call/index.ts` (no new production call sites).
- Grep sweep (textual): `rg "repeated the same tool call 5x" src/` → exactly 1 hit (the notice, unchanged — pin that the fix did not touch the user string).
- Regression pin (the bug): the "5 `bash` calls, same command, mutated heredoc body each → 5th blocked" test fails against the pre-fix code (pre-fix: 5 distinct keys, nothing blocked) — the Tester verifies this by checking out the pre-fix `canonicalCallKey` or by asserting the pre-fix key is distinct per body.
- Fallback pin: the custom-tool byte-exact tests pass, proving the prior spec's contract survives for unknown shapes.

## Dependencies

- `internal/done-bug-negotiate-confirm-approval-loop.md` (implemented, merged at `b9bd8db`) — this spec rewrites the key function *that* spec pinned; it must land after, and its Breaker pin test is the one flipped test. No other hard dependencies.
- Soft: none. The counter contract, reset set, and registration wiring are inherited unchanged.

## Findings log

(empty — clean Phase 0 expected; one row per finding otherwise)
