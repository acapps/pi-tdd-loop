# Implement tool_call path enforcement handler

## Problem

`src/events/tool-call.ts` has a stub (`handleToolCall` returns `undefined`). The real logic lives in `src/events.ts` as `eventToolCall()` and its helpers (`shouldBlockDispute`, `shouldBlockNegotiate`, `shouldBlockPhaseA`, `checkPhaseBCWrite`, `isProjectPath`, `isWriteAction`, `extractToolPath`). Contract tests already exist in `test/events/tool-call.test.ts` (all no-throw + stub assertions).

## Target

Migrate the path enforcement logic into `src/events/tool-call.ts`. The module takes a structured input object and returns a block decision or undefined.

## Interface

```typescript
// tool-call.ts
export function handleToolCall(input: {
  state: { current: LoopState };
  pi: ExtensionAPI;
  debug: (msg: string) => void;
  toolName: string;
  path?: string;          // may be undefined/null for pathless tools (e.g. bash)
  ctx: EventCtx;
}): { block: true; reason: string } | undefined;
```

**F3 fix:** `path` is `path?: string`, not `path: string`. Extraction from the raw event yields `undefined` for pathless tools, and existing contract tests (`test/events/tool-call.test.ts`) pass `undefined`, `null`, and `""` expecting no-throw. Change the stub's type accordingly.

## Behavior

Exact decision table, in evaluation order. First match wins. Mirrors `eventToolCall` in `src/events.ts` verbatim, including all guards.

| # | Condition | Result | Reason string | Side effects |
|---|-----------|--------|---------------|--------------|
| 1 | `phase === "escalated"` | allow | — | none |
| 2 | `state.awaitDisputeReview` | block | `"Dispute filed. Waiting for Tester review. STOP producing tool calls."` (verbatim) | debug only: `` `Blocked: ${toolName} (awaiting dispute review)` `` — **no** loop-refusal entry |
| 3 | `state.disputeMode && path && !lang.isTestFile(path)` | block | `lang.refusalMessage.phaseC` | debug + `pi.appendEntry("loop-refusal", { phase: "B-dispute", path, tool: "write" })` (note: `tool` is hardcoded `"write"`, matching code, even for edit) |
| 4 | `phase === "negotiate" && isWriteAction(toolName)` | block | `lang.refusalMessage.negotiate` | debug + `pi.appendEntry("loop-refusal", { phase: "negotiate", tool: toolName })` |
| 5 | `phase === "A" && isWriteAction(toolName) && isProjectPath(path, ctx.cwd) && !lang.isPhaseAAllowed(path)` | block | `lang.refusalMessage.phaseA` | debug + `pi.appendEntry("loop-refusal", { phase: "A", path, tool: toolName })` |
| 6 | `(phase === "B" \|\| phase === "C") && !state.disputeMode && isWriteAction(toolName) && isProjectPath(path, ctx.cwd) && lang.isTestFile(path)` | block | `lang.refusalMessage.phaseC` | debug + `pi.appendEntry("loop-refusal", { phase: state.phase, path, tool: toolName })` |
| 7 | otherwise | allow | — | none |

### Helper semantics

```typescript
isWriteAction(toolName) = toolName === "write" || toolName === "edit"

isProjectPath(path, cwd):
  - missing path (undefined/null) → false          // F3 fix: monolith would throw TypeError here in Phase A; spec defines no-throw
  - path starts with "/" → path is project iff it starts with cwd + "/"
  - else → cwd + "/" + path is project iff it starts with cwd + "/"
```

### Missing-path semantics (F3)

When `path` is `undefined`/`null`: rules 3, 5, 6 cannot fire (all require a real path); only rule 2 (awaitDisputeReview) and rule 4 (negotiate + write) can block, since they are path-independent. This preserves monolith behavior for every non-crashing case and fixes the latent Phase A crash. **Flagged intentionally:** this is the one deliberate behavior fix, not a silent one.

Note: empty string `""` is NOT missing — the monolith treats `""` as a project path (rule 5 would block in Phase A, since `""` matches no allowlist pattern; rules 3/6 skip it via their `!path` guards). Preserve this.

### F1 fix (critical)

Rule 6 includes the `!state.disputeMode` exclusion. During a dispute-fix turn (Tester conceded, `disputeMode === true`, phase B), the Tester writes `*_test.go`. Without this exclusion, rule 6 would block the test fix and break the SPEC.md dispute flow ("The enforcement override lasts for that one turn only"). Symmetrically, rule 3 still blocks non-test writes in that same turn.

## Changes

1. Implement `handleToolCall` in `src/events/tool-call.ts` per the decision table; move helpers `isWriteAction`, `isProjectPath` into the module
2. **F5 fix — extraction stays in the delegator.** `events.ts` keeps raw-event extraction: `toolName` from `event.toolName`, `path` from `event.input?.path` (may be undefined). The delegator:
   ```typescript
   export function eventToolCall(state, pi, debug) {
     return async (event, ctx) => {
       const evt = event as { toolName: string; input?: Record<string, string> };
       return handleToolCall({ state, pi, debug, toolName: evt.toolName, path: evt.input?.path, ctx });
     };
   }
   ```
   Remove from `events.ts`: `eventToolCall` body (replaced by delegator), `shouldBlockDispute`, `shouldBlockNegotiate`, `shouldBlockPhaseA`, `checkPhaseBCWrite`, `isProjectPath`, `isWriteAction`, `extractToolPath`
3. Update `src/events/index.ts` re-exports if type names changed

## Acceptance Criteria

- [ ] Decision table rows 1–7 enforced in order; first match wins
- [ ] Dispute fix turn (`phase B`, `disputeMode: true`): test file write **allowed**, non-test project write **blocked** (F1)
- [ ] Missing path (`undefined`/`null`): never throws; only rules 2 and 4 can block (F3)
- [ ] Empty-string path preserves monolith quirk (F3 note)
- [ ] All blocks emit the exact debug + loop-refusal payloads per the table; rule 2 is debug-only (F2)
- [ ] Reason strings match the monolith verbatim, including rule 2's full string (F4)
- [ ] All existing tests pass, including `test/events/tool-call.test.ts` contract tests
- [ ] No behavioral change (sole exception: missing-path no-throw fix, flagged above)

## Phase 0 review findings (verdict: not approved → spec revised)

| # | Finding | Disposition |
|---|---------|-------------|
| F1 | Rule 6 dropped the `!disputeMode` exclusion — would block Tester's dispute-fix test write, breaking SPEC.md dispute flow | **Accepted (critical).** Exclusion added to rule 6; acceptance criterion added |
| F2 | Side effects (debug + loop-refusal entries) unspecified | **Accepted, refined.** Rule 2 (awaitDisputeReview) is debug-only — it emits no loop-refusal entry in the monolith. Full payloads now in the decision table |
| F3 | Interface `path: string` but extraction yields undefined; tests expect no-throw on undefined/null | **Accepted (critical).** `path?: string`; missing-path semantics defined; also documents the latent Phase A crash the fix eliminates, and the empty-string quirk |
| F4 | Rule 2 reason string truncated vs verbatim code | **Accepted.** Full string in table |
| F5 | Delegator's extraction responsibility unspecified (spec removed `extractToolPath` but delegator still needs it) | **Accepted.** Extraction explicitly stays in the `events.ts` delegator, with the exact code shape |

Auto-generated findings disposition: #1 (I/O error handling) and #3 (typescript vs undefined) false positives; #2 nonsense; #4 (empty input) partially valid — the real gap is path field semantics, covered by F1/F3.
