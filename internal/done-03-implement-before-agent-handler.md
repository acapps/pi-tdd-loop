# Implement before_agent_start prompt injection handler

## Problem

`src/events/before-agent.ts` has a stub (`handleBeforeAgent` returns `undefined`). The real logic lives in `src/events.ts` as `eventBeforeAgentStart()` and its helpers (`buildPhasePrompt`, `buildReviewPrompt`, `buildTesterPrompt`, `buildNegotiatePrompt`, `buildWriterPrompt`, `buildCleanerPrompt`, `buildDisputeFixPrompt`, `buildContextMessage`).

## Target

Migrate all phase-specific prompt building into `src/events/before-agent.ts`. The module receives the current state + base system prompt and returns the appropriate prompt injection (or `undefined` for non-injecting phases).

## Interface

```typescript
// before-agent.ts (matches existing stub)
export function handleBeforeAgent(input: {
  state: { current: LoopState };
  pi: ExtensionAPI;      // needed by dispute-fix branch (pi.appendEntry)
  debug: (msg: string) => void;
  systemPrompt: string;
}): { message: Record<string, unknown>; systemPrompt: string } | undefined;
```

**F2 fix — language dependency:** The module imports `getLanguageConfig` from `../../languages` and resolves `lang = getLanguageConfig(state.current.language)` at **step 2 of the Entry order** — after the idle short-circuit, before the phase dispatch (R4, S1: monolith parity — the delegator checks idle *before* `buildPhasePrompt` resolves lang, so a corrupted `state.language` throws `Language not available: …` for every phase that reaches dispatch — including done/escalated — while **idle + corrupted → `undefined`, no throw**. Preserve both sides of this asymmetry; do not short-circuit terminal phases first, and do not resolve lang before the idle check). Prompt strings interpolate `lang.testFilePattern` / `lang.sourceFilePattern` for phases A, B, C. Phases review and negotiate do not use `lang` (note: `buildReviewPrompt` takes a `lang` param in the source but never uses it — dead parameter, internal detail).

## Behavior

### Entry order (S1 — pinned)

The entry performs exactly this sequence, in this order (wrapper scope at the boundary):

```typescript
// 1. idle short-circuit — BEFORE any lang resolution
if (state.current.phase === "idle") return undefined;
// 2. lang resolution — may throw on corrupted state (R4)
const lang = getLanguageConfig(state.current.language);
// 3. dispatch per the Phase dispatch table below (unwrap: const s = state.current)
```

Parity pin (verified against `eventBeforeAgentStart` → `buildPhasePrompt`): the monolith pre-checks idle in the delegator *before* `buildPhasePrompt` calls `getLang`. Therefore **idle + corrupted language → `undefined`, no throw**; **done/escalated + corrupted language → throws** (reaches step 2). A writer who resolves lang before the idle check silently diverges on idle + corrupted — the F2 "at the top of the entry" wording permitted exactly that, now closed.

### Scope convention (R1)

The module entry receives the wrapper: `handleBeforeAgent({ state: { current }, … })`. Unwrap once at the top: `const s = state.current;`. **All internal helpers take the bare `LoopState`** — normalizing the monolith's mixed signatures (`buildNegotiatePrompt`/`buildCleanerPrompt` already take bare; `buildWriterPrompt`/`buildDisputeFixPrompt` took `{ current }` and become bare too).

In this section and all tables below, `state` means **the bare phase-state** in helper scope — `state.round` is the current round, `state.awaitDisputeFix` is the flag. Never write `state.current.X` in helper code; the wrapper exists only at the entry boundary.

### Phase dispatch (each phase maps to exactly one row — partition, not an ordered chain)

