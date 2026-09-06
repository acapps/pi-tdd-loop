# fix-negotiate-confirm-approval-loop

## Problem

Verified current state as of writing (code checked against the repo at `f591cc4`; runtime evidence: session `01a07331-0c0d-750f-8a31-044251428250`, 2026-09-05 20:09 → 2026-09-06 ~09:36 local, spec `refactor-state-model-divergence.md` — the flat-state refactor run that finished green).

**A confirmatory Writer proposal that is not lexically `"agree"` makes the approve → re-review → approve → re-review cycle un-terminating, and the loop re-delivers the original Writer prompt each time, so a human watching sees nested phases that never resolve.**

The `bug-negotiate-drift` fix (row 2, `src/tools.ts:316`) intercepts `negotiate_review: approve` on an even round when `state.current.lastProposal !== "agree"` and routes to `executeNegotiateReReview` (`src/tools.ts:318-337`) instead of `transitionToPhaseB`. The discriminator is an **exact-string** comparison. In the session, the Writer's round-5 proposal was:

> "Agree — the Tester's three updates are correct and complete. Confirming the cleanup set: 1. **test/revi..."

Semantically a confirmation; lexically not `"agree"`. So the sequence at 04:51–04:55 local was:

1. Tester approves the real proposal (even round) → row 2 fires → `round++`, `justTransitioned=true`, **no phase change**, re-review prompt sent (`src/tools.ts:318-337`).
2. Tester re-verifies the file, approves again (odd round) → row 3 fires → `transitionToPhaseB` (`src/tools.ts:339-343`).
3. **But** `handleJustTransitioned` (`src/events/agent-settled/index.ts:69-79`) only triggers a turn for `phase === "B" && round === 1` (and `phase === "C"`); for a pending `negotiate` it clears the flag and returns. The negotiate settle handler then re-delivers the round-1 Writer prompt (`Negotiate round 1 (Writer)`, log line 2944) — the Writer re-reads the spec, re-greps, re-proposes "agree, nothing changed on disk," the Tester re-approves, and the cycle repeats. Observed full cycles at 04:51, 04:55, and again after the 22:26 escalation; each ESC killed one in-flight turn and the loop dutifully re-delivered the next prompt — the user-visible "nested phases."

**Contributing finding 4 (same session):** the same `justTransitioned` double-trigger delivered the Phase B Writer prompt **twice** — `promptWriterPhaseB` ("Advancing to Phase B without explicit approval...") at log line 3205 and `promptNegotiateApproved` ("Phase B approved...") at log line 3211, ~1.3s apart, and the Phase C Cleaner prompt twice likewise. The settle handler's `handleJustTransitioned` fires a second turn for the same `phase/round` the effect already prompted.

**Contributing finding 2 (same session):** the settled-without-tool-call reprompt is silent about the *current* negotiation state. After the 04:51 re-review approve, the loop re-delivered the round-1 Writer prompt (log line 2944) — "Read the spec... Use negotiate_propose: 'agree' if tests match spec" — with no mention that the Writer had already proposed and the Tester had already approved. The Writer agent then spent ~150 iterations repeating the same grep before finally proposing; three context compactions fired in the window, each summary mislabeling the active role as "WRITER (Phase B)". The reprompt prompt (`src/generic-prompts.ts:56-63`, `promptNegotiateRepromptWriter`) says "Call negotiate_propose now" — correct in isolation, but delivered after an approval it contradicts.

**Contributing finding 3 (same session):** there is no circuit breaker inside a turn. The stuck-grep loop ran 150+ iterations because `turnsThisPhase` only advances on settle (`src/events/agent-settled/index.ts:43-55` escalation check), so a single hung turn is invisible to loop detection.

## Target

After this fix: a Writer proposal that confirms an existing agreement (any case of "agree", with or without a tail) advances to Phase B on the Tester's approve, with at most one re-review round; the re-review round's own approval never re-enters row 2; a settle-without-tool-call reprompt states the current round, the last proposal, and the required next action; repeated identical tool calls inside one turn interrupt the turn with an escalation notice; and a `justTransitioned` turn is never double-triggered for the same `phase/round`.

