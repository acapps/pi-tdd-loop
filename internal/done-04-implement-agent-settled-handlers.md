# Implement agent_settled sub-handlers (dispute, review, negotiate, gate-transition)

## Problem

`src/events.ts` exports `eventAgentSettled()` with inline dispatch to phase-specific handlers. The `src/events/agent-settled/` directory has stub modules. All working code is in the monolith: `handleReviewSettled`, `handleNegotiateSettled`, `handleGateTransition`, `handleDisputeFix`, `handleDisputeReview`, `handleJustTransitioned`, `checkLoopEscalation`, `isTerminalPhase`, plus the gate helpers `logGateResult`, `stateSummary`, and the inline effect functions (kept here per the Note).

## Target

Implement each sub-handler in `src/events/agent-settled/` and wire the dispatcher in `agent-settled/index.ts`. The dispatcher's operation order, return mapping, and state reassignment match the monolith exactly.

## Dispatcher — operation order and return mapping (G5)

`handleAgentSettled` in `index.ts`, in this exact order. Verified against `eventAgentSettled` in `src/events.ts`.

```typescript
export function handleAgentSettled(input): boolean | undefined {
  const { state, pi, debug, ctx } = input;

  // Step 1: terminal short-circuit — BEFORE any lang resolution
  if (isTerminalPhase(state.current.phase)) return undefined;

  // Step 2: lang resolution — may throw on corrupted state (same asymmetry as spec 03 S1)
  const lang = getLanguageConfig(state.current.language);

  // Steps 3–6: guards — each returns undefined from the dispatcher when handled
  if (checkLoopEscalation(state, ctx, debug)) return undefined;
  if (handleJustTransitioned(state, pi, lang, debug)) return undefined;
  if (handleDisputeFix({ state, pi, lang, ctx }).handled) return undefined;
  // Dead guard: handleDisputeReview ALWAYS returns handled:false (flag set or not),
  // so this branch never fires — execution falls through to steps 7–9. Preserve it as written.
  if (handleDisputeReview({ state, pi, lang, debug, ctx }).handled) return undefined;

  // Steps 7–9: phase handlers — dispatcher returns their result
  if (state.current.phase === "review") {
    return handleReviewSettled({ state, pi, ctx, lang, debug }).handled;
  }
  if (state.current.phase === "negotiate") {
    const result = handleNegotiateSettled({ state: state.current, pi, ctx, lang, debug });
    state.current = result.newState;           // G2: explicit reassignment
    return result.handled;                      // always true
  }
  // A / B / C
  const gate = handleGateTransition({ state: state.current, pi, ctx, lang, debug });
  state.current = gate.state;                   // G2: explicit reassignment
  state.current.lastGateResult = gate.gateResult; // G3: user-visible via /loop-status and selectors
  return gate.applied;
}
```

| Step | Condition | Dispatcher returns |
|---|---|---|
| 1 | phase idle/done/escalated | `undefined` |
| 2 | lang resolution | — (may throw `Language not available: …` on corrupted `state.language`; steps 1 short-circuits before it, so terminal + corrupted → `undefined` no-throw) |
| 3 | loop escalation triggered | `undefined` |
| 4 | justTransitioned handled | `undefined` |
| 5 | disputeFix handled | `undefined` |
| 6 | disputeReview "handled" | `undefined` — **dead branch** (see above); in practice falls through |
| 7 | phase review | `handled` — true when `awaitingReview`, false otherwise |
| 8 | phase negotiate | `true` (always) |
| 9 | phase A/B/C | `applied` — true for retry/advance/done/escalated effects, false for noop |

## File assignment (G4)

Full inventory of monolith functions → destination. No function is left unassigned.

