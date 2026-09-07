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

The negotiate phase's machine state (`negotiate_reprompted`, `disputeCount`) tracks the *conversations*, not the *artifact*. The approve path is a tool call — `negotiate_review` → `handleNegotiateReview` → `executeNegotiateApprove` → `transitionToPhaseB` (`src/tools.ts:336-347`) — which advances the moment the Tester approves, before any settle. Nothing reads the test file after approval. The Tester who wrote the contract in Phase A is not re-asked to verify that the file it is about to hand to the Writer matches what was agreed.

**Consequence observed in the same session:** Phase B then spent ~50 minutes grinding on the S1 family of tests (the `green stays green` test is *unpassable by construction* — see `internal/bug-gate-green-stays-green.md`), because the contract the Writer was told to satisfy contained both the negotiated intent and the un-negotiated, broken test body. The Writer could not tell which was authoritative, because the negotiation record and the file disagree and nothing reconciles them.

## Target

After this fix, `negotiate_review: approve` on a proposal that modifies the test contract is a **claim about the file**, and the machine makes the claim checkable: the Tester re-reviews the actual contract file (read-only) before the loop advances to Phase B. Drift between the recorded agreement and the file blocks the advance and routes back to the Tester as a dispute-fix turn — the same channel the dispute flow already uses (`awaitDisputeFix`, `buildDisputeFixPrompt`, `src/events/before-agent.ts:168-181`).

## Interface

No new state fields. Reuse: the existing `negotiate` phase and the existing `negotiateFeedback` → Writer-revision path. The change is one tool-row plus one prompt.

- New phase value is NOT introduced. The re-review happens *inside* the existing `negotiate` phase as an additional round: `negotiate_review: approve` → if the proposal touched the contract (see Behavior row 2) → Tester re-review round (read-only) → `negotiate_review: approve` on the *file* → advance to B.
- **Clarification (2026-08-18, implementation review):** the approve path does not flow through `handleNegotiateSettled` at all — it is a tool call (`negotiate_review` in `src/tools.ts`, `handleNegotiateReview` → `executeNegotiateApprove` → `transitionToPhaseB`). The row-2 interception therefore lives in `src/tools.ts` `handleNegotiateReview` (approve branch), not in `src/events/agent-settled/negotiate.ts`. The settle handler stays untouched.
- Prompt (new exported function in `src/generic-prompts.ts`): the Tester gets the proposal text plus the contract file pattern and must answer `negotiate_review` — `approve` only if the file matches the agreement; otherwise feedback naming the drifted items. Feedback routes through the existing `negotiateFeedback` → Writer-revision path (row 1), so the loop closes on the *file*, not the conversation.
- `negotiate_review: approve` on the re-review round advances to B via the existing `transitionToPhaseB` path (no new transition row).
- **Round-parity discriminator (concrete):** `state.round` is odd → Writer turn, even → Tester turn (`advanceNegotiateRound` in `src/transitions.ts:108-116` alternates 1→2→3…). Row 2 fires only on an even round (a Tester turn, i.e. the Tester is reviewing a proposal); the re-review round is round 3 (odd), so a second approve there falls through to `transitionToPhaseB`. 'agree' is proposed by the Writer (odd round) and approved by the Tester on the *next* settle — the tool call happens on the even round, so the discriminator alone would fire; the **`plan === "agree"` guard** (in `state.lastProposal`) is what skips it (row 3).
- **Escalation guard (concrete):** `maxNegotiate = 3` (default, `src/state-factory.ts:42`) bounds the *feedback* path in `computeNegotiateTransition` (`(round + 2) / 2 <= maxNegotiate`, `src/transitions.ts:85`). The re-review round increments `round` only; a Tester that never approves the file is caught by the existing `maxTurnsPerPhase` loop-detection escalation (`src/events/agent-settled/index.ts:43-55`) — verified, no new escalation path needed.

## Behavior

Decision table for the approve path in `handleNegotiateReview` (`src/tools.ts`), first-match-wins:

