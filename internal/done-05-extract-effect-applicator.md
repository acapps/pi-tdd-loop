# Extract effect-applicator into standalone module

## Problem

The effect-application family — `applyEffect()`, `handleRetryEffect()`, `handleAdvanceEffect()`, `handleDoneEffect()`, `handleEscalatedEffect()`, `buildRetryPrompt()`, `buildAdvancePrompt()` — lives in **`src/events/agent-settled/gate-transition.ts`** (moved there by spec 04's implementation; this spec was originally written against `src/events.ts`, which no longer contains them). The local effect-type aliases (`Effect`, `RetryEffect`, `AdvanceEffect`, `DoneEffect`, `EscalatedEffect`) exist there too.

`src/events/agent-settled/effect-applicator.ts` has stubs (`void x; return { applied: false }`), and its contract tests assert stub behavior. Spec 04's Note predicted this extraction would also **consolidate the two stub effect-union copies** — that consolidation is in scope here.

## Target

Move the whole effect family into `effect-applicator.ts` as verbatim ports, rewire `handleGateTransition` to call the module, and leave both files with zero dead code (Scope lines below).

## Interface (revised — B2, G6)

The stub is the target shape; these are the pinned adjustments:

```typescript
// effect-applicator.ts

// B2: return type is the stub's EffectResult — NOT bare boolean.
// (Stub module + contract tests both use { applied }.)
export interface EffectResult {
  applied: boolean;
}

// Consolidation (spec 04 Note): the stub's loose 5-variant `TransitionEffectType`
// is DELETED. EffectInput.effect uses the typed 6-variant union produced by
// T.computeTransition, via the same pattern gate-transition.ts uses:
import type * as T from "../../transitions";
type Effect = ReturnType<typeof T.computeTransition>["effect"];

export interface EffectInput {
  state: { current: LoopState };   // wrapper shape, kept (stub + tests)
  pi: ExtensionAPI;
  ctx: EventCtx;
  lang: LanguageConfig;
  debug: (msg: string) => void;
  effect: Effect;
  gateResult: GateResult;
}

export function applyEffect(input: EffectInput): EffectResult;
export function applyRetryEffect(input: EffectInput): EffectResult;
export function applyAdvanceEffect(input: EffectInput): EffectResult;
export function applyDoneEffect(input: EffectInput): EffectResult;
export function applyEscalatedEffect(input: EffectInput): EffectResult;

// G5: builders are EXPORTED — the fallback defaults (below) are only
// directly testable through an export.
export function buildRetryPrompt(promptType: string, lang: LanguageConfig, gateResult: GateResult): string;
export function buildAdvancePrompt(promptType: string, state: LoopState, lang: LanguageConfig): string;
```

Note: `T.TransitionEffect` is not exported from transitions.ts, hence the `ReturnType` alias. The `import type * as T` is type-only (no runtime import needed in this module).

## Behavior (verbatim ports)

All `state` below = `input.state.current`. Ported code mutates this object exactly as the current gate-transition.ts code does (it receives the *new* state object from `computeTransition`, never the user's `state.current`).

### applyEffect (dispatcher) — B3

Switch on `effect.type`:
- `"noop"` → `return { applied: false }`
- `"retry"` → `return { applied: <applyRetryEffect result> }`
- `"advance"` → ditto for advance
- `"done"` → ditto for done
- `"escalated"` → ditto for escalated
- **`default: return { applied: false }`** — explicit, mirroring the current code line-for-line.

**Why a default and not a 6th case:** the typed union has 6 variants — `reprompt` is the 6th. `reprompt` is produced only by the negotiate branch (`computeNegotiateTransition`, consumed by `negotiate.ts`) and is **unreachable at runtime via the gate path** (the dispatcher routes negotiate to `handleNegotiateSettled`, never `handleGateTransition`). The default branch is the type-level guard; adding a `"reprompt"` case would be new behavior.

### applyRetryEffect

1. `state.turnsThisPhase = 1;`
2. **Dispute branch (G2 — early return, exact code):**
   ```typescript
   if (state.awaitDisputeReview) {
     state.awaitDisputeReview = false;
     debug(`Dispute review → retry with prompt`);
     pi.sendUserMessage(GP.promptWriterDispute(state.lastProposal), { triggerTurn: true });
     return { applied: true };
   }
   ```
   `GP.promptWriterDispute` takes `state.lastProposal`. The branch **early-returns before** the status/notify/prompt path — `ctx.ui.setStatus` is NOT called on this path. This is the one place `awaitDisputeReview` is cleared (spec 04's flag-preservation invariant depends on it).
3. `debug(`Retry ${effect.phase} round ${effect.round}`);`
4. `ctx.ui.setStatus("loop", effect.status);`
5. **Conditional notify (G3):** `if (effect.notify) { ctx.ui.notify(effect.notify, effect.level || "info"); }` — `notify` is optional in the type; `level` falls back to `"info"`.
6. **Conditional prompt:** `if (effect.prompt) { const prompt = buildRetryPrompt(effect.prompt, lang, gateResult); pi.sendUserMessage(prompt, { triggerTurn: true }); }`
7. `return { applied: true };`

### applyAdvanceEffect

1. `state.turnsThisPhase = 1;`
2. `debug(`Advance → ${effect.phase}`);`
3. `ctx.ui.notify(effect.notify, "info");` — **unconditional** (`notify` is required on advance) — contrast with retry's conditional notify.
4. `ctx.ui.setStatus("loop", effect.status);`
5. `if (effect.prompt) { const prompt = buildAdvancePrompt(effect.prompt, state, lang); pi.sendUserMessage(prompt, { triggerTurn: true }); }`
6. `return { applied: true };`

### applyDoneEffect

1. `state.turnsThisPhase = 1;`
2. `debug(`Done`);`
3. `ctx.ui.notify(effect.notify, "info");` (unconditional)
4. `ctx.ui.setStatus("loop", effect.status);`
5. `return { applied: true };`

### applyEscalatedEffect

No state parameter used (current signature: `ctx`, `debug`, `effect` only — it never touches `input.state`).
1. `debug(`Escalated (${effect.status})`);`
2. `ctx.ui.notify(effect.notify, "warning");` — warning level, the only one.
3. `ctx.ui.setStatus("loop", effect.status);`
4. `return { applied: true };`

### buildRetryPrompt (G1 — fallback pinned)

Maps `effect.prompt` key to the language prompt; `summary = formatFailures(gateResult.failures)`, `count = failures.length`:

| Key | Prompt |
|---|---|
| `RETRY_PROMPTS.TESTER_COMPILE_RETRY` | `lang.prompts.promptTesterCompileRetry(gateResult.compileError)` |
| `RETRY_PROMPTS.TESTER_DISPUTE_FIX_COMPILE_FAIL` | `lang.prompts.promptTesterCompileRetry(gateResult.compileError)` |
| `RETRY_PROMPTS.WRITER_PHASE_B_RETRY` | `lang.prompts.promptWriterPhaseBContinue(summary, count)` |
| `RETRY_PROMPTS.WRITER_DISPUTE_FIX_INCOMPLETE` | `lang.prompts.promptWriterPhaseBContinue(summary, count)` |
| `RETRY_PROMPTS.CLEANER_RETRY` | `lang.prompts.promptCleanerRetry(summary, count)` |
| **`default`** | **`return "Fix the issues and try again.";`** — verbatim fallback, a hardcoded string in the module (not a lang prompt) |

### buildAdvancePrompt (G1 — fallback pinned)

| Key | Prompt |
|---|---|
| `ADVANCE_PROMPTS.WRITER_NEGOTIATE` | `GP.promptWriterNegotiate(state.specPath, lang.testFilePattern)` |
| `ADVANCE_PROMPTS.CLEANER_PHASE_C` | `lang.prompts.promptCleanerPhaseC()` |
| **`default`** | **`return promptType;`** — verbatim fallback: the raw key string is sent as the prompt. Looks odd; is the current behavior; do not "fix" it. |

## Debug strings (G4 — preserve verbatim)

| Site | String |
|---|---|
| retry (normal path) | `` `Retry ${effect.phase} round ${effect.round}` `` |
| retry (dispute branch) | `Dispute review → retry with prompt` |
| advance | `` `Advance → ${effect.phase}` `` |
| done | `Done` |
| escalated | `` `Escalated (${effect.status})` `` |

## Call-site wiring in gate-transition.ts (G6)

Replace the inline call with (wrapper shape per `EffectInput.state: { current }` — the call site does the wrapping):

```typescript
const { applied } = applyEffect({ state: { current: newState }, pi, ctx, lang, debug, effect, gateResult });
return { state: newState, gateResult, applied };
```

(Replaces: `const applied = applyEffect(newState, pi, ctx, lang, debug, effect, gateResult);` — the 7-arg position call becomes the object-shape call; `GateHandlerOutput` unchanged.)

## Scope lines (final shape of both files)

**gate-transition.ts after this spec:**
- Deleted: all 7 effect functions; local type aliases `Effect`, `RetryEffect`, `AdvanceEffect`, `DoneEffect`, `EscalatedEffect` (their only users were the moved functions); imports `GP`, `RETRY_PROMPTS`/`ADVANCE_PROMPTS`, `formatFailures` (keep `runGates`)
- Kept: `GateHandlerInput`/`GateHandlerOutput`, `stateSummary`, `logGateResult`, `handleGateTransition`, imports `runGates`, `T`, new `applyEffect` from `./effect-applicator`

**effect-applicator.ts after this spec:**
- Deleted: the loose 5-variant `TransitionEffectType` union (consolidated per spec 04 Note); all `void x;` stub bodies
- Kept: `EffectInput` (with `effect: Effect`), `EffectResult`
- Added: the 5 `apply*` functions (real ports), `buildRetryPrompt` + `buildAdvancePrompt` (exported), `type Effect` alias, imports `GP`, `T` (type-only), `RETRY_PROMPTS`/`ADVANCE_PROMPTS`, `formatFailures`

No test gate catches unused imports/aliases (no type-check in `npm test`) — the Scope lines are enforced by inspection/`tsc --noEmit`, same as spec 04.

## Constraints

- **No new error handling.** The current code has no try/catch; the port must not add any. (This is why two stub-era null-tolerance tests are deleted, not inverted — see Test Strategy.)
- **No behavioral change** = full `npm test` green (incl. golden + e2e).

## Test Strategy (B4 — "all existing tests pass" is false)

Baseline: `test/events/agent-settled/effect-applicator.test.ts` passes 35/35 against the stubs. After a faithful port, **11 fail**. Disposition per test:

| Test group | Count | Disposition |
|---|---|---|
| "returns applied: false by default (stub)" — retry/advance/done/escalated | 4 | **Rewrite**: assert `applied: true` (the real result for those effects) |
| "returns applied: false by default (stub)" — dispatcher, `effect: { type: "noop" }` | 1 | Keep, rename — noop genuinely returns `applied: false` |
| "resets turnsThisPhase to 1 (spec requirement)" | 3 | **Rewrite**: each currently asserts `applied).toBe(false) // stub` — the assertion contradicts the test's own title. Assert `applied: true` AND `state.current.turnsThisPhase === 1` (the original intent) |
| "stub does not mutate state" — retry, advance (assert `turnsThisPhase` unchanged) | 2 | **Rewrite (inverted)**: the port *does* change it — assert `turnsThisPhase === 1` |
| "stub does not mutate state" — done, escalated (assert only `phase` unchanged) | 2 | Keep, rename — narrow invariant is genuinely true (port doesn't touch `phase`); the name "stub does not mutate" is stale |
| "handles null ctx gracefully" — done | 1 | **Delete** — the faithful port throws (no error handling added). The test asserted stub tolerance, not behavior |
| "handles null ctx gracefully" — escalated | 1 | **Delete** — same |
| "handles null pi gracefully" — escalated | 1 | Keep — escalated never uses `pi`, genuinely no-throw |
| "handles null gateResult/ctx/pi gracefully" — dispatcher (noop effect) | 3 | Keep — noop path touches none of them |
| All no-throw "dispatches/handles" tests with mocks | 15 | Keep — real ports don't throw with mocks |
| "output type contract: EffectResult has applied field" | 1 | Keep |

**New tests to add** (for the newly pinned behavior):
1. **Fallback defaults** (G1): `buildRetryPrompt("unknown_key", ...)` → `"Fix the issues and try again."`; `buildAdvancePrompt("some_key", ...)` → `"some_key"` (raw key returned)
2. **Dispute branch** (G2): `awaitDisputeReview: true` + non-empty `lastProposal` → flag cleared, `pi.sendUserMessage` called with `GP.promptWriterDispute(lastProposal)`, and `ctx.ui.setStatus` **not called** (early return skips it)
3. **Conditional notify** (G3): retry with `notify` undefined → `ui.notify` not called; `notify` set + `level` undefined → called with `"info"`
4. **Debug strings** (G4): all 5 verbatim via the `debug` mock
5. **Dispatcher default guard** (B3): `effect: { type: "reprompt", ... }` → `{ applied: false }`, no throw (type-level guard, unreachable at runtime via gate path)

## Acceptance Criteria

- [ ] All 7 functions in `effect-applicator.ts`; builders exported; returns are `EffectResult` (B2)
- [ ] `TransitionEffectType` loose union deleted; `EffectInput.effect` is the typed 6-variant `T` union (consolidation per spec 04 Note)
- [ ] Dispatcher: 5 cases + explicit `default: return { applied: false }` (B3); no `"reprompt"` case
- [ ] Dispute branch verbatim: flag clear + `GP.promptWriterDispute(state.lastProposal)` + early return before status (G2)
- [ ] Retry notify conditional with `level || "info"` fallback; advance/done/escalated notify unconditional (G3)
- [ ] Both builder fallback defaults verbatim — `"Fix the issues and try again."` and `return promptType` (G1)
- [ ] Debug strings match the table verbatim (G4)
- [ ] gate-transition.ts call site wired per G6; both Scope lines hold (no dead functions/aliases/imports in either file)
- [ ] `effect-applicator.test.ts` updated per Test Strategy (11 rewrites/deletions + 5 new test groups)
- [ ] `npm test` fully green (unit + golden + e2e)
- [ ] No new error handling added anywhere
- [ ] No behavioral change vs the current gate-transition.ts implementation

## Dependencies

Depends on #4 — **done** (04 is implemented; that implementation is what moved the functions into gate-transition.ts and makes this spec's source file correct).

## Phase 0 review findings (verdict: 4 blockers + 6 key gaps)

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| B1 | Blocking | Wrong source file — spec said `src/events.ts`; the functions are in `src/events/agent-settled/gate-transition.ts` (04's implementation moved them after this spec was written) | **Accepted (verified).** Problem + Changes corrected; "no behavioral change" baseline re-anchored to the current gate-transition.ts implementation |
| B2 | Blocking | Return type conflict — spec said `boolean`; stub module + contract tests use `EffectResult { applied }` | **Accepted (verified in stub + tests).** Interface re-pinned to `EffectResult`; all behavior sections emit `{ applied: … }` |
| B3 | Blocking | Missing `reprompt` variant — `T.computeTransition`'s union has 6 variants; a 5-case switch won't type-check | **Accepted (verified: `transitions.ts:15`; reprompt produced only by the negotiate branch, unreachable via gate path).** Explicit `default: return { applied: false }` pinned, mirroring current code; documented why no `"reprompt"` case (that would be new behavior) |
| B4 | Blocking | "All existing tests pass" unachievable — stub-era tests assert `applied: false`, no-mutation, and null-tolerance a faithful port violates | **Accepted (verified: 11 of 35 fail).** Test Strategy added with per-test disposition + 5 new test groups |
| G1 | Gap | Dropped fallback prompt defaults — both builders' `default` branches missing from the spec | **Accepted (verified: `"Fix the issues and try again."` and `return promptType` in gate-transition.ts).** Both pinned verbatim, with a note that the advance fallback's raw-key behavior is deliberate-as-is |
| G2 | Gap | Dispute-prompt function omitted — spec said "send dispute prompt" without naming the call | **Accepted.** Exact branch pinned: `GP.promptWriterDispute(state.lastProposal)`, flag clear, early return *before* status/notify (spot-assert added: `ui.setStatus` not called) |
| G3 | Gap | Conditional retry notify uncaught — spec said "send retry notification" unconditionally | **Accepted (verified: `if (effect.notify)` + `level \|\| "info"`; advance/done/escalated are unconditional).** Conditional/unconditional distinction pinned per handler |
| G4 | Gap | Debug output preservation missing — spec had no debug strings (unlike 03/04) | **Accepted.** 5-string debug table added |
| G5 | Gap | Builder exports unspecified — spec moved the builders but didn't say exported/private | **Accepted.** Pinned **exported**: the fallback defaults are only directly testable through an export |
| G6 | Gap | `{ current: newState }` wiring detail missing — the wrapper shape of `EffectInput.state` means the call site must wrap | **Accepted.** Call-site code pinned verbatim (object-shape call replacing the 7-arg position call) |
