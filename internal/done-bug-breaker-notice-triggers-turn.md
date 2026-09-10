# fix-breaker-notice-turn-trigger

## Problem

Verified current state as of writing:

`src/events/tool-call/index.ts:192` sends the loop breaker notice via:
```ts
pi.sendUserMessage(BREAKER_NOTICE, {});
```

In the real SDK (v0.85.0), `sendUserMessage` **always** triggers a new agent
turn. The options type is `{ deliverAs?: "steer" | "followUp" }` — there is no
`triggerTurn` option. The `triggerTurn: false` that was previously passed was
silently ignored by the SDK (it's not in the type).

So when the breaker fires (5th repeated tool call), the sequence is:
1. `tool_call` handler returns `{ block: true, terminate: true, reason: BREAKER_NOTICE }`
2. The SDK terminates the current turn
3. `sendUserMessage(BREAKER_NOTICE, {})` queues the notice as a user message
4. The SDK starts a **new agent turn** with the notice as the prompt
5. The agent wakes up, reads "Loop breaker: the agent repeated the same tool
   call 5x...", and starts working — potentially into the same repetition loop

The notice is meant to be a **display-only** message that tells the *human* to
run `/loop-continue`. It should not start a new agent turn.

## Target

The breaker notice appears in the transcript as a system/custom message without
triggering a new agent turn. The user reads it, intervenes if needed, and runs
`/loop-continue` manually.

## Interface

The `sendMessage` API supports `triggerTurn: false`:
```ts
pi.sendMessage({
  customType: "loop-breaker",
  content: BREAKER_NOTICE,
  display: true,
}, { triggerTurn: false });
```

This replaces the `sendUserMessage` call. The `BREAKER_NOTICE` string is
unchanged (pinned verbatim in `src/events/tool-call/index.ts:42-44`).

The `appendEntry("loop-debug", ...)` call at line 191 is unchanged.

## Behavior

Order (pinned):
1. `debug(msg)` — log the breaker event
2. `pi.appendEntry("loop-debug", ...)` — persist the debug entry
3. `pi.sendMessage({ customType: "loop-breaker", ... }, { triggerTurn: false })` — display notice
4. `return { block: true, terminate: true, reason: BREAKER_NOTICE }` — block the call

The `terminate: true` in the return value is what stops the current turn.
The `sendMessage` with `triggerTurn: false` does NOT start a new turn.

## Test Strategy

- Unit test: mock `pi.sendMessage`, assert it's called with
  `triggerTurn: false` and the correct `customType`.
- Unit test: assert `pi.sendUserMessage` is NOT called (the old path).
- The existing breaker tests in `test/events/tool-call-breaker.test.ts`
  assert on `pi.sentMessages` — update to assert on `pi.sentCustomMessages`
  (or whatever the mock captures for `sendMessage`).
- No live-toolchain tests.

## Scope

- In scope: one call-site change in `src/events/tool-call/index.ts:192`,
  mock update in `test/__mocks__/@earendil-works/pi-coding-agent.ts`
  (ensure `sendMessage` is captured), test updates in
  `test/events/tool-call-breaker.test.ts`.
- Out of scope: changing `BREAKER_NOTICE` text, changing the breaker logic,
  changing `REPEATED_CALL_LIMIT`.

## Acceptance

- [ ] `pi.sendMessage` called with `triggerTurn: false` when breaker fires
- [ ] `pi.sendUserMessage` NOT called when breaker fires
- [ ] `BREAKER_NOTICE` text unchanged (verbatim pin)
- [ ] `REPEATED_CALL_LIMIT` still 5
- [ ] `terminate: true` still returned
- [ ] All existing breaker tests pass (updated for new API)
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all pass
