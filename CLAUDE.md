# CLAUDE.md (caveman)

pi-tdd-loop = public extension. 3 agents (Tester/Writer/Cleaner). Gated phases. Go/Java/TS.

I build it. I use it daily. Danger: my habits become "the product" by accident. This file = guard against that.

## ASK BEFORE EVERY CHANGE

Better for ANY user? Or just easier for me right now?

Only-my-setup change = scope creep. Not extension's job. Ask out loud, before code, not after.

## SMELL LIST - stop if you see:

- Hardcoded path/name/value = only works on my machine
- New flag/command born from ONE spec file, no other real use case
- Language logic that's really "how I structure my projects," not Go/Java/TS as ecosystems
- "While I'm in here" extra stuff, unrelated to the actual change
- Config that should live in dotfile/env var, not baked into repo
- Skipped general case because narrow case = faster ship. Flag it, don't hide it.
- A test that spawns a real toolchain (`go build`, `mvn`, `npx vitest`, `tsc`, any `execFile`/`execSync`/`spawn`) in the default suite. Unit tests mock the process boundary; real toolchain runs live in test/e2e/ only.

## IN-SCOPE CHECK

1. Fits shape? Phase 0 to Tester to Negotiate to Writer to Cleaner, gated. If not, say so, don't bend shape quietly.
2. Makes sense to stranger who only read README + SPEC.md?
3. About the language/toolchain itself (go test, Maven, vitest)? Not about my personal project layout?
4. Truly personal? Dotfile, local config, private script. NOT this repo.

## WHEN SCOPE CREEP SMELLS

Don't refuse silent. Don't build silent. Say:

"This solves your setup, not the extension. General option, keep local, or is there a bigger case?"

Then I decide. Point = choice on purpose, not by default.

## RULES

- SPEC.md / README.md = source of truth for what this IS. Change without doc update = drift signal.
- Spec conventions for /loop live in docs/spec-authoring.md (failure classes + template). New failure class seen in a review = doc update, same as a SPEC.md change.
- Every flag/command = API someone else must learn. Fewer, general beats many, narrow.
- Works-on-my-spec-files does not equal works. Test with non-me examples.
- When unsure: smaller, more general, more removable. Easy to grow later, hard to walk back.

## TEST SPEED RULE (Tester prompt + all test authors)

The default `vitest run` must stay in the seconds-to-~20s range (~1,000 tests in 20s is the reference).

- Unit tests NEVER spawn real processes. If the code under test calls `execFile`/`execSync`/`spawn`, the test mocks that boundary (`vi.mock("node:child_process")` — note: `vi.spyOn` on ESM node builtins does not work) and asserts on the interpretation of exit codes / output, not on the toolchain actually running.
- `vi.mock` + `mockReset()` wipes return values (unlike `mockClear()`). After a `mockReset()`, re-set `mockReturnValue`/`mockResolvedValue` before the next call — or use `mockClear()` if you only want to clear call history. (Observed: session 01a0bba2, Q2 pair-invariant test — `runGates` returned `undefined` after `mockReset()`, crashing the pipeline under test.)
- No `npx` in unit tests: npx resolves/downloads packages into bare temp dirs = tens of seconds per call.
- No temp-dir project scaffolding (`mkdtemp` + `go.mod`/`package.json` + real run) outside test/e2e/.
- Real end-to-end toolchain verification lives in test/e2e/ (quality.test.ts) and runs explicitly, not in the default loop.
- Debug/investigation test files (names like `hang*`, `*-tmp`, `gsi-*`) are deleted when the investigation closes — they duplicate the permanent regression file and double the spawn cost.
- One regression file per bug spec. If a new file repeats tests from an existing file, merge, don't duplicate.

## DEBUGGING SESSIONS

When diagnosing a live loop session (stall, wrong transition, gate failure):

1. **Use `scripts/extract-session.sh`** — it extracts the full event flow (state transitions, debug logs, negotiate, disputes, refusals, messages, tool calls) sorted by timestamp. Designed for LLM agent consumption, not human reading.
   ```bash
   ./scripts/extract-session.sh <session-id-prefix>   # e.g. 01a0a668
   ./scripts/extract-session.sh                        # most recent session
   ./scripts/extract-session.sh /path/to/session.jsonl # explicit file
   ```
2. **Key patterns to grep in the output:**
   - `[STATE]` — phase/round/turns/dispute transitions (the spine of the loop)
   - `[DEBUG]` — event trace (gate results, transitions, dispute lifecycle)
   - `[NEGOTIATE]` / `[DISPUTE]` — negotiation and dispute events
   - `[MSG]` / `[TOOLCALL]` / `[TOOL]` — what the LLM said and did
   - `[COMPACTION]` — context compaction boundaries
3. **Session files live in:** `~/.pi/agent/sessions/--Users-alancapps-.pi-agent-extensions-loop-go-bak--/`
4. **Do NOT parse raw JSONL directly** — use the script. It normalizes timestamps, truncates long content, and separates event types.