| # | Condition | Effect |
|---|-----------|--------|
| 1 | `decision` is feedback (not approve) | existing: `negotiateFeedback = decision`, persist; Writer revision round on next settle (unchanged) |
| 2 | `decision` is approve AND `state.round % 2 === 0` (Tester turn) AND `state.lastProposal !== "agree"` (a real contract proposal was approved) | re-review round: `round++`, `negotiateFeedback = ""`, `negotiateProposed = false`, `justTransitioned = true`, persist, send re-review prompt (`pi.sendUserMessage(..., { triggerTurn: true })`); no phase change, no advance |
| 3 | `decision` is approve AND (row 2 false — 'agree' proposal, or the re-review round itself, which is odd) | existing: `transitionToPhaseB` |

- Row 2's `justTransitioned = true` makes the next settle clear the flag and deliver the *Writer* turn (`handleJustTransitioned`, `src/events/agent-settled/index.ts:60-74`) — the Writer then implements against the verified contract, the same mechanism as the normal approve → Phase B flow. If the Tester returns feedback in the re-review round, row 1 routes it to a Writer revision round via the existing `negotiateFeedback` path — the loop closes on the *file*, not the conversation.
- Verbatim pin (new prompt, `src/generic-prompts.ts`):
  `You are the TESTER (contract re-review). The Writer's proposal was accepted. Verify the contract file matches the agreement.\nRead ${testFilePattern}. Use negotiate_review: 'approve' only if the file matches; otherwise feedback naming each drifted item.\nNo file writes.`
- Side-effect contract: `turnsThisPhase` is NOT reset by row 2 (the phase did not change); it keeps counting toward `maxTurnsPerPhase` escalation — a Tester that never approves the file escalates to the human (intended). `round` increments as for any negotiate round. Persistence via the existing `persistState` (`pi.appendEntry("loop-state", ...)`).
- Ownership: `src/tools.ts` owns row 2; `src/generic-prompts.ts` owns the prompt; `test/tools-negotiate-re-review.test.ts` (new file) asserts rows 1–3.

Quirks list:
- `negotiate_reprompted` exists to force tool use, not to track rounds — do not repurpose it for row 2's "has the Tester re-reviewed" test; round parity within the episode is the discriminator (current behavior, do not fix).
- Approving an 'agree' proposal (no disputes) skips the re-review (row 3): 'agree' asserts the file already matches, and Phase A just wrote it under the Tester's own pen. Current behavior intended, not a quirk — but if a future spec allows mid-negotiation file edits by the Writer, this row must be revisited.
- `handleNegotiateSettled` (`src/events/agent-settled/negotiate.ts`) is NOT modified — it never sees the approve decision (the tool call records/advances before any settle). Its existing tests pin the review-request/feedback/reprompt/advance effects only.

## Inventory