| Phase | Result |
|---|---|
| `idle` | `undefined` — no injection (monolith checks this before building anything) |
| `review` | Reviewer prompt |
| `A` | Tester prompt |
| `negotiate` | Writer prompt if `state.round % 2 === 1` (odd = Writer's turn), else Tester prompt |
| `B` | Dispute-fix prompt if `state.awaitDisputeFix`, else Writer prompt |
| `C` | Cleaner prompt |
| `done`, `escalated` | `undefined` — terminal phases inject nothing (F3: explicit, not fall-through) |
| any other value | `undefined` — keep the `default` branch (R5: `Phase` is a closed union, but session state restored from JSONL is unvalidated; the monolith's `default: return undefined` is defensive — preserve it) |

### Debug call sites (F6 — preserve verbatim; helper scope per Scope convention)

| Branch | debug call |
|---|---|
| negotiate, odd round | `` debug(`Negotiate round ${state.round} (Writer)`) `` |
| negotiate, even round | `` debug(`Negotiate round ${state.round} (Tester)`) `` |
| B, normal Writer turn | `` debug(`Writer round ${state.round}`) `` |
| B, dispute fix | `` debug("Tester fixing test") `` |

No debug calls in review/A/C branches.

### Side effects (F1, R3 — dispute-fix branch only, exact order)

`buildDisputeFixPrompt` performs exactly three steps, in this order, before building the prompt (helper scope):

```typescript
debug("Tester fixing test");               // 1. debug — see Debug table
state.awaitDisputeFix = false;               // 2. clear the flag at prompt-build time
pi.appendEntry("loop-state", { ...state });  // 3. persist snapshot AFTER the clear
```

The persisted snapshot therefore contains `awaitDisputeFix: false`. Preserve the order — a session reload mid-dispute-fix must see the cleared flag. **All other branches are side-effect-free** (pure prompt building; no state writes, no session entries). The existing "stub does not mutate state" test in the suite must be reworked accordingly (see Test Strategy).

### Prompt inventory (verbatim — strings are behavior, do not rephrase)

All `message` values are wrapped by `buildContextMessage(content)` → `{ customType: "loop-context", content, display: false }`.

| Phase | message `content` | `systemPrompt` |
|---|---|---|
| review | `REVIEWER (Phase 0). Review the spec for ambiguities and missing edge cases.\nUse negotiate_propose with plan='approve' to proceed, or provide feedback.\nNo file writes.` | `${systemPrompt}\n\nPhase 0 (Reviewer). Review the spec. Use negotiate_propose. No file writes.` |
| A | `TESTER. Write contract: ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs.\nStop when done.` | `${systemPrompt}\n\nPhase A (Tester). Write ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs.` |
| negotiate (odd) | `WRITER (negotiate). Use negotiate_propose. No file writes.\nplan='agree' if tests match spec. plan='your approach' otherwise.` | `${systemPrompt}\n\nNegotiation. Use negotiate_propose tool. No file writes.` |
| negotiate (even) | `TESTER (negotiate). Use negotiate_review. No file writes.\n'approve' if accept. feedback otherwise.` | `${systemPrompt}\n\nNegotiation. Use negotiate_review tool. No file writes.` |
| B (normal) | `WRITER. Write ${lang.sourceFilePattern} to pass ${lang.testFilePattern}.\nPreserve stub signatures. Dispute wrong tests via negotiate_propose.\nWhen done, stop producing tool calls.` | `${systemPrompt}\n\nPhase B (Writer), round ${state.round}. Write ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.` |

| B (dispute fix) | `You are the TESTER (dispute fix). You conceded that the Writer's dispute was valid.\nFix the test(s) to match the spec.\nAfter fixing, stop producing tool calls.` | `${systemPrompt}\n\nYou are in Phase B dispute fix (Tester). You may write test files.` |
| C | `CLEANER. Refactor for readability:\n- Return early. Extract helpers. Clear names.\nYou may only write ${lang.sourceFilePattern}. Do not modify ${lang.testFilePattern}. All tests must pass.` | `${systemPrompt}\n\nPhase C (Cleaner), round ${state.round}. Refactor ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.` |

R1 note: the monolith's `buildWriterPrompt` wrote `state.current.round` in wrapper scope; in the module's bare scope this is `state.round`. Rendered output is identical — the scope convention is what makes the table single-scope.

## Changes

1. Implement `handleBeforeAgent` with the dispatch table above; move helpers into `before-agent.ts`: `buildReviewPrompt`, `buildTesterPrompt`, `buildNegotiatePrompt`, `buildWriterPrompt`, `buildCleanerPrompt`, `buildDisputeFixPrompt`, `buildContextMessage`, `buildPhasePrompt`. Per the Scope convention, all helpers take the bare `LoopState`; `buildWriterPrompt`/`buildDisputeFixPrompt` signatures normalize from `{ current: LoopState }` to `LoopState` (behavior identical — same object reference is passed)
2. **F5 fix — delegator keeps raw-event extraction.** `events.ts` delegator:
   ```typescript
   export function eventBeforeAgentStart(state, pi, debug) {
     return async (event) => {
       const evt = event as { systemPrompt: string };
       return handleBeforeAgent({ state, pi, debug, systemPrompt: evt.systemPrompt });
     };
   }
   ```
   (The monolith's idle pre-check moves into the module — `undefined` either way, identical result.)
3. Remove the moved helpers from `events.ts`
4. **F4 fix — rewrite `test/events/before-agent.test.ts` stub assertions** (see Test Strategy)

## Test Strategy (F4)

`test/events/before-agent.test.ts` currently asserts the stub returns `undefined` for 5 phases — those assertions **fail** once implemented. Rewrite:

- **Keep:** no-throw tests (all 8 phases, empty systemPrompt, undefined pi, dispute-mode)
- **Keep:** idle → `undefined`
- **Rewrite 5 "stub returns undefined" tests** → assert exact `message.content` and `systemPrompt` per the Prompt inventory (Go language config: `*.go` / `*_test.go` patterns)
- **Add:** negotiate round parity — round 1 → Writer prompt, round 2 → Tester prompt (canonical set — same rounds as the R1 resolved-string criterion)
- **Add:** entry order parity (S1) — idle + corrupted language (`language: "bogus" as any`) → returns `undefined` without throwing (`getLanguageConfig` never reached); done + corrupted language → throws `Language not available: …` (R4 pin)
- **Add:** done/escalated → `undefined` (F3 explicit)
- **Add:** dispute-fix side effects — `awaitDisputeFix` cleared, `pi.appendEntry` called once with snapshot containing `awaitDisputeFix: false`, dispute-fix prompt returned
- **Rework** "stub does not mutate state" → mutation contract: normal phases mutate nothing; B+dispute-fix clears exactly `awaitDisputeFix`

## Acceptance Criteria

- [ ] Dispatch table rows enforced; done/escalated explicitly return `undefined` (F3); unknown phase values → `undefined` via kept `default` branch (R5)
- [ ] Negotiate alternates Writer/Tester on round parity
- [ ] **Resolved round strings (R1):** tests assert concrete rendered output — round 1 negotiate → `"Negotiate round 1 (Writer)"`, round 2 → `"Negotiate round 2 (Tester)"`, C round 2 → systemPrompt contains `"Phase C (Cleaner), round 2"`, B round 1 → `"Phase B (Writer), round 1"`. Catches scope regressions the "verbatim" criterion alone would bless
- [ ] Entry order pinned (S1): idle short-circuit before lang resolution — idle + corrupted language → `undefined` (no throw); done/escalated + corrupted → throw
- [ ] B dispute-fix branch: exact order debug → clear flag → persist snapshot (R3); prompt returned
- [ ] No side effects in any other branch
- [ ] Debug call sites match the table verbatim (F6)
- [ ] Prompt strings match the inventory verbatim in bare-state scope — strings are behavior
- [ ] `getLanguageConfig` resolved at step 2 of the Entry order — after the idle short-circuit, before dispatch (S1, R2, R4); A/B/C patterns interpolated (F2); both sides of the throw asymmetry preserved (idle → no throw, terminal → throw)
- [ ] `test/events/before-agent.test.ts` rewritten per Test Strategy; **full suite passes** — the 5 stub-undefined assertions are replaced, not deleted (F4)

## Phase 0 review findings (verdict: rejected 3 auto-generated, 6 grounded raised)

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| F1 | Must-fix | Dispute-fix branch side effects undocumented: `awaitDisputeFix = false` mutation + `pi.appendEntry("loop-state", …)` | **Accepted.** Side Effects section added with ordering (persist after clear, snapshot shows `false`); acceptance criteria added |
| F2 | Must-fix | Language dependency omitted — prompts interpolate `lang.testFilePattern`/`sourceFilePattern` | **Accepted.** `getLanguageConfig` import + per-call resolution specified; which phases use which fields noted (incl. review's dead `lang` param) |
| F3 | Should-fix | done/escalated hit `default: return undefined` — should be explicit | **Accepted.** Dispatch table lists them as explicit terminal rows |
| F4 | Conflict | "All existing tests pass" is false — `test/events/before-agent.test.ts` asserts stub `undefined` for 5 phases | **Accepted (verified).** 5 assertions fail once implemented. Test Strategy section added; acceptance criterion rewritten — assertions are replaced with real contract tests, not deleted |
| F5 | Minor | Delegator keeps raw-event extraction (`event.systemPrompt` cast) | **Accepted.** Delegator code shape in Changes |
| F6 | Minor | Preserve `debug()` call sites verbatim | **Accepted.** Debug table added |

Auto-generated findings disposition (by Reviewer): all rejected as boilerplate — no I/O error handling in this module, no type conflict, `handleBeforeAgent` takes an object input not a string. Agreed — no action.

## Round 2 review findings (R1–R6)

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| R1 | Must-fix | Verbatim tables mix helper-local scopes — monolith's negotiate/cleaner helpers take bare `LoopState` (`state.round`), writer helper takes wrapper (`state.current.round`); literal port in module scope renders `"round undefined"` and the verbatim criterion would bless it | **Accepted (verified in source).** Scope convention section added (unwrap once, all helpers bare `LoopState`); inventory normalized to single scope; `buildWriterPrompt`/`buildDisputeFixPrompt` signature normalization stated; new acceptance criterion asserts resolved strings at concrete rounds |
| R2 | Minor | Acceptance-criterion typo: `state.language` | **Accepted.** Now `state.current.language` at entry scope |
| R3 | Minor | Dispute-fix debug ordering unpinned | **Accepted.** Three-step sequence pinned: debug → clear flag → persist snapshot |
| R4 | Minor | `getLanguageConfig` throw parity unstated — monolith resolves lang before dispatch, so corrupted `state.language` throws even for done/escalated | **Accepted (verified: `getLanguageConfig` throws `Language not available: …`; `buildPhasePrompt` resolves lang before the switch).** Entry must resolve lang before dispatch; do not short-circuit terminal phases first |
| R5 | Minor | Unknown-phase behavior unstated | **Accepted.** `default` branch preserved — session state from JSONL is unvalidated; unknown value → `undefined` |
| R6 | Minor | "First match wins" is wrong for a phase partition | **Accepted.** Reworded: each phase maps to exactly one row |

## Round 3 review findings (S1, N1, N2)

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| S1 | Should-fix | Entry operation order ambiguous — monolith pre-checks idle in the delegator before any lang resolution (idle + corrupted → undefined, no throw), but F2's "at the top of the entry" + R4 (pinning only done/escalated) permits resolving lang on line 1 — silent divergence | **Accepted (verified: `eventBeforeAgentStart` checks idle before `buildPhasePrompt` runs `getLang`).** New Entry order section pins the exact 3-step sequence (idle → lang → dispatch); F2 paragraph now references it; asymmetry stated explicitly (idle + corrupted → no throw; terminal + corrupted → throw); new acceptance criterion + parity tests |
| N1 | Nit | Test Strategy uses rounds 1/2 for negotiate parity, R1 criterion uses 3/4 | **Accepted.** Harmonized to 1/2 (canonical: round 1 = Writer's first proposal per `round % 2 === 1`); R1 criterion updated |
| N2 | Nit | R1 note embedded mid-table in the Prompt inventory, breaking markdown rendering | **Accepted.** Moved below the table (after the C row) |
