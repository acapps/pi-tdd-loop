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

After this fix: a Writer proposal that confirms an existing agreement (any case of "agree", with or without a tail) advances to Phase B on the Tester's approve, with at most one re-review round; the re-review round's own approval never re-enters row 2; a settle-without-tool-call reprompt states the current round, the last proposal, and the required next action; repeated identical tool calls inside one turn are blocked with a stop hint and a user-visible notice; and a `justTransitioned` settle is never double-triggered for the same `phase/round`.

## Interface

No new state fields. Changes are one helper + one call site in `src/tools.ts`, two prompt functions in `src/generic-prompts.ts`, one reprompt-effect widening in `src/transitions.ts`, one delivery call site in `src/events/agent-settled/negotiate.ts`, one guard in `src/events/agent-settled/index.ts`, and one new handler in `src/events/tool-call/index.ts` (new file, following the existing `src/events/*` handler pattern).

- New exported helper in `src/tools.ts` (exported for direct unit testing, mirroring the `isApproval` precedent): `isAgreeProposal(lastProposal: string): boolean` — `true` iff `lastProposal.trim().toLowerCase()` equals `"agree"` OR starts with `"agree:"` OR `"agree —"` (em dash) OR `"agree -"` (ASCII dash). The three tail forms are the observed Writer output shapes; the set is closed.
- **Reprompt effect widening** (`src/transitions.ts:18`): the `reprompt` variant of `TransitionEffect` gains optional `round?: number` and `lastProposal?: string`. `repromptWriter(state)` (`src/transitions.ts:131-141`) populates both from `state`; `repromptTester` does not (see §3). The type is non-exhaustive-safe: existing consumers pattern-match on `type`, optional fields break nothing.
- **Delivery call site** (`src/events/agent-settled/negotiate.ts:102-112`, `deliverReprompt`): the WRITER branch becomes `GP.promptNegotiateRepromptWriter(effect.round, effect.lastProposal ?? "")`. Note the receiver: `deliverReprompt` takes the **effect**, and `repromptWriter` has the **bare `LoopState`** (`state.round`, `state.lastProposal` — no `.current`); the effect is the carrier of state into the prompt.
- `src/events/tool-call/index.ts` (new): an `ExtensionHandler<ToolCallEvent, ToolCallEventResult>` — the SDK's `tool_call` result contract is `{ block?: boolean; reason?: string; terminate?: boolean }` (verified against the installed `@earendil-works/pi-coding-agent` types: `ToolCallEventResult`). There is **no `pi.interrupt()`** on `ExtensionAPI` (verified; the only interrupt surface is the TUI keybinding `app.interrupt`). At the 5th identical call within one turn the handler returns `{ block: true, terminate: true, reason: <notice> }` and sends the user message (see Behavior §4). `terminate` only takes effect when every finalized tool result in the batch sets it — with a single repeating call that is the whole batch, so the turn stops; this batch-caveat is pinned in a test note, not worked around.

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

### 3. Reprompt with state (src/generic-prompts.ts + negotiate.ts delivery)

`promptNegotiateRepromptWriter` (`src/generic-prompts.ts:56-63`) changes from a zero-arg function to a function of reprompt state:

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

