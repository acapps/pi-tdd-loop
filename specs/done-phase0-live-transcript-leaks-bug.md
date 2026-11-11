# Phase 0 Live Transcript Leaks — State Reset Mechanism

## Background

You are the **bug reporter (AUTHOR)** for the `loop-go-bak` extension.
You are building this extension in Go, Java, or TypeScript to fill a gap in the pi-coding-agent framework.

The loop's core phase transition is:
- **Phase 0** → review the Phase 0 spec for errors and missing cases.
- **Phase A** → the human accepts the Phase 0 plan, or the agent proposes a plan and asks for approval.
- **Phase B** → the agent executes the approved plan.
- **Phase C** → the agent reports, the human accepts or rejects.
- **Phase D** → same pattern as Phase B.
- **Phase Done** → loop terminates on success, or **Phase Escalated** on hard failure.

## The Bug

During Phase 0, the spec back-and-forth accumulates in the **live conversation transcript**, not in any durable state.

Every review round adds: the review prompt, the human response, the heuristic/cognitive-audit findings, and the combined finding + plan text.

There is **no "flush state" / "reset context" primitive** in the loop's internal state model or the pi-extension API.

As the Phase 0 spec grows (bad specs, many rounds, noise from test scaffolding), the transcript bloats unboundedly.

Once Phase A is approved and Phase B starts, the transcript is **too large for the LLM context window**, or simply **cluttered** to the point where the LLM loses its ability to reliably reason about the actual problem.

## Root Cause

1. **Live transcript bloat**: All Phase 0 dialogue is sent via `pi.sendUserMessage()` / `pi.sendAssistantResponse()` and appended to the session's conversation history. There is no bounded storage and no mechanism to drop completed turns.

2. **No state snapshot points**: There is no "checkpoint" after Phase 0 review. The loop only reverts on Phase C/D reject. Once the transcript is polluted, it stays polluted forever.

3. **No compaction integration**: The pi `compact()` API and `SessionBeforeCompactEvent` exist, but the loop never calls `api.compact()` between Phase 0 and Phase A, and the event handler is a no-op.

## Failure Class

> **BUG — Phase 0 transcript leak + missing state checkpoint + missing compaction gate.**

## Severity

- **Moderate → High**. On simple specs, it works. On realistic specs, the loop will eventually OOM or produce hallucinated plans because the LLM cannot fit or parse the full transcript.

## What Works Today

- A single, clean Phase 0 spec completes Phase 0 → Phase A smoothly.
- A single, clean Phase A plan completes Phase A → Phase B smoothly.

## What Fails

- A spec that triggers multiple Phase 0 rounds.
- A spec that triggers a Phase B failure (Phase C reject) and then retries from Phase A.
- A spec with fake test scaffolding (high token count) — the reviewer still consumes tokens against the capped API.

## Root Cause Detail (Technical)

The loop's `ctx.state` is in-memory and ephemeral. There is no "loop state history" object, no "transcript snapshot", no "state tree". The only thing that persists across runs is the pi session's message log, and even that is unbounded.

The `flush()` function in `src/reviewer.ts` is called **twice in the same Phase 0 run** — once before the first question and once at the end. It does **nothing but `api.ui.setStatus()`**, so it's dead code.

## Required Fix (Scope-Gated)

Do **not** refactor the existing code to just work. The fix must introduce a new, explicit mechanism for bounded state that survives phase transitions.

### Artifacts to Add

1. **`src/state/`** — new module with:
   - `LoopStateSnapshot` (snapshot of the entire loop state at a checkpoint).
   - `StateCheckpointManager` — can create snapshots at Phase 0 entry, Phase A entry, Phase A exit, Phase B entry, Phase C exit, etc.
   - `restoreSnapshot(snapshot: LoopStateSnapshot)` — restores `ctx.state` from a checkpoint.
   - `flush() → "Phase 0 review pending"` — hard reset: drops the transcript, drops the current Phase 0 state, does not touch Phase A+ history.