## Interface

No new state fields. Changes are one helper + one call site in `src/tools.ts`, one prompt function in `src/generic-prompts.ts`, one guard in `src/events/agent-settled/index.ts`, and one new handler in `src/events/tool-call/index.ts` (new file, following the existing `src/events/*` handler pattern).

- New exported helper in `src/tools.ts` (exported for direct unit testing, mirroring the `isApproval` precedent): `isAgreeProposal(lastProposal: string): boolean` — `true` iff `lastProposal.trim().toLowerCase()` equals `"agree"` OR starts with `"agree:"` OR `"agree —"` (em dash) OR `"agree -"` (ASCII dash). The three tail forms are the observed Writer output shapes; the set is closed.
- `src/events/tool-call/index.ts` (new): `handleToolCall(ctx: ...)` — maintains a per-session `Map<toolName, { key: string; count: number }>` keyed by `toolName + canonical-args`; resets on `agent_settled`; at count 5 of the same `(toolName, args)` within one turn, returns a stop effect (see Behavior).

## Behavior

### 1. Row 2 discriminator (src/tools.ts)

Decision table for the approve branch of `handleNegotiateReview` (`src/tools.ts:311-321`), first-match-wins, replaces the `state.current.lastProposal !== "agree"` check:

| # | Condition (evaluated in order) | Effect |
|---|---|---|
| 1 | `isApproval(decision)` is false | `executeNegotiateFeedback` (unchanged) |
| 2 | `round % 2 === 0` AND `!isAgreeProposal(lastProposal)` | `executeNegotiateReReview` (unchanged body) |
| 3 | otherwise (odd round, or agree-shape proposal) | `executeNegotiateApprove` → `transitionToPhaseB` (unchanged) |