The truncate-with-ellipsis is load-bearing: `lastProposal` can be a full paragraph (the session's was ~500 chars); the reprompt must not re-inject the whole proposal every time. **Call-site inventory (closed):** the function has exactly two call sites — `deliverReprompt` in `src/events/agent-settled/negotiate.ts:109` (production; passes `effect.round` / `effect.lastProposal ?? ""`), and two test assertions that pin the zero-arg call — `test/events/agent-settled/negotiate.test.ts:97` and `test/events/agent-settled/index.test.ts:477` (both rewritten, see Test Strategy). `promptNegotiateRepromptTester` is left unchanged (no equivalent ambiguity observed; a Tester reprompt always follows a proposal that exists), and `repromptTester` in `src/transitions.ts` does not populate the new effect fields.

### 4. Repeated-tool-call breaker (src/events/tool-call/index.ts, new)

- On each `tool_call` event: canonical key = `toolName + JSON.stringify(event.input, sortedKeys)` — one flat key, one counter per key. The counter map is `Map<string, number>` keyed by that flat string (F5: the earlier draft's `Map<toolName, {key, count}>` was self-contradictory; a per-toolName slot cannot track multiple distinct arg sets).
- Counter map is per-turn: cleared on `agent_settled` (and on `/loop-*` transitions that start a fresh turn).
- At the **5th** identical call within one turn: the handler returns `{ block: true, terminate: true, reason }` where reason is the verbatim notice below, and additionally (a) appends a `loop-debug` entry `Loop breaker: ${count}x ${toolName} with identical args — blocking call`, and (b) sends `pi.sendUserMessage("Loop breaker: the agent repeated the same tool call 5x. The call was blocked; if the repetition continues, interrupt the turn (ESC) and run /loop-continue.", { triggerTurn: false })`.
- **Blocked calls DO count toward the limit** (F5 pin): the counter increments on every identical call, blocked or not — call 6 is also blocked, with the same result. This makes the breaker sticky within a turn: the agent cannot probe past it. `terminate` is set on every block from the 5th onward, so the moment the batch finalizes the turn stops.
- Threshold 5 is a named constant `REPEATED_CALL_LIMIT = 5` in the new file.
- Ownership: `src/events/tool-call/index.ts` owns the counter; the extension's event registration in `index.ts` wires `pi.on("tool_call", handler)` (the `ExtensionAPI.on` overload for `tool_call` is verified in the installed types).

### 5. Just-transitioned double-trigger (src/events/agent-settled/index.ts)

`handleJustTransitioned` (`src/events/agent-settled/index.ts:60-76`) currently fires a second turn for `phase === "B" && round === 1` only (F4: there is **no Phase C branch** — the earlier draft's C claim was inaccurate; the Phase C Cleaner prompt in the session was single, not doubled), but the advance effect that set `justTransitioned` already sent the phase prompt: `applyAdvanceEffect` → `buildAdvancePrompt` (`src/events/agent-settled/effect-applicator.ts:264-277`) sends `promptWriterNegotiate` for the B advance. Change: the `phase === "B" && round === 1` branch is deleted; the handler clears the flag and returns `true` without sending a prompt. The `justTransitioned` flag keeps its existing role as the "a transition just happened, don't run the gate on this settle" guard (`src/events/agent-settled/index.ts:58`).

**Intended shift (not a quirk):** today, killing the turn between the effect's prompt and the settle re-delivers the phase prompt on settle (the double-trigger is accidentally idempotent). After this fix, an ESC'd phase turn does NOT re-deliver the prompt; the user must `/loop-continue`. This is the consistent behavior (the negotiate phase already works this way) but it is a behavior change — pinned here.

## Inventory

- Files: `src/tools.ts` (helper + row-2 call site), `src/generic-prompts.ts` (2 prompt functions), `src/transitions.ts` (reprompt effect widening + `repromptWriter` population), `src/events/agent-settled/negotiate.ts` (`deliverReprompt` call site), `src/events/agent-settled/index.ts` (double-trigger branch deletion), `src/events/tool-call/index.ts` (new file: counter + breaker), `index.ts` (event wiring), `test/tools-negotiate-re-review.test.ts` (row 2/3 additions), `test/generic-prompts.test.ts` or equivalent (prompt pins), `test/events/agent-settled/negotiate.test.ts` + `test/events/agent-settled/index.test.ts` (reprompt call-site rewrites + double-trigger pin), `test/events/tool-call.test.ts` (new).
- Exports added: `isAgreeProposal` (src/tools.ts), `REPEATED_CALL_LIMIT` (src/events/tool-call/index.ts).
- Imports: `src/tools.ts` gains none; `src/events/agent-settled/negotiate.ts` gains none (already imports `GP`); the new file imports `ToolCallEvent`/`ToolCallEventResult` types from `@earendil-works/pi-coding-agent`.

## Test Strategy

- Baseline: 1094 passed / 12 skipped (35 files), verified at `f591cc4`.
- Per-test disposition in `test/tools-negotiate-re-review.test.ts`:
  - "even round + real proposal + approve → re-review round" (round 2, `lastProposal: "plan X"`) — kept, unchanged.
  - "row 2 fires on every even round with a non-agree proposal (round 4)" — kept.
  - "odd round + approve → advance directly to B" — kept.
  - **"'agree' proposal + even round + approve → advance directly (re-review skipped)"** — kept; new test added beside it: `lastProposal: "Agree — the Tester's three updates are correct..."` + even round + approve → advance directly (the session's exact shape).
  - New unit tests for `isAgreeProposal`: the 6 rows in Behavior §1.
- New tests for the reprompt: the prompt contains `negotiate round ${round}` and the truncated proposal; the 200-char truncation pin (a 500-char proposal yields exactly 200 chars + `...`).
- **Reprompt call-site rewrites (F3):** `test/events/agent-settled/negotiate.test.ts:97` and `test/events/agent-settled/index.test.ts:477` currently pin the zero-arg `GP.promptNegotiateRepromptWriter()`; both are rewritten to assert `GP.promptNegotiateRepromptWriter(<round>, <proposal>)` with the fixture's values, and the reprompt effect fixture in those tests gains `round`/`lastProposal`.
- New tests for the breaker: identical call count 4 → not blocked; count 5 → `{ block: true, terminate: true }` + user message + debug entry; count 6 → still blocked (sticky); different args → counter does not advance; settle clears the counter.
- New test for §5: a `justTransitioned` settle in Phase B round 1 sends **zero** prompts after the effect already sent one (assert `pi.sentMessages` length).
- Untouched: all other negotiate/dispute/escalation tests stay green — the row-2 body, `transitionToPhaseB`, and the escalation path are unchanged. The §5 intended shift is the only behavior flip outside new tests; its flip is the existing "justTransitioned triggers Phase B Writer turn" test (rewrite: assert no second prompt).
- Live-toolchain rules: N/A — all tests mock the process boundary (`createMockExtensionAPI`), no real tool spawns.

## Scope lines

- `src/tools.ts`: added `isAgreeProposal`; rewritten row-2 condition (1 line).
- `src/generic-prompts.ts`: rewritten `promptNegotiateContractReReview` (1 sentence added); rewritten `promptNegotiateRepromptWriter` (signature + 2 lines).
- `src/transitions.ts`: widened the `reprompt` effect variant (2 optional fields); `repromptWriter` populates them.
- `src/events/agent-settled/negotiate.ts`: rewritten `deliverReprompt` WRITER branch (1 line).
- `src/events/agent-settled/index.ts`: rewritten `handleJustTransitioned` (B-round-1 prompt branch deleted, flag clear kept).
- `src/events/tool-call/index.ts`: added (new file, ~60 lines).
- `index.ts`: added `pi.on("tool_call", ...)` wiring (1 registration).
- `test/tools-negotiate-re-review.test.ts`: added 2 tests; `test/events/tool-call.test.ts`: added (new file); `test/events/agent-settled/negotiate.test.ts` + `index.test.ts`: reprompt call-site rewrites + double-trigger pin; prompt test file: additions.

## Acceptance Criteria

- Full test run green: `npx vitest run` — 35 files, the baseline 1094 plus the new tests; `npx tsc --noEmit` clean (vitest does not type-check).
- Grep sweep (functional): `rg 'lastProposal !== "agree"' src/` → 0 hits; `rg 'isAgreeProposal' src/` → ≥ 2 hits (definition + row-2 call site).
- Grep sweep (textual): `rg "advances the loop to Phase B" src/generic-prompts.ts` → exactly 1 hit.
- Regression pin: a unit test reproduces the session's exact sequence — even-round approve of `"Agree — ..."` → row 3 (Phase B, round 1), NOT row 2 — and it fails against the pre-fix code.
- Breaker pin: a unit test asserts the verbatim user message `Loop breaker: the agent repeated the same tool call 5x. The call was blocked; if the repetition continues, interrupt the turn (ESC) and run /loop-continue.`, the returned `{ block: true, terminate: true }`, and that a 6th identical call is also blocked (sticky pin).

## Dependencies

- `internal/bug-negotiate-drift.md` (implemented; `done-` archive pending) — this spec fixes a defect *in its* row-2 rule; it must land after that code is stable. No other hard dependencies.
- Soft: the §5 change touches the same `handleJustTransitioned` any future negotiate-settle-persistence spec would; sequence after `bug-negotiate-settle-not-persisted` if it lands first.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | blocker | Row-2 exact-string discriminator makes confirmatory "Agree — ..." proposals loop forever (session `01a07331`, 04:51–04:55 + 22:26 escalation) | accepted — this spec, Behavior §1 |
| 2 | needs-doc | Settled-without-tool-call reprompt is silent about the current round/proposal; Writer re-read the spec and re-grepped 150x after an approval was already recorded (session `01a07331`, 21:39–22:26) | accepted — Behavior §3. Open question for the author: is a *turn-level* stuck-agent breaker (finding 4) the right layer, or should the reprompt carry a "you already proposed X" diff? Spec pins the state-injection; the breaker is a separate unit if wanted |
| 3 | needs-doc | No in-turn circuit breaker; `turnsThisPhase` only advances on settle, so one hung turn is invisible to loop detection (session `01a07331`, ~150 identical greps) | accepted — Behavior §4. **Phase 0 (2026-09-06, F1):** `pi.interrupt()` does not exist on `ExtensionAPI` (verified in the installed SDK types); the `tool_call` handler contract is `{ block, reason, terminate }`. Spec rewritten: the breaker blocks + terminates the batch and sends a corrected user message; no interrupt claim remains |
| 4 | needs-doc | `justTransitioned` double-triggers the Phase B prompt (session log 3205+3211); also makes ESC mid-phase accidentally idempotent (quirk) | pin-vs-fix is the open question. Spec proposes fix (single sender = the advance effect), with the intended shift pinned in Behavior §5. **Phase 0 (F4):** the earlier "C likewise" claim was inaccurate — `handleJustTransitioned` has no Phase C branch; corrected. If the author prefers to pin the double-trigger as a quirk (ESC re-delivery is arguably useful), delete Behavior §5 and its tests |
| 5 | major | Phase 0 review (2026-09-06): F2 — §3 named the wrong receiver (`deliverReprompt` takes the effect; the reprompt builder gets bare `LoopState` in `repromptWriter`); F3 — the signature change breaks the two existing test pins and `negotiate.ts` was missing from Inventory/Scope; F5 — the counter-key wording was self-contradictory and blocked-call counting was unpinned | accepted — Interface (effect widening + delivery call site), Behavior §3/§4, Inventory, Test Strategy, and Scope lines all corrected |
