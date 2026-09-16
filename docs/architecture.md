# Architecture

## Overview

pi-tdd-loop is a pi extension that implements a gated, adversarial 3-agent TDD loop. It registers 11 commands, 2 tools, and 5 event handlers on the pi Extension API. All loop state lives in a single `LoopState` object persisted as `loop-state` custom entries in the session JSONL.

## Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  index.ts (entry point)                                         │
│  Registers commands, tools, event handlers, loop breaker        │
├─────────────────────────────────────────────────────────────────┤
│  Commands (src/commands/)        Tools (src/tools/)             │
│  User-initiated actions           Agent-initiated actions        │
│  /loop, /loop-approve, etc.      negotiate_propose,             │
│                                  negotiate_review               │
├─────────────────────────────────────────────────────────────────┤
│  Events (src/events/)                                               │
│  React to pi lifecycle: session_start, before_agent_start,       │
│  tool_call, agent_settled                                         │
├─────────────────────────────────────────────────────────────────┤
│  State machine (src/transitions.ts)                               │
│  Pure functions: compute next phase + effect from current state   │
├─────────────────────────────────────────────────────────────────┤
│  Infrastructure                                                   │
│  src/types.ts, src/gates.ts, src/languages/, src/commit.ts,      │
│  src/prompt.ts, src/selectors.ts, src/state-validation.ts        │
└─────────────────────────────────────────────────────────────────┘
```

## Event Flow

The pi agent lifecycle drives the loop. Five events are registered:

| Event | Handler | Purpose |
|---|---|---|
| `session_start` | `src/events/session-start.ts` | Restore `LoopState` from session entries; migrate/clear transient flags |
| `before_agent_start` | `src/events/before-agent.ts` | Inject role-specific system prompt (Tester/Writer/Cleaner/Reviewer) based on phase + round parity |
| `tool_call` | `src/events/tool-call.ts` | Enforcement rules: block writes outside workspace (R1), block tools during dispute review (R2), block non-test paths in dispute mode (R3), loop breaker (R4) |
| `agent_settled` | `src/events/agent-settled/index.ts` | Main dispatcher: negotiate settle, gate transition, dispute handlers, review settle, advance/retry/escalate effects |
| `turn_start` / `agent_settled` (breaker) | `index.ts` | Repeated-tool-call detection: if the agent calls the same tool+args 3×, send a breaker notice |

### agent_settled dispatch order

```
handleAgentSettled(input)
  ├── 1. justTransitioned? → consume settle (clear flag, no gate)
  ├── 2. Negotiate phase? → handleNegotiateSettled
  ├── 3. Review phase?    → handleReviewSettled
  ├── 4. Dispute active?  → handleDisputeFix / handleDisputeReview / handleDisputeDefend / handleWriterConcedeFix
  ├── 5. Gate transition  → handleGateTransition (run gates, compute effect)
  └── 6. Apply effect     → applyAdvanceEffect / applyRetryEffect / applyEscalateEffect / applyDoneEffect
```

## State Machine

```
idle → review (Phase 0) → A → negotiate → B → C → done
              ↘ escalated (any phase, via /loop-stop or round exhaustion)
