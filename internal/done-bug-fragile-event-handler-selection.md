# bug-fragile-event-handler-selection

## Problem

Verified current state as of writing (code re-checked against the repo at `b9bd8db` after `bug-confirm-approval` merged; baseline: `npx tsc --noEmit` clean, `npx vitest run` → 37 files, 1128 passed / 12 skipped, ~15s):

**The test helper that selects a registered event handler by registration order (`handlers[0]`) broke the suite when a second, legitimate handler was registered for the same event — and the breakage was invisible to every test that used the helper, because the helper silently returned the *wrong* handler.**

1. **The helper selects by index, not by identity.** `test/extension.test.ts:76-81`:

   ```ts
   function findEventHandler(api: TestAPI, event: string) {
     const handlers = api.eventHandlers.get(event);
     expect(handlers).toBeDefined();
     expect(handlers!.length).toBeGreaterThan(0);
     return handlers![0];
   }
   ```

   `api.eventHandlers` (mock, `test/__mocks__/@earendil-works/pi-coding-agent.ts:128-131`) is a `Map<string, handler[]>` appended to in registration order. `handlers![0]` is "the first handler registered for this event" — a positional assumption, not a named one.
2. **The SDK supports multiple handlers per event, and the extension now uses that.** `pi.on("tool_call", ...)` is called **twice** in `index.ts`: line 83 (path enforcement, `Ev.eventToolCall`) and line 97 (the repeated-call breaker, inside `registerLoopBreaker`, `index.ts:96-103`). The second registration is deliberate and pinned by the prior spec (`internal/done-bug-negotiate-confirm-approval-loop.md`, Behavior §4: "index.ts gains a **second** tool_call registration … Do not consolidate the two handlers"). `agent_settled` is also registered twice (line 80 main handler, line 101 counter-reset). So `handlers[0]` for `tool_call` is the path-enforcement handler *only because of the order in `index.ts`* — swap the two registrations and every path-enforcement test silently exercises the breaker.
3. **Observed breakage (runtime evidence: session `01a077b8-6c6c-702a-879e-2479ea23eba3`, the implementation run of `bug-confirm-approval`, Phase C):** during that run the breaker handler was registered *before* the main `agent_settled` handler, so `findEventHandler(api, "agent_settled")` returned the counter-reset closure — a handler that ignores its arguments and returns `undefined`. The affected tests then spent ~100 iterations of the debugging agent (grep/cat ping-pong, repeated `test/dbg.test.ts` probes) chasing "why does the settled handler do nothing" — a class of failure that is undiagnosable from the test output alone, because the assertions read as "the feature does not fire," not "the wrong handler was called."
4. **The helper's own assertion hides the multiplicity.** `expect(handlers!.length).toBeGreaterThan(0)` passes for 1, 2, or 10 handlers. No test in `test/extension.test.ts` asserts *how many* handlers are registered for `tool_call` or `agent_settled` (verified: `rg 'tool_call' test/extension.test.ts` shows only `findEventHandler` usages and the event-presence check at line 118, which asserts `eventHandlers.has(event)` — presence, not count or identity). The registration-surface test pins `index.ts` *text* (`test/events/registration-surface.test.ts:275-276` asserts the two `pi.on` lines are present) but pins nothing about the mock's array order semantics.
5. **Every `findEventHandler` call site inherits the assumption.** 15+ call sites in `test/extension.test.ts` (lines 1163, 1174, 1196, 1209, 1224, 1239, 1253, 1281, 1302, 1318, 1334, 1348, 1404, 1410, 1436, 1472, 1478, 1514, 1520 — session_start, before_agent_start, tool_call, agent_settled) all receive "whatever was registered first" with no name. The next feature that registers a second handler for any of these events (a metrics collector, a second guard, a reset hook) will silently re-point all of them.

**Why this is a loop bug, not a test nit:** the loop's own implementation run was stalled for ~1 hour by this helper (finding 3). The helper is the test-side mirror of the extension's registration surface: the extension is allowed by the SDK to register N handlers per event, but the test suite can only observe handler #1. Any future spec that adds a handler (the prior spec's breaker is the first instance) must either remember to update every affected test or accept silent mis-selection. That is a maintenance trap with a demonstrated cost.

## Target

After this fix: tests select event handlers **by identity** (a stable, named discriminator), not by registration order. `findEventHandler` remains the default selection helper but resolves to the *named* handler for the event; when multiple handlers are registered, the helper returns the one the test named, and a test that needs the *other* handler names it explicitly. Registration-order assumptions disappear from the suite: reordering `pi.on` calls in `index.ts` cannot change which handler any test exercises. A registration-count assertion per multi-handler event makes future multiplicity a visible, asserted fact instead of a silent one.

## Interface

