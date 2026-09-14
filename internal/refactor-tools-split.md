# Refactor: Split src/tools.ts into Focused Modules

## Status: open

## Target

`src/tools.ts` is 549 lines containing both `negotiate_propose` and
`negotiate_review` tool definitions plus all their phase-specific handlers.
The dispute-handling logic (~100 lines) is a self-contained concern that can
be extracted. Split into focused modules while preserving the public API
(`index.ts` imports `* as Tool`).

## Behavior

### Current Structure (549 lines, 1 file)

```
src/tools.ts
├── Types: StateRef, ToolCtx, ToolResult, Debug
├── Result builders: buildProposeResult, buildReviewResult
├── Phase guards: isNegotiatePhase, isPhaseB, isApproval
├── Concession: isAgreeProposal (exported), startsWithAgreeToken, isConcession
├── State I/O: persistState, logNegotiateEntry, logDisputeEntry,
│              logDisputeConcession, logEscalation
├── Transition: applyTransitionEffect, transitionToPhaseB
├── Phase 0: executePhase0Approve, executePhase0Feedback, executeReject
├── negotiatePropose (exported) — tool definition
│   └── handlePropose
│       ├── handleNegotiatePropose
│       ├── handleBDisputePropose
│       ├── executeWriterConcedeDispute
│       ├── executeNegotiateAgree
│       └── executeNegotiateProposal
├── negotiateReview (exported) — tool definition
│   └── handleReview
│       ├── handleNegotiateReview
│       │   ├── executeNegotiateReReview
│       │   ├── executeNegotiateApprove
│       │   └── executeNegotiateFeedback
│       └── handleBDisputeReview
└── triggerDisputeReview
```

### Target Structure

```
src/tools/
├── index.ts              — re-exports negotiatePropose, negotiateReview,
│                           isAgreeProposal (public API unchanged)
├── types.ts              — StateRef, ToolCtx, ToolResult, Debug,
│                           buildProposeResult, buildReviewResult,
│                           isNegotiatePhase, isPhaseB, isApproval
├── negotiate.ts          — negotiatePropose + negotiateReview tool definitions,
│                           handlePropose, handleReview, handleNegotiatePropose,
│                           handleNegotiateReview, executeNegotiateAgree,
│                           executeNegotiateProposal, executeNegotiateReReview,
│                           executeNegotiateApprove, executeNegotiateFeedback,
│                           triggerDisputeReview
├── dispute.ts            — handleBDisputePropose, handleBDisputeReview,
│                           executeWriterConcedeDispute, isConcession,
│                           logDisputeEntry, logDisputeConcession
├── phase0.ts             — executePhase0Approve, executePhase0Feedback,
│                           executeReject
└── state-io.ts           — persistState, logNegotiateEntry, logEscalation,
                            applyTransitionEffect, transitionToPhaseB
```

### Module Dependencies

```
src/tools/index.ts       →  re-exports from negotiate, dispute, phase0
src/tools/negotiate.ts   →  types, state-io, dispute, phase0, transitions,
                            generic-prompts, languages, commit, prompt, phase-a, metrics
src/tools/dispute.ts     →  types, state-io, transitions, generic-prompts,
                            languages, commit, prompt, metrics
src/tools/phase0.ts      →  types, state-io, transitions, generic-prompts,
                            languages, commit, prompt, phase-a
src/tools/state-io.ts    →  types, commit, prompt, metrics
src/tools/types.ts       →  types (leaf)
```

No circular dependencies: `types.ts` is a leaf; `state-io.ts` depends only on
`types.ts`; `dispute.ts` and `phase0.ts` depend on `types.ts` + `state-io.ts`;
`negotiate.ts` depends on all of the above.

## Inventory

| File | Action |
|------|--------|
| `src/tools.ts` | **Delete** (replaced by `src/tools/`) |
| `src/tools/index.ts` | **Create** — re-export public API |
| `src/tools/types.ts` | **Create** — shared types + result builders (~40 lines) |
| `src/tools/negotiate.ts` | **Create** — tool definitions + negotiate-phase handlers (~180 lines) |
| `src/tools/dispute.ts` | **Create** — dispute handlers (~100 lines) |
| `src/tools/phase0.ts` | **Create** — Phase 0 handlers (~40 lines) |
| `src/tools/state-io.ts` | **Create** — state persistence + transition helpers (~80 lines) |
| `index.ts` | **Modify** — change import from `./src/tools` to `./src/tools` (path unchanged, directory module) |
| `test/extension.test.ts` | **Verify** — tool registration unchanged |
| `test/tools-negotiate-agree.test.ts` | **Modify** — import path if needed |
| `test/tools-negotiate-re-review.test.ts` | **Modify** — import path if needed |
| `test/state-divergence-cleanup.test.ts` | **Modify** — file list if it references `src/tools.ts` |
| `test/events/registration-surface.test.ts` | **Verify** — SHA-256 hash of `index.ts` (should be unchanged) |

## Test Strategy

1. **No behavioral change** — this is a pure file reorganization.
2. All existing tests must pass without modification (import paths resolve to the same public API).
3. The `isAgreeProposal` function is exported and used by tests — it must remain importable from the same path.
4. Run `npx tsc --noEmit` to verify no broken imports.
5. Run `npx vitest run` — all 1340 tests must pass.

## Scope

- **IN:** File split, import path updates, test fixture path updates.
- **OUT:** Changing any tool's behavior, adding new tools, changing the public API,
  modifying the dispute state machine logic.

## Acceptance Criteria

1. `src/tools.ts` no longer exists.
2. `src/tools/index.ts` re-exports `negotiatePropose`, `negotiateReview`, `isAgreeProposal`.
3. Each tool module is under 200 lines.
4. `index.ts` (root) imports `* as Tool from "./src/tools"` — unchanged.
5. `npx tsc --noEmit` passes.
6. `npx vitest run` — all tests pass.
7. No new dependencies introduced.

## Dependencies

None. Pure refactor. Independent of `refactor-commands-split`.

## Findings Log

- The dispute handlers (`handleBDisputePropose`, `handleBDisputeReview`,
  `executeWriterConcedeDispute`) form a self-contained unit: they read
  `state.current.dispute`, call `T.handleDispute*` transitions, and send
  prompts. They share no local state with the negotiate-phase handlers.
- `logDisputeEntry` and `logDisputeConcession` are only called by dispute
  handlers — they move to `dispute.ts` with the handlers.
- `isConcession` (exact lexical match for "agree") is only used by
  `handleBDisputePropose` — it moves to `dispute.ts`.
- The `applyTransitionEffect` function is the bridge between tool handlers and
  the state machine (`src/transitions.ts`). It's used by both negotiate and
  dispute paths — it stays in `state-io.ts`.
- `triggerDisputeReview` is called from `handleBDisputePropose` (dispute.ts)
  but sends a prompt that the negotiate handler will process. It's a
  cross-cutting concern — place it in `negotiate.ts` (the consumer) or
  `state-io.ts` (the mechanism). Recommend `state-io.ts` since it's a
  state-mutation + prompt-send primitive.