```

| Phase | Actor | Gate |
|---|---|---|
| `review` (0) | Reviewer (LLM) | Baseline test suite green + spec review |
| `A` | Tester | Compile (stubs + tests) |
| `negotiate` | Writer (odd rounds) / Tester (even rounds) | None (approval via `negotiate_review`) |
| `B` | Writer | Tests pass + coverage ≥ threshold |
| `C` | Cleaner | Tests pass (no coverage re-check) |
| `done` | — | Spec archived (`done-` prefix) |
| `escalated` | Human | — |

Transitions are computed by pure functions in `src/transitions.ts`. The `agent_settled` handler calls `computeTransition(state, gateResult)` which returns an `Effect` (advance, retry, escalate, done). The effect applicator then executes side effects (send prompt, persist state, archive spec).

## Module Map

### Entry point

| File | Responsibility |
|---|---|
| `index.ts` | Registers everything: 11 commands, 2 tools, 5 event handlers, loop breaker |

### Commands (`src/commands/`)

| File | Commands |
|---|---|
| `loop.ts` | `/loop` — parse args, baseline check, Phase 0 review, branch setup |
| `lifecycle.ts` | `/loop-approve`, `/loop-stop`, `/loop-cancel` |
| `status.ts` | `/loop-status`, `/loop-continue`, `/loop-restart` |
| `debug.ts` | `/loop-debug` (+ `--log-bug`) |
| `patch.ts` | `/loop-patch` |
| `decompose.ts` | `/loop-decompose` |

### Tools (`src/tools/`)

| File | Responsibility |
|---|---|
| `index.ts` | Re-exports `negotiatePropose`, `negotiateReview`, `isAgreeProposal` |
| `types.ts` | Shared types: `StateRef`, `ToolCtx`, `ToolResult`, `Debug`, result builders, phase guards |
| `negotiate.ts` | Tool definitions + negotiate-phase handlers (propose, review, agree, feedback) |
| `dispute.ts` | Dispute handlers: file, review, defend, concede, `justTransitioned` clearing |
| `phase0.ts` | Phase 0 handlers: approve, feedback, reject |
| `policy.ts` | Phase × Tool policy matrix (which tools are allowed in which phase) |
| `state-io.ts` | `persistState`, `applyTransitionEffect`, `transitionToPhaseB`, `deliverAdvancePrompt` |

### Events (`src/events/`)

| File | Responsibility |
|---|---|
| `index.ts` | Event factory functions, `EventCtx` type |
| `session-start.ts` | State restore, dispute migration, transient flag clearing |
| `before-agent.ts` | Role-specific prompt injection (builds system prompt per phase/round) |
| `tool-call.ts` | Enforcement rules R1–R4 (workspace, dispute review, dispute mode, breaker) |
| `agent-settled/index.ts` | Main settle dispatcher |
| `agent-settled/negotiate.ts` | Negotiate phase settle: approve → Phase B, feedback → re-negotiate |
| `agent-settled/review.ts` | Phase 0 review settle: auto-approve, feedback, dispute |
| `agent-settled/dispute.ts` | Dispute handlers: fix, review, defend, writer-concede-fix |
| `agent-settled/gate-transition.ts` | Run gates, compute transition, `gateInFlight` lock |
| `agent-settled/effect-applicator.ts` | Apply effects: advance, retry, escalate, done; `deliverAdvancePrompt` |

### State machine & infrastructure

| File | Responsibility |
|---|---|
| `src/types.ts` | `LoopState`, `Phase`, `GateResult`, `DisputeState`, `Finding`, workspace helpers |
| `src/transitions.ts` | Pure transition functions: `computeTransition`, `buildAdvanceEffect`, `buildRetryEffect`, etc. |
| `src/gates.ts` | Gate execution: `runGates` → `execCommand` (compile, test, coverage); `formatFailures` |
| `src/languages/` | Language configs: Go, Java, TypeScript (prompts, gate commands, file patterns) |
| `src/commit.ts` | State persistence: `commit()` writes `loop-state` entry; status file in runner mode |
| `src/prompt.ts` | `sendPrompt()`: adapts to runner mode (status file) vs interactive (sendUserMessage) |
| `src/selectors.ts` | `parseLoopArgs`, `loadLoopConfig`, `mergeLoopArgs` |
| `src/state-validation.ts` | State entry validation + quarantine |
| `src/state-helpers.ts` | `resetPhaseState`, `isIdleOrDone`, `resolvePhaseArg` |
| `src/reviewer.ts` | Phase 0 spec review: `findIssues` (heuristic) + LLM review prompt |
| `src/baseline.ts` | Baseline test suite check (runs existing tests before the loop) |
| `src/generic-prompts.ts` | Language-agnostic prompts (negotiate, dispute, escalation, completion) |
| `src/git-workflow.ts` | Branch setup, merge back, conflict resolution |
| `src/spec-archive.ts` | `archiveSpecFile`: rename with `done-` prefix |
| `src/spec-command.ts` | `/spec` Author command (stateless spec writing) |
| `src/bug-spec.ts` | `/loop-debug --log-bug`: extract session log into a bug spec |
| `src/metrics.ts` | Loop metrics accumulation + `formatReport` |
| `src/args.ts` | Token parser for `--flag value` / `--flag=value` |
| `src/constants.ts` | Shared constants (state entry type, etc.) |
| `src/exec-error.ts` | Typed error for gate command failures |
| `src/phase-a.ts` | Phase A prompt builder |
| `src/phase-max.ts` | Phase round limits |

## Data Flow: One Loop Iteration

```
1. Agent acts (writes code, runs tests, calls tools)
2. tool_call events → enforcement rules check each call
3. Agent finishes → agent_settled fires
4. handleAgentSettled:
   a. Compute gate result (runGates: compile + test + coverage)
   b. computeTransition(state, gate) → Effect
   c. Apply effect (send next prompt, persist state, archive spec)
5. before_agent_start fires → inject role prompt for next actor
6. Repeat from 1
```

## Testing Strategy

| Layer | Test files | Approach |
|---|---|---|
| Unit | `test/*.test.ts` (55 files, ~1600 tests) | Mock `ExtensionAPI`, `node:child_process`; no real toolchain |
| Golden (mock) | `test/golden/scenarios.test.ts` (127 tests) | Mock gate results, verify phase/round progression |
| E2E (real) | `test/e2e/quality.test.ts` (2 tests) | Real `go build`/`go test`; runs explicitly, not in default suite |
| Registration | `test/events/registration-surface.test.ts` | SHA-256 hash of `index.ts` registration surface |

**Test speed rule:** default `vitest run` must stay under ~20s. Unit tests never spawn real processes.

## Key Invariants

1. **Single commit point:** state is persisted exactly once per settle (end of `handleAgentSettled`), not mid-handler.
2. **`justTransitioned` flag:** set on phase advance, consumed on next settle (clears flag, skips gate). Must be cleared if the agent does work after the transition (dispute file/concede).
3. **Gate in-flight lock:** `gateInFlight` module-local boolean prevents duplicate gate runs on duplicate settles.
4. **Dispute state object:** single `DisputeState` with `status` field (`none` → `filed` → `in-review` → `conceded`/`defended` → `closed`). Never cleared on session restore.
5. **Spec archival at B→C boundary:** spec is renamed `done-` when implementation completes, before Phase C starts.
