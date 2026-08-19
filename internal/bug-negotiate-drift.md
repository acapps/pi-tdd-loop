# bug-negotiate-drift

## Problem

Verified current state as of writing (re-checked against the repo; runtime evidence: session `01a0167f-f4b0-719a-ab7e-ed9e975d65b7`, 2026-08-18 20:11–23:06 UTC, extracted via `scripts/extract-session.sh`):

**The negotiation outcome is never checked against the contract file, so agreed clarifications silently fail to land.**

In that session, the negotiate phase (20:35–20:49) produced an explicit, recorded agreement. The Tester's `negotiate_review` (round 2, verbatim from the session):

> **2. S2 — accept the stubbed-seam approach, with a contract pin on the seam.** … S1 (go) stays live but must **skip, not pass-via-error**, when `go` is absent: detect via a `which go`-style probe (or a pre-flight `execFile("go", ["version"])`) and `it.skipIf` on the probe result. … A missing toolchain must never produce a green checkmark. **The 120s timeout goes away with the stub; live go tests get 30s** (a real `go test` in a temp module doesn't need 2 minutes).

The Writer's round-3 proposal accepted all of it ("incorporating all Tester clarifications. No further disputes."), the Tester approved, and the loop advanced to Phase B. **None of it is in `test/gate-signal-integrity.test.ts`** (verified against the file as it exists now, which Phase B never touched):

- S1 (`test/gate-signal-integrity.test.ts:193`): no `it.skipIf`, no `which go` probe, **120s timeout** (`120_000`, line 215).
- S1's fallback branch (lines 207–211): `expect(outcome.kind).toBe("error")` — i.e. a missing toolchain is accepted, and vitest still prints a **green checkmark** for the test. This is exactly the behavior the negotiation forbade ("must NOT be reported as a pass" was the *intent*; the written assertion makes a skipped-by-error run indistinguishable from a pass in the summary).
- S2 (line 217): still the live-execution form (`makeTsCwd()` + real `runGates`), not the agreed `vi.mock("node:child_process")` seam.

The negotiate phase's machine state (`negotiate_reprompted`, `disputeCount`) tracks the *conversations*, not the *artifact*. `handleNegotiateSettled` (`src/events/agent-settled/negotiate.ts`) settles on `negotiate_review: approve` and advances. Nothing reads the test file after approval. The Tester who wrote the contract in Phase A is not re-asked to verify that the file it is about to hand to the Writer matches what was agreed.

**Consequence observed in the same session:** Phase B then spent ~50 minutes grinding on the S1 family of tests (the `green stays green` test is *unpassable by construction* — see `internal/bug-gate-green-stays-green.md`), because the contract the Writer was told to satisfy contained both the negotiated intent and the un-negotiated, broken test body. The Writer could not tell which was authoritative, because the negotiation record and the file disagree and nothing reconciles them.

## Target

After this fix, `negotiate_review: approve` on a proposal that modifies the test contract is a **claim about the file**, and the machine makes the claim checkable: the Tester re-reviews the actual contract file (read-only) before the loop advances to Phase B. Drift between the recorded agreement and the file blocks the advance and routes back to the Tester as a dispute-fix turn — the same channel the dispute flow already uses (`awaitDisputeFix`, `buildDisputeFixPrompt`, `src/events/before-agent.ts:168-181`).

## Interface

No new state fields. Reuse: `state.awaitDisputeFix` (already exists, `src/types.ts`) and the existing `negotiate` phase. The change is one transition row plus one prompt.

- New phase value is NOT introduced. The re-review happens *inside* the existing `negotiate` phase as an additional round: `negotiate_review: approve` → if the proposal touched the contract (see Scope) → Tester re-review round (read-only) → `negotiate_review: approve` on the *file* → advance to B.
- Prompt (new key in `RETRY_PROMPTS` / `src/generic-prompts.ts`): the Tester gets the proposal text plus the current content of the contract file and must answer `negotiate_review` — `approve` only if the file matches the agreement; otherwise feedback naming the drifted items.
- `negotiate_review: approve` on the re-review round advances to B (existing `computeNegotiateTransition` path, no new transition row needed if the round counter is the discriminator — see Behavior).

## Behavior

Decision table for `handleNegotiateSettled` on `negotiate_review` (first-match-wins):

| # | Condition | Effect |
|---|-----------|--------|
| 1 | `decision` is feedback (not approve) | existing: feedback → Writer revision round (unchanged) |
| 2 | `decision` is approve AND the approved proposal was a *dispute/revision* of the contract (Writer proposed, Tester reviewed, now approving) AND the Tester has not yet re-reviewed the file this negotiation (`reReviewedFile: false` — derived: the previous round in this negotiate episode was a Tester review round) | Tester re-review round: prompt with proposal + contract file content; `negotiate_review` only; no file writes |
| 3 | `decision` is approve AND (row 2's condition false — e.g. approve of an initial 'agree' proposal, or the re-review round itself) | existing: advance to B |

- The re-review round is read-only for the Tester (system prompt: "You may read the contract file. Use negotiate_review only."). If the Tester finds drift, it returns feedback → row 1 → Writer revision → … the loop closes on the *file*, not the conversation.
- Verbatim pin (new prompt, `src/generic-prompts.ts`):
  `You are the TESTER (contract re-review). The Writer's proposal was accepted. Verify the contract file matches the agreement.\nRead <testFilePattern>. Use negotiate_review: 'approve' only if the file matches; otherwise feedback naming each drifted item.\nNo file writes.`
- Side-effect contract: no new persistence. `turnsThisPhase` increments as for any negotiate round; `maxTurnsPerPhase` escalation unchanged (a Tester that never approves the file escalates to the human — intended).
- Ownership: `src/events/agent-settled/negotiate.ts` owns the row-2 detection; `src/generic-prompts.ts` owns the prompt; `test/events/agent-settled/negotiate.test.ts` asserts it.

Quirks list:
- `negotiate_reprompted` exists to force tool use, not to track rounds — do not repurpose it for row 2's "has the Tester re-reviewed" test; use round parity within the episode (current behavior, do not fix).
- Approving an 'agree' proposal (no disputes) skips the re-review (row 3): 'agree' asserts the file already matches, and Phase A just wrote it under the Tester's own pen. Current behavior intended, not a quirk — but if a future spec allows mid-negotiation file edits by the Writer, this row must be revisited.

## Inventory

- Files:
  - `src/events/agent-settled/negotiate.ts`: kept + row 2 in `handleNegotiateSettled` + the round-parity helper.
  - `src/generic-prompts.ts`: kept + one exported prompt function.
  - `src/constants.ts`: kept + one `RETRY_PROMPTS` key (or the prompt lives directly in `generic-prompts.ts` — decision: `generic-prompts.ts`, matching `promptWriterNegotiate`'s home).
  - `test/events/agent-settled/negotiate.test.ts`: kept + 3 new tests (row 2 fires after a dispute-approve; row 3 fires for 'agree'; feedback on re-review routes to Writer revision).
- Imports: `negotiate.ts` adds none (prompt is imported from `generic-prompts.ts` alongside the existing ones).
- Call sites: `handleNegotiateSettled` is called from one site (`src/events/agent-settled/index.ts:130`); its return shape is unchanged.
- Exports: none new.

## Test Strategy

- **Baseline:** `npx vitest run test/events/agent-settled/negotiate.test.ts` green as of writing (verify at run time; count: file exists, all `it` blocks pass).
- **Flips (counted):** 0 — the new row is unreachable by existing tests' fixtures (they approve without a preceding dispute round).
- **New tests:**
  1. dispute proposed → review feedback → revision → approve → **re-review round fires** (assert: prompt contains "contract re-review", Tester gets `negotiate_review` only, no advance).
  2. re-review approve → **advance to B** (assert: effect `advance`, phase B).
  3. re-review feedback naming drift → **Writer revision round** (assert: effect reprompt/advance-to-Writer with the feedback text).
  4. 'agree' proposal → approve → **advance directly** (row 3; re-review does not fire).
- **Untouched:** `src/transitions.ts` (row 2 is handled inside the negotiate settle, before `computeNegotiateTransition` is consulted for the advance). Mechanism: the settle handler returns the re-review effect itself, so the transition table never sees the intermediate round.

## Scope lines

- `src/events/agent-settled/negotiate.ts`: kept + row 2 + helper.
- `src/generic-prompts.ts`: kept + 1 function.
- `test/events/agent-settled/negotiate.test.ts`: kept + 4 tests.
- Everything else: untouched.

## Acceptance Criteria

1. `npm test` green (name the suite: full `vitest run`).
2. `npx tsc --noEmit` clean.
3. Grep sweep: needle `contract re-review` — exactly 1 hit in `src/generic-prompts.ts`; needle `reReviewedFile` — 0 hits (round parity is used, no new state field).
4. Session-level check (manual, one run): a negotiation that ends in a dispute-approve must produce, in the session log, a second Tester `negotiate_review` round before `phase=B` (verify via `scripts/extract-session.sh`: two `[negotiate] review` events, then `[state] phase=B`).

## Dependencies

None upstream. Independent of `bug-gate-signal-integrity.md` (which this session's drift *concerned* but does not depend on code-wise).

## Findings log

| # | Severity | Finding | Disposition |
|---|-----------|---------|-------------|
| 1 | blocker | The session's recorded agreement (skipIf + 30s + vi.mock seam) is absent from `test/gate-signal-integrity.test.ts`; the file still has 120s, no skip, live S2 | Accepted — this is the bug; the re-review round makes the file, not the transcript, the settlement artifact |
| 2 | needs-doc | `negotiate_reprompted` is a tool-use flag, not a round tracker; reusing it for "has the Tester re-reviewed" would conflate two purposes | Rejected — round parity within the episode is the discriminator; `negotiate_reprompted` untouched |
