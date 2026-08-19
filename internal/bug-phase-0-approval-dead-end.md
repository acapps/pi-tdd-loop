# bug-phase-0-approval-dead-end

## Problem

Verified current state as of writing (baseline: `npx tsc --noEmit` clean; `npm test` → 32 files, 1017 tests, 0 failures):

**The tool the Phase 0 prompt instructs the agent to use is a silent no-op in Phase 0.**

The Phase 0 review prompt (`src/events/before-agent.ts:79-88`, `buildReviewPrompt`) tells the agent, verbatim:

```
REVIEWER (Phase 0). Review the spec for ambiguities and missing edge cases.
Use negotiate_propose with plan='approve' to proceed, or provide feedback.
No file writes.
```

and the system-prompt line: `Phase 0 (Reviewer). Review the spec. Use negotiate_propose. No file writes.`

The `/loop` command's Phase 0 prompt (`src/commands.ts:buildPhaseZeroPrompt`, lines 204-216) says the same: `Use negotiate_propose to approve (plan='approve') or provide feedback on findings.`

But `negotiate_propose`'s handler (`src/tools.ts:handlePropose`, lines 128-140) routes on phase:

```ts
if (isNegotiatePhase(phase)) {   // phase === "negotiate"
  return handleNegotiatePropose(...);
}
if (isPhaseB(phase)) {           // phase === "B"
  return handleBDisputePropose(...);
}
return buildProposeResult();     // ← phase "review" lands here
```

In phase `"review"`, the call falls through to `buildProposeResult()` — which returns the string **`"Proposal recorded. Awaiting review."`** (`src/tools.ts:36-38`). The agent is told its proposal was recorded. **Nothing was recorded:** no `negotiateProposed` flag, no state mutation, no persist, no transition. The only working Phase 0 approval path is the human command `/loop-approve` (`src/commands.ts:cmdApprove`, lines 445-465). The `handleReviewSettled` handler (`src/events/agent-settled/review.ts:26-38`) confirms the design: it notifies `Phase 0: Review findings. Use /loop-approve to proceed.` — a *different* instruction than the prompt the agent received two turns earlier.

**Consequence (deterministic, not probabilistic):** the agent, following its own prompt, calls `negotiate_propose(plan='approve')` in Phase 0, receives a false success, stops producing tool calls (its prompt says "No file writes" and the propose call was its action), the turn settles, `handleReviewSettled` re-notifies "use /loop-approve" — and the loop waits for a human who was never told the agent's approval was invalid. The agent cannot self-approve; the prompt lied about which tool works; the settle handler tells the *human* to do what the *agent* was told to do.

**Second hole in the same function — `lastProposal` poisoning.** `handlePropose` writes `state.current.lastProposal = plan` (line 133) **before** the phase check, unconditionally. In Phase A, a stray `negotiate_propose` call (the prompt does not offer the tool, but nothing blocks the call — `tool-call.ts` rules 2-6 only gate `write`/`edit` and the dispute flags) overwrites `lastProposal`. That field is later delivered to a dispute reviewer verbatim (`src/events/agent-settled/dispute.ts:55-56`: `GP.promptTesterReviewWriterDispute(state.current.lastProposal)`). A poisoned `lastProposal` changes what the dispute review is reviewing — the reviewer is shown the Phase A stray text, not the dispute claim.

**Third hole — no per-phase tool policy at all.** `negotiate_review` has the identical fall-through (`src/tools.ts:handleReview`, lines 296-306): in phases A/C/review/idle/done/escalated it returns `buildReviewResult(phase, decision)` — `"Approved."` or `"Feedback recorded."` — for a call that did nothing. The machine has 8 phases and 2 agent tools, and the (phase × tool) matrix is: 4 live behaviors, 12 silent lies.

## Target

After this fix: the (phase × tool) matrix is an explicit policy with **no silent branch**. In Phase 0, `negotiate_propose` works exactly as the prompt says — `plan='approve'` advances to Phase A (the same transition `cmdApprove` performs), any other plan is recorded as review feedback and re-enters the review turn. In every other phase where a tool is not available, the call returns an explicit refusal the agent can act on (and a `loop-refusal` entry, matching what `tool-call.ts` already does for file writes). `lastProposal` is written only by the paths that own it.