Test-only change; no production code, no signatures, no persisted state.

- `test/extension.test.ts` — `findEventHandler` gains an optional second argument:

  ```ts
  function findEventHandler(api: TestAPI, event: string, which?: number | "first" | "last"): (…args: any[]) => any
  ```

  **Discriminator decision (pinned):** the mock captures handlers as bare functions (`Map<string, ((...args: any[]) => any)[]>`), and the extension's handler factories return anonymous closures — there is no name to match on without changing the mock's capture shape or the production registration calls. Two viable designs were considered:
  - **(a) Index with named semantics** (`which?: number | "first" | "last"`, default `"first"`): minimal, but still order-based — it documents the assumption instead of removing it. Rejected as the primary fix because it does not close finding 2's failure mode (a reorder still silently re-points a test that says `"first"`).
  - **(b) Tagged capture (rejected):** the mock's `on()` wraps each registered handler in a proxy that records a registration *tag*, and the extension's registration sites in `index.ts` are the only production change: each `pi.on(...)` call site is wrapped so the factory returns a tagged handler. Rejected — it requires touching `index.ts` (production) for a test concern, which the Scope lines below avoid.
  - **(c) Predicate selection (chosen):** `findEventHandler(api, event, predicate?: (h) => boolean)` — the test passes a *predicate* that identifies the handler (chosen implementation: source-needle match, Behavior §2 — the behavior-probe variant was considered and rejected there: a probe runs the real handler against the test's fixture state and mutates it). No production change, no mock change, order-independent: the first handler for which the predicate is true wins. Default (no predicate) keeps `handlers[0]` for the single-handler events that are unaffected, **but** the default path gains a multiplicity guard: if `handlers.length > 1` and no predicate is given, the helper throws with a message naming the event and the count — so any future multi-handler event forces an explicit predicate instead of silently taking #1. This converts the silent mis-selection (finding 3) into a loud, immediate test failure that says exactly what is ambiguous.

  Pinned signature:

  ```ts
  function findEventHandler(
    api: TestAPI,
    event: string,
    predicate?: (h: (...args: any[]) => any) => boolean,
  ): (...args: any[]) => any
  ```

  Behavior: (1) `handlers` undefined → throw (as today, "no handler for event X"). (2) `predicate` given → return the first handler for which `predicate(h)` is true; if none match, throw naming the event and the predicate's source line is not required — the throw message is `no handler for <event> matched the predicate (of <n> registered)`. (3) no predicate, `handlers.length === 1` → return it (as today). (4) no predicate, `handlers.length > 1` → **throw** `findEventHandler("<event>"): <n> handlers registered, pass a predicate to disambiguate`.

- `test/__mocks__/@earendil-works/pi-coding-agent.ts` — **untouched** (the `Map<string, handler[]>` shape stays; the predicate approach needs no mock change).
- No production files touched. `index.ts` registration order stays as-is; the suite becomes order-independent instead.

**Persisted state:** none.

## Behavior

### 1. `findEventHandler` decision table (test/extension.test.ts)

First-match-wins evaluation order:

| # | Condition | Effect |
|---|---|---|
| 1 | `api.eventHandlers.get(event)` is undefined | throw `no handler registered for <event>` (today's `toBeDefined` expectation, promoted to a throw so the message names the event) |
| 2 | predicate given AND some handler matches | return the first matching handler |
| 3 | predicate given AND no handler matches | throw `no handler for <event> matched the predicate (of <n> registered)` |
| 4 | no predicate AND exactly 1 handler | return it (unchanged behavior for single-handler events) |
| 5 | no predicate AND >1 handler | throw `findEventHandler("<event>"): <n> handlers registered, pass a predicate to disambiguate` |

### 2. Call-site disposition (test/extension.test.ts)

Every existing `findEventHandler` call site is classified:

- **Single-handler events (no change needed, pass through row 4):** `session_start` (1 registration, `index.ts:81`) — call sites at lines 1163, 1174, 1404, 1472, 1514, 1559; `before_agent_start` (1, `index.ts:82`) — call sites at lines 1196, 1209, 1224, 1239, 1253. All stay as 2-arg calls.
- **Multi-handler events (row 5 now throws → each call site gains a predicate).** `tool_call` call sites — lines 1281, 1302, 1318, 1334, 1348, 1410 (the path-enforcement describe block + the escalated-mode test at 1410) — each gains `isMainHandler`. `agent_settled` call sites — lines 1436, 1478, 1520, 1565, 1576, 1595, 1616 (the phase-transitions describe block, 7 sites) — each gains `isMainHandler` (these tests exercise the main settle pipeline, not the reset closure). The mock captures the exact handler functions the extension registered, and the test cannot compare closures across `state` instances (each `buildTestAPI()` + `extensionFactory(api)` builds fresh closures), so the predicate inspects the handler's source text:
    - the **breaker** handler's source contains `"blockRepeatedCall"` — verified under the installed toolchain: `createRepeatedToolCallHandler` (`src/events/tool-call/index.ts`) returns an arrow whose body names `blockRepeatedCall` and `REPEATED_CALL_LIMIT`. (The user-notice text `"Loop breaker: …"` is a module-level constant referenced by identifier, so it is *not* in the closure source — verified by running `handler.toString()`; the needle is the function name, not the notice.)
    - the **`agent_settled` reset** handler's source contains `"resetCallCounters"` — verified: `index.ts:101-103` registers `() => { resetCallCounters(); }`, an arrow whose body names the identifier.
    - the **main** handlers' source contains neither needle — verified by grep over the main handlers' source files: `blockRepeatedCall` appears only in `src/events/tool-call/index.ts`; `resetCallCounters` appears in `src/events/tool-call/index.ts` (definition) and `index.ts` (the two reset closures) — neither appears in `src/events/agent-settled/index.ts`, `src/events/tool-call.ts`, `src/events/session-start.ts`, or `src/events/before-agent.ts`. So `isMainHandler` matches exactly the main handler for each multi-handler event. (The `turn_start` reset handler at `index.ts:98-100` also contains `"resetCallCounters"`, but `turn_start` is single-registered, so `isResetHandler` is never applied to it; pinned: the needle's uniqueness is per-event, not global.)

    The behavior-probe variant ("select the handler that blocks `*_test.go` writes") was considered and rejected: a probe runs the real handler against the test's already-configured fixture state and mutates loop state, corrupting the test it serves.

    Pinned predicates (defined once in `test/extension.test.ts` next to the helper):

    ```ts
    const isBreakerHandler = (h: any) => h.toString().includes("blockRepeatedCall");
    const isResetHandler = (h: any) => h.toString().includes("resetCallCounters");
    // default for multi-handler events where the test wants the MAIN handler:
    const isMainHandler = (h: any) => !isBreakerHandler(h) && !isResetHandler(h);
    ```

    `toString()`-based selection is a test-only heuristic; it is pinned as *adequate and documented*, not robust: a refactoring that renames `blockRepeatedCall` or inlines `resetCallCounters` breaks the matching predicate loudly (row 3 throw naming the event, or `isMainHandler` matching nothing), which is the intended failure mode — loud, not silent. The alternative (mock tags) was rejected in Interface because it touches the mock's capture contract for every consumer.

### 3. Registration-count assertions (new)

New tests in the "extension factory" describe block (`test/extension.test.ts`, beside the existing "registers all 4 event handlers" test at line 114):

- `tool_call` has exactly 2 registered handlers; `agent_settled` has exactly 2; `turn_start` has exactly 1; `session_start` and `before_agent_start` have exactly 1 each. Verbatim assertion shape: `expect(api.eventHandlers.get("tool_call")!.length).toBe(2)`.
- Order assertion (pinned as *documented, not depended upon*): the path-enforcement handler is registered before the breaker for `tool_call` — asserted with `isBreakerHandler` on index 1. This test exists so a future reorder is a *visible* failure of a named test, not a silent re-pointing; it is the only place in the suite where order is asserted, and its failure message says exactly which registration moved.

### 4. Quirks list

- **`toString()`-based handler identification is fragile to refactors** (minification is not a concern — vitest runs unminified source; closure-extracted constants are). Current behavior, do not "fix" by adding mock tags without a spec — the tag design is the documented alternative (Interface) and its cost (mock contract change) is the reason it was not chosen.
- **The default (no-predicate) path still returns `handlers[0]` for single-handler events** — order-based, but order is irrelevant when there is one handler. Pinned, not a bug.

### 5. Intended shifts

- Any *future* spec that registers a second+ handler for `session_start`, `before_agent_start`, or `turn_start` will find its new handler invisible to existing tests until the tests add a predicate — the row-5 throw makes that a build-breaking, named failure instead of the silent mis-selection of finding 3. This is the intended shift: multiplicity becomes a loud, asserted fact.

## Inventory

- Files: `test/extension.test.ts` (helper rewrite + 3 predicate constants + 13 call-site predicate additions + 2 new registration-count tests) — **the only file touched**.
- Imports: `test/extension.test.ts` gains none (the predicates are local; no `Ev` import is needed under the `toString` design — verified: the needles `"Loop breaker"` and `"resetCallCounters"` need no import to grep for).
- Exports: none (test file, no exports).
- Untouched: `test/__mocks__/@earendil-works/pi-coding-agent.ts` (capture shape unchanged), `index.ts` (registration order and count unchanged — the count is now *asserted*, not changed), `test/events/registration-surface.test.ts` (its `ENTRY_SHA256` is over `index.ts`, which is untouched; its textual pins at lines 275-276 still match).

## Test Strategy

- Baseline: 1128 passed / 12 skipped (37 files), verified at `b9bd8db`.
- Per-test disposition in `test/extension.test.ts`:
  - All 6 `tool_call` path-enforcement call sites — **rewritten**: `findEventHandler(api, "tool_call")` → `findEventHandler(api, "tool_call", isMainHandler)` (the path-enforcement handler is the non-breaker one; `isMainHandler` excludes the breaker by needle).
  - All 7 `agent_settled` call sites (lines 1436, 1478, 1520, 1565, 1576, 1595, 1616) — **rewritten**: gain `isMainHandler`.
  - All 11 `session_start` / `before_agent_start` call sites (6 + 5) — kept unchanged (single-handler events, row 4).
  - "registers all 4 event handlers" (line 114) — kept; the new count tests sit beside it.
- New tests (in `test/extension.test.ts`):
  - The 5 registration-count assertions (Behavior §3) — one `it` per event or one `it` with 5 expects; pinned as one `it` named "registers the pinned handler counts per event" with 5 expects.
  - The order-documentation test (Behavior §3, second item).
  - Helper unit tests (new `describe("findEventHandler", …)` block, testing the helper directly with a hand-built `TestAPI`-shaped object): row 1 (no handlers → throw, message names the event); row 3 (predicate matches nothing → throw, message includes the count); row 5 (2 handlers, no predicate → throw, message includes the count and the word "predicate"); row 4 (1 handler, no predicate → returns it, identity check).
  - Regression pin (the bug): a test that registers two handlers for a dummy event, calls `findEventHandler` with no predicate, and asserts the throw — this test **fails against the pre-fix helper** (pre-fix: returns `handlers[0]`, no throw). The Tester verifies the flip by running the new test against the pre-fix helper body.
- Untouched: every other test file stays green by construction — the helper is local to `test/extension.test.ts` (verified: `rg 'findEventHandler' test/` → only `test/extension.test.ts`), so no other file's selection logic is affected. `test/events/tool-call-breaker.test.ts` builds its handler via `createRepeatedToolCallHandler` directly and never uses `findEventHandler` — unaffected.
- Live-toolchain rules: N/A — no real process spawns; the helper tests use a hand-built object, not even `createMockExtensionAPI` (CLAUDE.md TEST SPEED RULE).

## Scope lines

- `test/extension.test.ts`: rewritten `findEventHandler` (5-row decision table); added 3 predicate constants + 1 helper `describe` block; rewritten 13 call sites (6 tool_call + 7 agent_settled); added 2 tests (counts, order) + 4 helper unit tests + 1 regression pin.
- `test/__mocks__/@earendil-works/pi-coding-agent.ts`: untouched.
- `index.ts`: untouched.
- `test/events/registration-surface.test.ts`: untouched.

## Acceptance Criteria

- Full test run green: `npx vitest run` — 37 files, the baseline 1128 plus the new tests; `npx tsc --noEmit` clean (vitest does not type-check — the helper's `predicate` parameter is typed in the test file, which `tsc --noEmit` covers).
- Grep sweep (functional): `rg 'findEventHandler\(api, "(tool_call|agent_settled)"\)' test/extension.test.ts` → **0 hits** (every multi-handler call site now passes a predicate — the regex matches only the 2-arg form).
- Grep sweep (textual): `rg 'handlers!\[0\]|handlers\[0\]' test/extension.test.ts` → exactly 1 hit (inside the rewritten helper's row-4 return — the single remaining order-based return, pinned as row 4).
- Regression pin: the "no predicate + 2 handlers → throw" helper test fails against the pre-fix helper (the Tester checks out the pre-fix `findEventHandler` body and confirms the new test is red).
- Reorder proof (manual, named in the order-documentation test): moving the `registerLoopBreaker` call above `pi.on("tool_call", Ev.eventToolCall(...))` in `index.ts` makes exactly one named test fail (the order test) and *no* path-enforcement test change behavior — the Tester verifies this by making the swap on a scratch branch and running the suite; the swap is not committed.

## Dependencies

- None hard. The helper is local to `test/extension.test.ts`; the two-handler registrations it must coexist with landed in `b9bd8db` (`bug-confirm-approval`), which is merged — that is why the suite is green today only because the registration order happens to put the main handlers first.
- Soft: `internal/bug-loop-breaker-repetition-with-mutation.md` (open) touches `src/events/tool-call/index.ts`'s *key function*, not the registration — no shared lines with this spec; they can land in either order.

## Findings log

(empty — clean Phase 0 expected; one row per finding otherwise)