| Monolith function | Destination | Notes |
|---|---|---|
| `eventAgentSettled` | stays in `events.ts` as delegator | pure pass-through: `async (_event, ctx) => handleAgentSettled({ state, pi, debug, ctx })` |
| `isTerminalPhase` | `index.ts` | dispatcher guard |
| `checkLoopEscalation` | `index.ts` | dispatcher guard, in-place mutation |
| `handleJustTransitioned` | `index.ts` | dispatcher guard, in-place mutation + message |
| `handleDisputeFix` | `dispute.ts` | |
| `handleDisputeReview` | `dispute.ts` | |
| `handleReviewSettled` | `review.ts` | |
| `handleNegotiateSettled` | `negotiate.ts` | pure-state handler |
| `handleGateTransition` | `gate-transition.ts` | pure-state handler |
| `logGateResult` | `gate-transition.ts` | |
| `stateSummary` | local copy in `index.ts` and `gate-transition.ts`; **the `events.ts` copy is deleted in this spec** | 5-line helper; its only two call sites (lines 152, 234) both move out with their handlers, leaving the events.ts copy dead. **Not** a shared export — `index.ts` imports the sub-modules, so sub-modules importing from `index.ts` would create the circular dependency the refactor exists to remove (session-start.ts precedent: local copy) |
| `applyEffect`, `handleRetryEffect`, `handleAdvanceEffect`, `handleDoneEffect`, `handleEscalatedEffect`, `buildRetryPrompt`, `buildAdvancePrompt` | `gate-transition.ts` (interim) | until spec 05 extracts them into `effect-applicator.ts` |
| `getLang` | deleted in this spec | R4 (corrected): the `events.ts` copy has **exactly one caller** — `eventAgentSettled` itself (verified: sole call site line 91; the 02/03 delegators already resolve lang inside their modules). Inlined into dispatcher step 2, it is dead code — delete it here, not in spec 06 |

## Handler contracts (G1, G2, R1, R2)

Two shapes. The stub interfaces are the target shape, with **three pinned adjustments** (G1, R1, R2) where the stubs as written contradict the pinned code:

**Pure-state handlers** (negotiate, gate-transition): take the **bare** `LoopState`, **never mutate or replace** `state.current` themselves, return the new state. The dispatcher reassigns (G2). `computeTransition`/`computeNegotiateTransition` return new objects — if the dispatcher forgets the assignment, round increments and phase advances are silently dropped.

**Wrapper handlers** (dispute, review, escalation, justTransitioned): take `{ current: LoopState }`, mutate in place where the monolith does (escalation: `turnsThisPhase++`/`phase`/`lastPhase`; justTransitioned: `justTransitioned = false`), no state replacement.

**G1 — `GateHandlerInput` is missing `pi`.** The stub declares `{ state, ctx, lang, debug }` but the Note below keeps `applyEffect` inline in `gate-transition.ts`, and `applyRetryEffect`/`applyAdvanceEffect` call `pi.sendUserMessage`. Fix the stub: add `pi: ExtensionAPI` to `GateHandlerInput`.

**R1 — `NegotiateHandlerInput.state` is the wrapper in the stub.** The stub declares `state: { current: LoopState }`, but the pinned dispatcher passes bare `state.current` to a pure-state handler. Fix the stub: `NegotiateHandlerInput.state: LoopState` (bare) — consistent with the pure-state contract.

**R2 — `DisputeHandlerInput.debug` is required in the stub, but the pinned dispatcher omits it.** The monolith's `handleDisputeFix` never debug-logs (verified: zero debug calls), so the pinned call `handleDisputeFix({ state, pi, lang, ctx })` won't type-check against the stub as written. Fix the stub: `debug?: (msg: string) => void` (optional). `handleDisputeReview` still receives `debug` (it logs `Dispute review pending`).