2. **`src/lifecycle.ts`** — integrate the checkpoints:
   - At `Phase 0 entry`, automatically create a snapshot (after the Phase 0 review completes, not before).
   - At `Phase A entry`, automatically restore the Phase 0 snapshot.
   - At `Phase B entry`, ensure the transcript is clean (the B-plan task description comes from the approved Phase A plan, not from Phase 0).
   - Expose a `flush()` hook the human can call from the TUI.

3. **`api.compact()` integration** — the loop should call `api.compact()` as a gatekeeper for transitioning from Phase 0 to Phase A:
   - Call `api.compact()` with default options before entering Phase A.
   - On Phase C reject, before retrying Phase A, call `api.compact()` again with stricter options.

4. **`test/phase0-state-check.test.ts`** — regression suite:
   - Phase 0 transcript must not exceed the allowed transcript token budget.
   - Phase A entry must restore the Phase 0 snapshot.
   - Phase B must not inherit Phase 0's transcript.
   - A `flush()` call must reset the transcript and current phase to `review` with `round: 0`.

### Language Behavior Changes

**Go**: A new `loop.StateCheckpointManager` struct and `state.Checkpoint` type. `cmdLoop` writes a checkpoint after Phase 0. `cmdLoop` restores the checkpoint on Phase A. `flush()` is a public method on `StateCheckpointManager` that clears the conversation log and resets the phase.

**Java**: A new `LoopStateCheckpointManager` class and `LoopStateSnapshot` class. The `/loop` command wires the checkpoint manager into the `StateContext`. A new `LoopEvent` `LOOP_STATE_CHECKPOINT` is fired after Phase 0. A new `LoopCommand` `loop-flush` restores the last checkpoint.

**TypeScript**: A new `src/state/checkpoint.ts` module. `Context` gains `checkpointManager: StateCheckpointManager`. `CommandLoop` wires the checkpoints. A new `pi.on("session_before_compact")` handler is wired that calls `api.compact()` when the token budget approaches the limit.

### What the Fix Does **Not** Do

- It does not "magically compress" the transcript. It explicitly flushes it.
- It does not remove the Phase 0 / Phase A split. The fix respects the phased design.
- It does not add a `--flush` flag that silently drops Phase A history. Flush only resets from the last checkpoint.
- It does not add a new "Phase 0 reset" command. Flush is the one reset point.

## Evidence / Bugs in the Repo

- `src/reviewer.ts:342–358`: `flush()` is dead code — called twice for no reason.
- `src/commands/loop-baseline.ts`: no checkpointing logic.
- `src/tools/state-io.ts`: `persistState()` writes to the session log, but the loop never calls `api.appendEntry("loop-state", state)` to make it durable.
- `test/__mocks__/@earendil-works/pi-coding-agent.ts`: no `api.compact` mock, no `api.on("session_before_compact")` mock.

## Acceptance Criteria

1. The transcript token count stays bounded even if Phase 0 runs for 10+ rounds.
2. When the human approves Phase A, the Phase 0 transcript is dropped (or the API caps it).
3. When the human rejects Phase B and the retry is entered, only the Phase A transcript is present.
4. `/loop-flush` (Java), `flush()` (Go/TS) resets the transcript and phase to `review` with `round: 0`.
5. The pi `compact()` event fires before Phase A and is honored (tokens removed).

## Bug Tracking (for the author)

Track this as **BUG: Phase 0 transcript leaks into Phase B/C, and there is no flush/reset mechanism**.

## Next Steps

Write a **tight, /loop-ready spec file** in `specs/` that:
- Describes the bug clearly.
- States the fix's scope (new `StateCheckpointManager`, `flush()` command, `compact()` integration).
- States **exactly** what the test spec (`src/spec-command.ts`) will look like — including the Phase 0 → Phase A transition and the transcript flush behavior.
- Includes **5–10 minimal tests** in `test/phase0-state-check.test.ts` that verify bounded transcript, checkpoint restore, flush, and compact integration.

I have done the investigation. Deliver the spec now.