`isAgreeProposal` rows: `"agree"` → true (existing); `"Agree — the Tester's..."` → true; `"AGREE"` → true; `"agree: tests match"` → true; `"Agree - fixes applied"` → true; `"agreement reached"` → false (word boundary, not a prefix match); `""` → false (no proposal recorded — row 3 advances, same as today's `!== "agree"` for the empty string... **no**: today `"" !== "agree"` is true so an empty proposal on an even round re-reviews; after the fix `isAgreeProposal("")` is false, so it still re-reviews — behavior unchanged, pinned here deliberately).

### 2. Re-review prompt advance pin (src/generic-prompts.ts)

`promptNegotiateContractReReview` (`src/generic-prompts.ts:42-46`) gains one sentence, appended after "No file writes.":

> `An 'approve' here advances the loop to Phase B.`

The re-review round is odd; with fix #1 the round-3 approve of a confirmatory proposal can no longer re-fire row 2, so the prompt change is belt-and-braces for the Tester's decision (it currently cannot tell that its approve is the final gate).

### 3. Reprompt with state (src/generic-prompts.ts)

`promptNegotiateRepromptWriter` (`src/generic-prompts.ts:56-63`) changes from a constant to a function of state:

```
promptNegotiateRepromptWriter(round: number, lastProposal: string): string
```

Shape (verbatim):

```
Must use negotiate_propose. Do NOT write files.

Current state: negotiate round ${round}${lastProposal ? `; last proposal: ${lastProposal.slice(0, 200)}...` : ""}.
Call negotiate_propose now:
  - plan='agree' if tests match spec, OR
  - plan='your approach'
```

The truncate-with-ellipsis is load-bearing: `lastProposal` can be a full paragraph (the session's was ~500 chars); the reprompt must not re-inject the whole proposal every time. Call site passes `state.current.round` and `state.current.lastProposal`. `promptNegotiateRepromptTester` is left unchanged (no equivalent ambiguity observed; a Tester reprompt always follows a proposal that exists).

### 4. Repeated-tool-call breaker (src/events/tool-call/index.ts, new)

- On each `tool_call` event: canonical key = `toolName + JSON.stringify(args, sortedKeys)`.
- Counter map is per-turn: cleared on `agent_settled` (and on `/loop-*` transitions that start a fresh turn).
- At the **5th** identical call within one turn: the handler returns an effect that (a) appends a `loop-debug` entry `Loop breaker: ${count}x ${toolName} with identical args — interrupting turn`, (b) calls `pi.interrupt()` (API availability verified in Phase 0; if `interrupt` is not exposed on `ExtensionAPI`, the spec is blocked and the finding downgrades to debug-notice-only — logged in Findings), and (c) sends `pi.sendUserMessage("Loop breaker: the agent repeated the same tool call 5x. The turn was interrupted; run /loop-continue to resume.", { triggerTurn: false })`.
- Threshold 5 is a named constant `REPEATED_CALL_LIMIT = 5` in the new file.
- Ownership: `src/events/tool-call/index.ts` owns the counter; `src/events/index.ts` (or the extension's event registration in `index.ts`) wires the `tool_call` event to the handler.

### 5. Just-transitioned double-trigger (src/events/agent-settled/index.ts)

`handleJustTransitioned` (`src/events/agent-settled/index.ts:69-79`) currently fires a second turn for `phase === "B" && round === 1` and `phase === "C"`, but the effect that set `justTransitioned` already sent the phase prompt. Change: the handler clears the flag and returns without sending a prompt; the *effect* (`applyEffect` in `src/events/agent-settled/effect-applicator.ts`) remains the single prompt sender. The `justTransitioned` flag keeps its existing role as the "a transition just happened, don't run the gate on this settle" guard (`src/events/agent-settled/index.ts:58`).

**Intended shift (not a quirk):** today, killing the turn between the effect's prompt and the settle re-delivers the phase prompt on settle (the double-trigger is accidentally idempotent). After this fix, an ESC'd phase turn does NOT re-deliver the prompt; the user must `/loop-continue`. This is the consistent behavior (the negotiate phase already works this way) but it is a behavior change — pinned here.

## Inventory

- Files: `src/tools.ts` (helper + row-2 call site), `src/generic-prompts.ts` (2 prompt functions), `src/events/agent-settled/index.ts` (1 guard), `src/events/tool-call/index.ts` (new file: counter + breaker), `index.ts` or `src/events/index.ts` (event wiring), `test/tools-negotiate-re-review.test.ts` (row 2/3 flips), `test/generic-prompts.test.ts` or equivalent (prompt pins), `test/events/agent-settled.test.ts` (double-trigger pin), `test/events/tool-call.test.ts` (new).
- Exports added: `isAgreeProposal` (src/tools.ts), `REPEATED_CALL_LIMIT` (src/events/tool-call/index.ts).
- Imports: `src/tools.ts` gains none; the new file imports `LoopState`-adjacent types per the existing event-handler pattern.

## Test Strategy

- Baseline: 1094 passed / 12 skipped (35 files), verified at `f591cc4`.
- Per-test disposition in `test/tools-negotiate-re-review.test.ts`:
  - "even round + real proposal + approve → re-review round" (round 2, `lastProposal: "plan X"`) — kept, unchanged.
  - "row 2 fires on every even round with a non-agree proposal (round 4)" — kept.
  - "odd round + approve → advance directly to B" — kept.
  - **"'agree' proposal + even round + approve → advance directly (re-review skipped)"** — kept; new test added beside it: `lastProposal: "Agree — the Tester's three updates are correct..."` + even round + approve → advance directly (the session's exact shape).
  - New unit tests for `isAgreeProposal`: the 6 rows in Behavior §1.
- New tests for the reprompt: the prompt contains `negotiate round ${round}` and the truncated proposal; the 200-char truncation pin (a 500-char proposal yields exactly 200 chars + `...`).
- New tests for the breaker: identical call count 4 → no interrupt; count 5 → interrupt + user message + debug entry; different args → counter does not advance; settle clears the counter.
- New test for §5: a `justTransitioned` settle in Phase B round 1 sends **zero** prompts after the effect already sent one (assert `pi.sentMessages` length).
- Untouched: all other negotiate/dispute/escalation tests stay green — the row-2 body, `transitionToPhaseB`, and the escalation path are unchanged. The §5 intended shift is the only behavior flip outside new tests; its flip is the existing "justTransitioned triggers Phase B Writer turn" test (rewrite: assert no second prompt).
- Live-toolchain rules: N/A — all tests mock the process boundary (`createMockExtensionAPI`), no real tool spawns.

## Scope lines

- `src/tools.ts`: added `isAgreeProposal`; rewritten row-2 condition (1 line).
- `src/generic-prompts.ts`: rewritten `promptNegotiateContractReReview` (1 sentence added); rewritten `promptNegotiateRepromptWriter` (signature + 2 lines).
- `src/events/agent-settled/index.ts`: rewritten `handleJustTransitioned` (prompt send removed, flag clear kept).
- `src/events/tool-call/index.ts`: added (new file, ~60 lines).
- `index.ts` / `src/events/index.ts`: added `tool_call` wiring (1 registration).
- `test/tools-negotiate-re-review.test.ts`: added 2 tests; `test/events/tool-call.test.ts`: added (new file); prompt + agent-settled test files: additions + 1 rewrite.

## Acceptance Criteria

- Full test run green: `npx vitest run` — 35 files, the baseline 1094 plus the new tests; `npx tsc --noEmit` clean (vitest does not type-check).
- Grep sweep (functional): `rg 'lastProposal !== "agree"' src/` → 0 hits; `rg 'isAgreeProposal' src/` → ≥ 2 hits (definition + row-2 call site).
- Grep sweep (textual): `rg "advances the loop to Phase B" src/generic-prompts.ts` → exactly 1 hit.
- Regression pin: a unit test reproduces the session's exact sequence — even-round approve of `"Agree — ..."` → row 3 (Phase B, round 1), NOT row 2 — and it fails against the pre-fix code.
- Breaker pin: a unit test asserts the verbatim user message `Loop breaker: the agent repeated the same tool call 5x. The turn was interrupted; run /loop-continue to resume.`

## Dependencies

- `internal/bug-negotiate-drift.md` (implemented; `done-` archive pending) — this spec fixes a defect *in its* row-2 rule; it must land after that code is stable. No other hard dependencies.
- Soft: the §5 change touches the same `handleJustTransitioned` any future negotiate-settle-persistence spec would; sequence after `bug-negotiate-settle-not-persisted` if it lands first.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | blocker | Row-2 exact-string discriminator makes confirmatory "Agree — ..." proposals loop forever (session `01a07331`, 04:51–04:55 + 22:26 escalation) | accepted — this spec, Behavior §1 |
| 2 | needs-doc | Settled-without-tool-call reprompt is silent about the current round/proposal; Writer re-read the spec and re-grepped 150x after an approval was already recorded (session `01a07331`, 21:39–22:26) | accepted — Behavior §3. Open question for the author: is a *turn-level* stuck-agent breaker (finding 4) the right layer, or should the reprompt carry a "you already proposed X" diff? Spec pins the state-injection; the breaker is a separate unit if wanted |
| 3 | needs-doc | No in-turn circuit breaker; `turnsThisPhase` only advances on settle, so one hung turn is invisible to loop detection (session `01a07331`, ~150 identical greps) | accepted as a separate unit — Behavior §4. **Open:** `pi.interrupt()` API availability unverified; Phase 0 must confirm or the unit downgrades to debug-notice-only |
| 4 | needs-doc | `justTransitioned` double-triggers the phase prompt (B at log 3205+3211, C likewise); also makes ESC mid-phase accidentally idempotent (quirk) | pin-vs-fix is the open question. Spec proposes fix (single sender = the effect), with the intended shift pinned in Behavior §5. If the author prefers to pin the double-trigger as a quirk (ESC re-delivery is arguably useful), delete Behavior §5 and its tests |