- Files:
  - `src/tools.ts`: `handleNegotiateReview` approve branch + `executeNegotiateReReview` helper + `testFilePattern` threaded from `lang` (the tool ctx carries `lang` — verify at run time; if not, derive via `getLanguageConfig(state.current.language)`).
  - `src/generic-prompts.ts`: kept + one exported prompt function (`promptNegotiateContractReReview(testFilePattern: string)`).
  - `test/tools-negotiate-re-review.test.ts`: new, 4 tests (row 2 fires after a dispute-approve; row 3 fires for 'agree'; row 3 fires on the re-review round's own approve; feedback on re-review routes to Writer revision).
- Imports: `src/tools.ts` adds `promptNegotiateContractReReview` from `generic-prompts` (0 new modules — verify whether `generic-prompts` is already imported there at run time).
- Call sites: `handleNegotiateReview` is called from one site (`negotiateReview` tool execute, `src/tools.ts:283`); its return shape is unchanged.
- Exports: `promptNegotiateContractReReview` (new, `src/generic-prompts.ts`).

## Test Strategy

- **Baseline:** `npx vitest run test/events/agent-settled/negotiate.test.ts` green as of writing (verify at run time); `test/tools-negotiate-re-review.test.ts` is new (no baseline).
- **Flips (counted):** 0 — `handleNegotiateSettled` is untouched; the existing negotiate tests pin the settle-path effects only, and the approve path is exercised through the tool, not the settle handler. Verified: `grep -n "approve" test/events/agent-settled/negotiate.test.ts` — no approve-advance assertion exists in that file.
- **New tests** (`test/tools-negotiate-re-review.test.ts`, driving the `negotiate_review` tool's execute against a `StateRef` fixture — same harness pattern as the existing tools tests):
  1. round 2 (even), `lastProposal: "plan X"`, decision `approve` → **re-review round fires**: state round 3, `justTransitioned: true`, `negotiateFeedback: ""`, phase still `negotiate`, sent message = `GP.promptNegotiateContractReReview("*_test.go")`, persist called.
  2. round 3 (odd — the re-review round), decision `approve` → **advance to B** (row 3): phase B, round 1, `transitionToPhaseB` side effects.
  3. round 2, `lastProposal: "agree"`, decision `approve` → **advance directly** (row 3, 'agree' guard; re-review does not fire).
  4. round 3 (re-review round), decision `feedback text` → **Writer revision round** (row 1): `negotiateFeedback = "feedback text"`, no phase change, no re-review prompt.
- **Untouched:** every existing test in `test/events/agent-settled/negotiate.test.ts` and `test/prompts.test.ts` (the new prompt is additive; existing prompt signatures unchanged). Mechanism: the new row is unreachable by existing tests' fixtures (they never call the tool's approve path with an even round + non-agree proposal).

## Scope lines

- `src/tools.ts`: `handleNegotiateReview` approve branch + `executeNegotiateReReview` helper + `testFilePattern` threading.
- `src/generic-prompts.ts`: + 1 function.
- `test/tools-negotiate-re-review.test.ts`: new, 4 tests.
- Everything else: untouched.

## Acceptance Criteria

1. `npm test` green (name the suite: full `vitest run`).
2. `npx tsc --noEmit` clean.
3. Grep sweep: needle `contract re-review` — exactly 1 hit in `src/generic-prompts.ts`; needle `reReviewedFile` — 0 hits (round parity is used, no new state field); needle `executeNegotiateReReview` — 1 definition in `src/tools.ts` + its test file.
4. Session-level check (manual, one run): a negotiation that ends in a dispute-approve must produce, in the session log, a second Tester `negotiate_review` round before `phase=B` (verify via `scripts/extract-session.sh`: two `[negotiate] review` events, then `[state] phase=B`).

## Dependencies

None upstream. Independent of `bug-gate-signal-integrity.md` (which this session's drift *concerned* but does not depend on code-wise).

## Findings log

| # | Severity | Finding | Disposition |
|---|-----------|---------|-------------|
| 1 | blocker | The session's recorded agreement (skipIf + 30s + vi.mock seam) is absent from `test/gate-signal-integrity.test.ts`; the file still has 120s, no skip, live S2 | Accepted — this is the bug; the re-review round makes the file, not the transcript, the settlement artifact |
| 2 | needs-doc | `negotiate_reprompted` is a tool-use flag, not a round tracker; reusing it for "has the Tester re-reviewed" would conflate two purposes | Rejected — round parity within the episode is the discriminator; `negotiate_reprompted` untouched |
| 3 | needs-doc | 2026-08-18 implementation review: the approve path is a TOOL call (`src/tools.ts` `handleNegotiateReview` → `executeNegotiateApprove`), not a settle — the original Interface/Behavior placed row 2 in `handleNegotiateSettled`, which never sees the decision. Also `maxNegotiate = 3` bounds the feedback path in `computeNegotiateTransition`, so the re-review must not consume feedback budget | Accepted — row 2 moved to `handleNegotiateReview` (tools.ts); re-review round increments `round` only, `turnsThisPhase` keeps counting (loop-detection escalation is the safety net); spec updated in place |