**`handleGateTransition` output** — adjust the stub output (designed before applyEffect was inlined): `{ state: LoopState; gateResult: GateResult; applied: boolean }`. The effect is consumed internally by `applyEffect`; `applied` is its boolean result (the dispatcher's step-9 return). The stub's `effect`/`prompt` output fields are dropped — tests are rewritten anyway (Test Strategy).

## Per-handler behavior (verified against monolith)

### checkLoopEscalation (index.ts, every settle)

```typescript
state.current.turnsThisPhase = (state.current.turnsThisPhase || 0) + 1;   // `|| 5`-style fallback preserved
const maxTurns = state.current.maxTurnsPerPhase || 5;
if (state.current.turnsThisPhase <= maxTurns) return false;
debug(`Loop detected (${state.current.turnsThisPhase} turns in phase ${state.current.phase}), escalating`);
state.current.lastPhase = state.current.phase;
state.current.phase = "escalated";
ctx.ui.notify(`Loop detected in Phase ${state.current.lastPhase}. Escalating to human.`, "warning");
ctx.ui.setStatus("loop", "escalated (loop detected)");
return true;
```

### handleJustTransitioned (index.ts)

Clears `justTransitioned` (in place) and returns true. **Only** when `phase === "B" && round === 1` sends `pi.sendUserMessage(lang.prompts.promptNegotiateApproved(), { triggerTurn: true })` — no message on any other round. Debug: `agent_settled: justTransitioned → clearing & triggering turn (Phase B round 1)`, then `agent_settled: triggering Phase B Writer turn`.

### handleDisputeFix (dispute.ts)

No state mutation. Sets UI status `Phase B — round ${round} (dispute fix)`, sends `lang.prompts.promptTesterDisputeFix()` with `{ triggerTurn: true }`, returns `handled: true`. (The `awaitDisputeFix` flag is cleared elsewhere — at prompt-build time, spec 03.)

### handleDisputeReview (dispute.ts)

**Flag-preservation invariant:** does NOT clear `awaitDisputeReview` — the flag must stay `true` so tool-call blocking continues until the gate runs; only the retry effect (spec 05) clears it. Persists `pi.appendEntry("loop-state", { ...state.current })`, sets UI status, debug `Dispute review pending`, returns `handled: false` **unconditionally** (flag set or not — this is what makes dispatcher step 6 a dead guard).

### handleReviewSettled (review.ts)

`!awaitingReview` → `handled: false`. Otherwise: notify `Phase 0: Review findings. Use /loop-approve to proceed.` (info), status `Phase 0 — review pending`, persist `loop-state` entry, `handled: true`. (Takes a `lang` param unused in the body — dead parameter, preserved for parity with the monolith.)

### handleNegotiateSettled (negotiate.ts)

Debug `Negotiate: agent didn't use tool (reprompted=${state.negotiateReprompted}, round ${state.round})`. Calls `T.computeNegotiateTransition(state)` → `{ state, effect }`. Applies the effect **internally** (side effects allowed; state is returned, not replaced): reprompt → `pi.sendUserMessage(GP.promptNegotiateRepromptWriter/Tester(), { triggerTurn: true })` + notify; advance → notify + status + `pi.sendUserMessage(lang.prompts.promptNegotiateAutoAdvance(), { triggerTurn: true })`, debug `Negotiate: auto-advancing to Phase B`. Returns `{ handled: true, newState }`.

### handleGateTransition (gate-transition.ts)

`runGates(ctx.cwd, state.coverageThreshold, state.language, state.buildTool, state.phase)` → `logGateResult` (debug `Gate pass/fail (N failures) [compile=… tests=… cov=…%]`) → `T.computeTransition(state, gateResult)` → `applyEffect(...)` inline → debug `→ ${effect.type} (Phase … round …)` → returns `{ state: newState, gateResult, applied }`.

## Debug strings (preserve verbatim)

| Site | String |
|---|---|
| checkLoopEscalation | `` `Loop detected (${turns} turns in phase ${phase}), escalating` `` |
| justTransitioned | `` `agent_settled: justTransitioned → clearing & triggering turn (${stateSummary})` `` |
| justTransitioned (B r1) | `agent_settled: triggering Phase B Writer turn` |
| disputeReview | `Dispute review pending` |
| review | `Phase 0 review: agent settled, awaiting human /loop-approve` |
| negotiate | `` `Negotiate: agent didn't use tool (reprompted=${negotiateReprompted}, round ${round})` `` |
| negotiate (auto-advance) | `Negotiate: auto-advancing to Phase B` |
| gate | `` `Gate ${status} [compile=${c} tests=${t} cov=${cov}%]` `` then `` `→ ${effect.type} (${stateSummary})` `` |

## Scope line (final state of events.ts)

**After this spec, `events.ts` = 4 delegators + `EventCtx` + `DebugFn`/types only. No dead helpers, no unused imports.** Concretely:

- **Deleted helpers:** `getLang` (sole caller was `eventAgentSettled`), `stateSummary` (both call sites move out) — plus all handlers in the file-assignment table
- **Deleted imports** (zero remaining users once the handlers move): `runGates`/`formatFailures` from `./gates`, `GP` from `./generic-prompts`, `T` from `./transitions`, `getLanguageConfig` from `./languages`, `RETRY_PROMPTS`/`ADVANCE_PROMPTS`/`REPROMPT_KEYS` from `./constants`
- **Remaining:** `ExtensionAPI`/`LoopState` types, `EventCtx`, `DebugFn`, the 4 delegators, and the new `handleAgentSettled` import from `./events/agent-settled`

No test gate catches unused imports (vitest doesn't type-check; `tsc` without `noUnusedLocals` ignores them) — hence the explicit acceptance criterion below.

## Constraints

- **No new error handling.** The monolith has no try/catch in any of these handlers. Do not add any — gate command failures surface as `GateResult` fields, not exceptions.
- **No behavioral change** = full `npm test` green (includes the golden runner + e2e quality tests), not just the unit suite.

## Test Strategy

Baseline: 112/112 agent-settled contract tests pass against stubs. After implementation these stub assertions **fail** and must be rewritten (same pattern as spec 03 F4):

| File | Stub assertions | Rewrite to |
|---|---|---|
| `index.test.ts` | 8× dispatcher returns `undefined` | Per-branch return mapping (G5 table) — terminal → `undefined`; negotiation settle → `true`; review settle → `true`/`false` per `awaitingReview`; escalation → `undefined`; **dispatcher assigns `lastGateResult` onto the new gate state** (G3 — the assignment lives in the dispatcher, so the assert goes here, not in gate-transition.test.ts) |
| `negotiate.test.ts` | 4× `handled: false` + `newState` pass-through | Real transition: reprompt (odd/even round) and auto-advance; `newState` differs per effect; `pi.sendUserMessage` called with the right prompt |
| `dispute.test.ts` | `handled: false` stubs | disputeFix → handled true + prompt sent; disputeReview → handled false + **flag still true** + snapshot appended |
| `review.test.ts` | `handled: false` stubs | `awaitingReview` true → handled + notify + entry; false → unhandled |
| `gate-transition.test.ts` | noop stub output | Real gate: mock `runGates`, assert `state`/`gateResult`/`applied` per effect |
| `effect-applicator.test.ts` | stub `applied: false` | **Unchanged in this spec** — that module stays a stub until spec 05 |

**Flag-preservation spot-asserts** (the two subtle invariants, both in `index.test.ts`):
1. `awaitDisputeReview` stays `true` after a full `handleAgentSettled` call with the flag set (phase B) — gate runs, snapshot persisted, flag intact.
2. `justTransitioned: true` + phase B round 1 → after the call: flag `false`, `pi.sendUserMessage` called exactly once with `promptNegotiateApproved()` and `{ triggerTurn: true }`; round 2 variant: flag `false`, **no** message.

## Acceptance Criteria

- [ ] Dispatcher operation order + return mapping match the G5 table, including the dead step-6 guard preserved as written
- [ ] Dispatcher reassigns `state.current` after negotiate and gate handlers (G2); `lastGateResult` set on the new state (G3)
- [ ] `GateHandlerInput` includes `pi` (G1); gate-transition output is `{ state, gateResult, applied }`
- [ ] Every monolith function in the file-assignment table moved; `events.ts` reduced per the Scope line — 4 delegators + `EventCtx` + types, `getLang`/`stateSummary` deleted, all unused import lines removed (no test gate catches unused imports — verified by inspection/`tsc --noEmit`, not by the suite)
- [ ] Flag-preservation spot-asserts pass (disputeReview keeps flag; justTransitioned clears + conditional message)
- [ ] Debug strings match the table verbatim
- [ ] No new error handling added anywhere
- [ ] `npm test` fully green (unit + golden + e2e); agent-settled stub tests rewritten per Test Strategy, `effect-applicator.test.ts` untouched
- [ ] No behavioral change vs the monolith

## Note

`applyEffect` and its helpers stay inline in `gate-transition.ts` for this spec — spec 05 extracts them into `effect-applicator.ts`. **Type note:** the stubs currently carry two copies of the effect union (`TransitionEffect` in gate-transition.ts, `TransitionEffectType` in effect-applicator.ts), both looser than `transitions.ts`'s effect type (which types `phase: Phase` and the prompt keys). For this spec, gate-transition uses the effect type produced by `T.computeTransition` as-is; spec 05 consolidates the two stub copies when the extraction lands. Not a 04 change item — recorded so the writer doesn't pick one copy arbitrarily.

## Phase 0 review findings (verdict: 5 gaps — G1–G5)

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| G1 | Blocking | `GateHandlerInput` missing `pi` — contradicts the Note keeping `applyEffect` (which calls `pi.sendUserMessage`) inline in gate-transition.ts | **Accepted (verified in stub).** `pi: ExtensionAPI` added to the interface; gate-transition output shape re-pinned to `{ state, gateResult, applied }` since the effect is consumed internally |
| G2 | Must | Dispatcher must explicitly reassign `state.current = result.newState/result.state` — `computeTransition` returns new objects; unassigned = silent behavioral change | **Accepted.** Pure-state handler contract + the exact dispatcher assignment lines pinned in the operation-order block |
| G3 | Should | `lastGateResult` persistence omitted from change #5 — user-visible via `/loop-status` and selectors | **Accepted.** `state.current.lastGateResult = gate.gateResult` pinned in the dispatcher (mirrors monolith line-for-line) |
| G4 | Should | No file assignment for dispatch steps 1–3 or the full inline-handler inventory | **Accepted.** File-assignment table covers all 17 monolith functions, including `isTerminalPhase`/`checkLoopEscalation`/`handleJustTransitioned` → `index.ts`, and the `stateSummary` circular-dependency rationale |
| G5 | Should | Dispatcher return-value mapping (boolean \| undefined per branch) unpinned | **Accepted.** Return-mapping table added, verified line-by-line against the monolith — including the finding that step 6 (`handleDisputeReview`) is a **dead guard**: the function unconditionally returns `handled: false`, so the dispatcher's guard never fires |

Plus (from review): auto-generated error-handling finding rejected as template artifact — spec now carries the **inverse instruction** (explicit "no new error handling" constraint). "No behavioral change" redefined: full `npm test` (incl. golden + e2e) + the two flag-preservation spot-asserts, both now pinned.

## Phase 0 follow-up findings (R1–R4 — consistency fixes, no runtime impact)

| # | Issue | Disposition |
|---|-------|-------------|
| R1 | Internal contradiction: "matching the existing stub interfaces" while the pinned dispatcher passes bare `state.current` to negotiate, whose stub takes the `{ current }` wrapper | **Accepted (verified: `negotiate.ts:12`).** Stub adjustment pinned: `NegotiateHandlerInput.state: LoopState` (bare) |
| R2 | Pinned `handleDisputeFix({ state, pi, lang, ctx })` omits `debug`, which the stub requires — won't type-check | **Accepted (verified: monolith dispute fix has zero debug calls).** Stub adjustment pinned: `debug?` optional in `DisputeHandlerInput` |
| R3 | Test Strategy put the `lastGateResult` assertion in gate-transition.test.ts, but the assignment lives in the dispatcher | **Accepted.** Assertion moved to `index.test.ts` row |
| R4 | File-assignment table claimed completeness but omitted `getLang` | **Accepted, then corrected (round 3):** original fix claimed the `events.ts` copy "keeps existing callers from other delegators" — **false premise**, verified against the file: `getLang` has exactly one caller (`eventAgentSettled`, line 91); the 02/03 delegators already resolve lang inside their modules. Corrected: inlined into step 2 AND deleted in this spec. Corollaries of the same class folded in: (1) `stateSummary`'s events.ts copy is also dead after 04 (both call sites move out) — deletion now pinned; (2) six import lines in events.ts lose all users — new Scope line pins the final file shape (4 delegators + `EventCtx` + types), with an explicit acceptance criterion since no test gate catches unused imports |