## Interface

```ts
// src/tools.ts — the policy (replaces the if-chain fall-throughs in handlePropose/handleReview)
type ProposePolicy = "phase0" | "negotiate" | "dispute" | "reject";
type ReviewPolicy  = "phase0" | "negotiate" | "dispute" | "reject";

const PROPOSE_POLICY: Record<Phase, ProposePolicy> = {
  review: "phase0", negotiate: "negotiate", B: "dispute",
  A: "reject", C: "reject", done: "reject", escalated: "reject", idle: "reject",
};
const REVIEW_POLICY: Record<Phase, ReviewPolicy> = {
  review: "phase0", negotiate: "negotiate", B: "dispute",
  A: "reject", C: "reject", done: "reject", escalated: "reject", idle: "reject",
};
```

- `Phase` is the 8-member union (`src/types.ts:1`) — the `Record<Phase, ...>` makes the matrix **closed and exhaustive at the type level**: a new phase without a policy row is a compile error. (This is the type-level guard the review's B-8 asked for; the current `if/if/fall-through` has no such guard.)
- **Phase 0 propose semantics (pinned):**
  - `plan === "approve"` (exact string — the prompt's verbatim instruction) → the Phase A transition: `phase: "A"`, `round: 1`, `awaitingReview: false`, `turnsThisPhase: 1` (the same field writes as `cmdApprove`, `src/commands.ts:452-455`), persist (via `commit` if `refactor-single-commit-point.md` has landed; inline `appendEntry` otherwise — pinned: follow whichever persistence mechanism is live at implementation time), send `lang.prompts.promptTesterPhaseA(specPath, buildTool)` with `{ triggerTurn: true }` (the same prompt `cmdApprove` sends, line 461), notify `Spec review approved. Phase A: Tester writes contract.` (level `info`), status `Phase A — round 1`.
  - any other plan → recorded as feedback: `state.current.lastProposal = plan`, persist, notify `Phase 0: feedback recorded. The review continues — refine the spec or re-run /loop.` (level `info`, **new string**, pinned), and the next settle re-notifies per the existing `handleReviewSettled` (no state change beyond `lastProposal` — the review stays pending; a human decides via `/loop-approve` or `/loop-continue`). Pinned: feedback does NOT auto-reloop Phase 0 — auto-relooping a review is a feature (multiple review rounds), not a bug fix.
- **Reject semantics (pinned, all phases not in the policy):** return `{ content: [{ text: REJECT_TEXT }] }` with
  - `REJECT_TEXT` for propose: `negotiate_propose is not available in this phase.`
  - `REJECT_TEXT` for review: `negotiate_review is not available in this phase.`
  - a `loop-refusal` entry: `{ phase, tool, reason: "not-available-in-phase" }` (new `reason` field, additive to the existing 4 refusal shapes — pinned: existing entries keep their shape, the new field is optional).
  - **no state mutation of any kind** — in particular `lastProposal` is NOT written (the poisoning fix).
- `negotiate_review` in Phase 0: same policy — `decision === "approve"`/`"approved"` (the existing `isApproval`, `src/tools.ts:52-54`) → the same Phase A transition; feedback → the same feedback recording. Pinned: both tools work in Phase 0, matching the prompt which names only `negotiate_propose` (the review tool is a bonus path, not advertised — no prompt change needed).

**No changes** to `negotiate`/`B` routing: `handleNegotiatePropose`, `handleBDisputePropose`, `handleNegotiateReview`, `handleBDisputeReview` are untouched (their internal behavior is owned by other specs — the dispute lifecycle by `bug-dispute-reload-evaporation.md`).

## Behavior

The full (phase × tool) matrix after the fix (8 × 2 = 16 rows, closed):

| Phase | `negotiate_propose` | `negotiate_review` |
|---|---|---|
| review | approve → Phase A / other → feedback recorded | approve → Phase A / other → feedback recorded |
| A | reject | reject |
| negotiate | existing `handleNegotiatePropose` (unchanged) | existing `handleNegotiateReview` (unchanged) |
| B | existing `handleBDisputePropose` (unchanged) | existing `handleBDisputeReview` (unchanged) |
| C | reject | reject |
| done | reject | reject |
| escalated | reject | reject |
| idle | reject | reject |

**Order pin (per call):** policy lookup → (reject: refusal entry + return, no mutation) / (phase0: mutate → persist → send) / (negotiate|dispute: existing handlers, which own their mutation order). `lastProposal` writes exist in exactly 3 places after the fix: `handleNegotiatePropose` (existing, `tools.ts:133` moves into the negotiate branch), Phase 0 feedback (new), and `handleBDisputePropose` (existing — the dispute claim *is* the proposal; pinned: keep).

**Verbatim pins (new user-visible strings):**
- propose reject: `negotiate_propose is not available in this phase.`
- review reject: `negotiate_review is not available in this phase.`
- Phase 0 feedback notify: `Phase 0: feedback recorded. The review continues — refine the spec or re-run /loop.` (level `info`)

**Existing strings unchanged:** `"Proposal recorded. Awaiting review."` (negotiate path), `"Approved."` / `"Feedback recorded."` (negotiate/dispute paths), the Phase 0 prompt text in `before-agent.ts` and `commands.ts` (they become *true* — no prompt edit needed; pinned).

**Side-effect contract:** the Phase 0 approve path performs the *identical* field writes, persist, notify, status, and prompt as `cmdApprove` — pinned as "same transition, two entry points." If both fire (agent approves, then human runs `/loop-approve`), the second is rejected by `cmdApprove`'s existing `phase !== "review"` guard (`src/commands.ts:448-450`) — idempotent by construction.

**Quirks list:**
- Q1: `buildProposeResult`/`buildReviewResult` remain exported-shape results for the negotiate/dispute paths — the *silent* fall-through they used to serve is deleted, but the builders themselves stay (caller-count: negotiate + dispute paths). Pinned.
- Q2: `handlePropose`'s debug line (`negotiate_propose: plan=... phase=...`, `tools.ts:132`) stays at the entry for *all* phases including rejects — a rejected call is debug-visible. Pinned (this is how a production operator sees the agent trying to use a tool it shouldn't have).

**Intended shifts:**
- S1: an agent that calls `negotiate_propose(plan='approve')` in Phase 0 now **advances to Phase A** (was: silent no-op + false success). This is the fix; the human `/loop-approve` remains as an override for sessions where the agent's approval is not trusted.
- S2: a stray tool call in Phase A/C/done/escalated/idle now returns a refusal (was: a false success). Agents that were previously "succeeding" silently now see the refusal text and (per their system prompts) stop or escalate — observable, not silent.

**Ownership:** `src/tools.ts` owns the policy + Phase 0 handlers; `test/extension.test.ts` asserts the matrix (one test per row, 16 tests).

## Inventory

**Files touched (closed list — 3):**
1. `src/tools.ts` — `PROPOSE_POLICY`/`REVIEW_POLICY` + Phase 0 handlers + reject path; `handlePropose`/`handleReview` if-chains replaced by policy lookup; the unconditional `lastProposal` write moved into the negotiate/phase0/dispute branches.
2. `test/extension.test.ts` — the 16-row matrix tests + the `lastProposal`-poisoning regression.
3. `SPEC.md` — the Phase 0 section documents that `negotiate_propose(plan='approve')` is a working approval path (one paragraph; the `/loop-approve` command stays documented as the human path).

**Call sites of `buildProposeResult`/`buildReviewResult` after:** negotiate (2) + dispute (4) + **0 fall-throughs** (was: 2 fall-throughs, `tools.ts:139,305`). Grep-provable.

**`loop-refusal` entry shapes:** the 4 existing shapes (`tool-call.ts:81,90,101,114`) unchanged; 1 new optional `reason` field added by the tool path only. `cmdDebug`'s `validTypes` filter (`src/commands.ts:405-409`) already includes `loop-refusal` — no change.

## Test Strategy

- **Baseline:** 32 files / 1017 tests green.
- **Flips (counted):** `test/extension.test.ts` — grep `negotiate_propose\|negotiate_review` in the file: the existing tests target negotiate/dispute phases (which are unchanged) → **0 flips** in existing tests. The Phase 0 tests (grep `Phase 0` in `test/extension.test.ts`: the `cmdApprove` suite, ~6 tests) are untouched — they test the command, not the tool.
- **New tests (16-row matrix, one per row, named):**
  1. `review × propose(approve)` → `phase === "A"`, `round === 1`, `awaitingReview === false`, `promptTesterPhaseA` sent with `triggerTurn: true`, a `loop-state` entry persisted, notify string pinned. (Fails pre-fix: no mutation, false success returned.)
  2. `review × propose(feedback)` → `lastProposal` set, `phase` still `"review"`, feedback notify pinned.
  3. `review × review(approve)` → same transition as test 1.
  4. `review × review(feedback)` → same recording as test 2.
  5-12. `A/C/done/escalated/idle × {propose,review}` (8 rows) → refusal text pinned (per tool), `loop-refusal` entry with `reason: "not-available-in-phase"`, **`lastProposal` unchanged** (the poisoning regression: seed `lastProposal: "original"`, call the tool in Phase A, assert still `"original"` — fails pre-fix).
  13-16. `negotiate/B × {propose,review}` → existing behavior spot-checks (2 propose + 2 review; guards against the policy rewrite breaking the live paths).
- **Untouched:** `src/events/**`, `src/transitions.ts`, `src/commands.ts` — mechanism: the Phase 0 transition reuses `cmdApprove`'s exact field writes (pinned per Behavior), no shared code is moved.

## Scope lines

- `src/tools.ts`: the two fall-through returns **removed**; policy records **added**; Phase 0 handlers **added**; kept otherwise.
- `test/extension.test.ts`: added (16 tests).
- `SPEC.md`: Phase 0 section **updated** (one paragraph). `README.md`: no change (the tool list is unchanged).

## Acceptance Criteria

1. Tests 1-12 above fail on pre-fix code (the silent no-op + poisoning) and pass after; tests 13-16 pass both before and after (no live-path regression).
2. `npm test` green, 32 files.
3. `npx tsc --noEmit` clean — the `Record<Phase, ...>` exhaustiveness is the type-checker's proof that the matrix has no hole (a 9th phase added later without a policy row fails to compile).
4. Grep sweep: needle `return buildProposeResult();` in `src/tools.ts` — 0 hits at a fall-through position (the string may remain inside the negotiate/dispute handlers; the *bare* fall-through return is gone — the checker is a code inspection of `handlePropose`'s tail, pinned).
5. Grep sweep: `lastProposal =` in `src/tools.ts` — 3 hits (negotiate, phase0-feedback, dispute), all inside policy branches (was: 1 unconditional hit at line 133).
6. `SPEC.md` names `negotiate_propose` as a Phase 0 approval path (needle: `negotiate_propose` in the Phase 0 section ≥ 1 hit; was 0).

## Dependencies

- **Soft dependency:** `refactor-single-commit-point.md` — the Phase 0 approve path persists via `commit` if it has landed, inline `appendEntry` if not (pinned in Interface). Either way this spec is implementable; landing it *after* the commit refactor avoids a one-line rework.
- **Independent of:** `bug-gate-signal-integrity.md` (no shared code), `bug-dispute-reload-evaporation.md` (the dispute rows of the matrix are untouched by this spec and by that spec — the dispute *lifecycle* is rewritten there, the dispute *routing* here; the two meet only at `handleBDisputePropose`'s entry, which both leave intact).
- **Ordering note:** if `bug-dispute-reload-evaporation.md` lands first, its `DisputeState` field appears in the state the Phase 0 transition writes — no interaction (the transition does not touch `dispute`), pinned.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | The 2025-08-18 review (B-8) identified the Phase 0 dead-end and the `lastProposal` poisoning but framed the fix as a 3-value policy (`negotiate/dispute/reject`) — Phase 0 needs its **own** fourth value because its approve semantics (advance to A) differ from the negotiate approve (also advances to A, but via a different handler with different prompts). Merging them would couple Phase 0 to the negotiate prompt set | Accepted — 4-value policy, Phase 0 handler reuses `cmdApprove`'s writes, not the negotiate handler |
| 2 | needs-doc | `negotiate_review` in Phase 0 is *not advertised* by any prompt — making it work is a bonus path. It is included for symmetry (a Tester-role agent in Phase 0 might reach for it) but the prompt is not changed | Accepted — bonus path, no doc change beyond the propose path |
