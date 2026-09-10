# fix-print-mode-session-replacement

## Problem

The loop extension crashes in `pi --print` / `pi --continue --print` mode with:
"Do not use a captured pi or command ctx after session replacement."

Root cause: `sendUserMessage` with `deliverAs: "followUp"` triggers a session
replacement in `--print` mode. The extension's captured `pi` object becomes
stale. Additionally, `--print` mode exits on `agent_end` without processing
the queued followUp message.

## Fix

1. **`src/prompt.ts`** — new `sendPrompt()` function that adapts to the
   execution mode:
   - **Runner mode** (`PI_LOOP_RUNNER=1`): writes the prompt to the status
     file (`.pi/loop-status`) with `status: "continue"`. The external runner
     (`bin/run-loop.sh`) reads this and starts a new `pi --continue --print`
     process with the stored prompt.
   - **Normal mode**: calls `pi.sendUserMessage(prompt, { deliverAs: "followUp" })`
     as before.

2. **All 18+ call sites** updated to use `sendPrompt()` instead of
   `pi.sendUserMessage()`:
   - `src/commands.ts` (5 sites)
   - `src/tools.ts` (2 sites)
   - `src/events/agent-settled/effect-applicator.ts` (5 sites)
   - `src/events/agent-settled/negotiate.ts` (5 sites)
   - `src/events/agent-settled/dispute.ts` (4 sites)
   - `src/spec-command.ts` (1 site)

3. **`src/commit.ts`** — `api.appendEntry` wrapped in try-catch to survive
   stale pi in print mode. The status file write is the fallback.

4. **`src/events/tool-call/index.ts`** — breaker's `pi.sendMessage` wrapped
   in try-catch (display-only, best-effort).

5. **`bin/run-loop.sh`** — updated to read the `prompt` field from the
   status file and send it to the next `pi --continue --print` process,
   instead of always sending `/loop-continue`.

## Tests

- `test/prompt.test.ts` — 9 new regression tests for `sendPrompt()` and
  `isRunnerMode()`.
- 1232 total tests passing.
