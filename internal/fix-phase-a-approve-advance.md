# fix-phase-a-approve-advance

## Problem

**Verified current state as of writing (commit 32cc09d):**

When the Tester calls `negotiate_propose("approve")` in Phase A, the loop
enters `escalated` state and pauses, telling the human to run `/loop-continue`
to resume. This is a dead-end: the human must manually type a command to get
the loop moving, which is the exact friction the loop is supposed to eliminate.

**Observed in session 01a1c767 (spec enrich-entry-renderer):** the Tester
finished Phase A work, called `negotiate_propose("approve")`, and the loop
paused. The human had to run `/loop-continue` to advance to Phase B. The
session log shows the pause + manual resume, not an automatic advance.

**Root cause (verified against code):**

`src/tools/policy.ts:15` maps Phase A to `"escalate"`:

```ts
export const PROPOSE_POLICY: Record<Phase, ProposePolicy> = {
  review: "phase0", negotiate: "negotiate", B: "dispute",
  A: "escalate", C: "reject", done: "reject", escalated: "escalate", idle: "reject",
};
```

`src/tools/phase0.ts:71` (`executeEscalatePropose`) sets `phase = "escalated"`,
persists, and returns `ESCALATE_NOTICE` ("Wait for the human's decision — do
not take further action. To resume: /loop-continue").

The test at `test/tools-split/behavior.test.ts:250` pins this behavior:

```ts
it("A × propose('approve') → still escalate (no hidden auto-advance from Phase A)", ...)
```

**Why this is wrong:** Phase A's `negotiate_propose` is the Tester's escape
hatch for a spec that genuinely needs no new tests (or where the Tester has
completed the contract and wants to move on). The human's approval is
semantically independent of the technical gate outcome — if the Tester says
"approve", the phase should advance to B immediately, not pause for a manual
`/loop-continue`. The `escalated` state is for *genuine* escalations (dispute
limit reached, gate error), not for a clean approval.

**Contrast with Phase 0:** `negotiate_propose("approve")` in Phase 0
(`review` phase) calls `executePhase0Approve` → `startPhaseA` → Phase A round
1, no pause. The same semantic should apply in Phase A → Phase B.

## Target

`negotiate_propose("approve")` in Phase A advances directly to Phase B round 1,
bypassing the gate. The human is told "Approved — moving to Phase B." via
`ui.notify`. The loop continues without a pause. The agent (Writer) receives
the Phase B advance prompt and begins implementation.

Non-approve proposals in Phase A still escalate (no change): the plan is
surfaced verbatim, the loop pauses, the human decides via `/loop-continue`.

## Interface

No signature changes. The change is in the *handler* for Phase A's `negotiate_propose`:

- `src/tools/policy.ts`: `PROPOSE_POLICY.A` changes from `"escalate"` to
  `"phaseA"`. The `ProposePolicy` type union gains one value:
  `"phase0" | "negotiate" | "dispute" | "escalate" | "reject" | "phaseA"`.
- `src/tools/phase0.ts`: new function `executePhaseAApprove` (or inline in
  `handlePropose`) that calls `transitionToPhaseB` (the same helper used by
  negotiate → Phase B).

**Persisted state:** no new fields. `phase`, `lastPhase`, `round`,
`turnsThisPhase`, `justTransitioned`, `dispute` are all set by
`transitionToPhaseB` / `resetForPhaseB` (existing, verified in
`src/tools/state-io.ts:20-41`).

## Behavior

**Decision table for `negotiate_propose` in Phase A:**

| Condition | Action | State after | Effect |
|---|---|---|---|
| `plan === "approve"` (case-insensitive, trimmed) | `executePhaseAApprove` | `phase="B"`, `lastPhase="A"`, `round=1`, `turnsThisPhase=1`, `justTransitioned=true`, `dispute={status:"none"}` | `advance` to Phase B, `notify="Approved — moving to Phase B."`, `prompt=WRITER_PHASE_B` |
| `plan !== "approve"` | `executeEscalatePropose` (existing) | `phase="escalated"`, `lastPhase="A"` | `escalated`, `notify=<plan verbatim>`, `status="escalated (proposal surfaced)"` |

**Evaluation order:** check `plan.trim().toLowerCase() === "approve"` first.
If true, advance. Otherwise, escalate (existing path, unchanged).

**Verbatim pins:**

- `notify` on approve: `"Approved — moving to Phase B."` (same string as
  `transitionToPhaseB` in `src/tools/state-io.ts:25`).
- `prompt` key: `ADVANCE_PROMPTS.WRITER_PHASE_B` (`"writer_phase_b"`).
- `status`: `"Phase B — round 1"`.
- `ESCALATE_NOTICE` (for non-approve): unchanged — `"Your proposal has been
  surfaced to the human and the loop is paused. Wait for the human's decision
  — do not take further action. To resume: /loop-continue (or /loop-restart
  <phase>)."`.

**Side-effect contract (approve path):**

1. `pi.appendEntry("loop-negotiate", { phase: "A", round: <current>, action: "approve", text: plan.slice(0, 500) })`
2. `resetForPhaseB(state)` — sets `phase="B"`, `lastPhase="A"`, `round=1`, `turnsThisPhase=1`, `justTransitioned=true`, `dispute={status:"none"}`, clears `negotiateReprompted`, `negotiateProposed`, `negotiateFeedback`, `negotiateResolution`.
3. `persistState(state, pi, debug)` — commits the new state.
4. `ctx.ui.setStatus("loop", "Phase B — round 1")`.
5. Re-capture scope-check baseline via `captureGitBaseline(getWorkspaceRoot(specPath))` (existing logic in `applyTransitionEffect`, triggered by `effect.type === "advance" && effect.phase === "B" && lastPhase === "A"`).
6. `ctx.ui.notify("Approved — moving to Phase B.", "info")`.
7. `deliverAdvancePrompt(pi, state.current, lang, effect, debug)` — sends the Writer the Phase B prompt.

**Quirks list:**

- **Current behavior, do not fix:** non-approve proposals in Phase A still
  escalate. The `escalated` state is correct for genuine escalations (dispute
  limit, gate error, human-directed work outside the loop). Only the `"approve"`
  case changes.
- **Current behavior, do not fix:** `negotiate_review` in Phase A is still
  `"reject"` (unchanged). The Tester does not call `negotiate_review` in Phase
  A; the human does via `/loop-approve` (which is a command, not a tool).

**Intended shifts:**

- `test/tools-split/behavior.test.ts:250` — the test
  `"A × propose('approve') → still escalate"` is **intentionally invalidated**
  by this change. It must be rewritten to assert the new behavior (advance to
  Phase B, not escalate). This is not a quirk; it is the bug being fixed.

**Ownership:**

- `src/tools/phase0.ts` owns `executePhaseAApprove` (new function).
- `src/tools/policy.ts` owns `PROPOSE_POLICY` (the `A` entry changes).
- `src/tools/negotiate.ts` owns the dispatcher (`handlePropose` — the `switch`
  on `PROPOSE_POLICY[phase]` gains a new case or the `A` case special-cases
  approve before falling through).
- `test/tools-split/behavior.test.ts` asserts the new behavior.

## Inventory

**Files:**

| File | Change |
|---|---|
| `src/tools/policy.ts` | `PROPOSE_POLICY.A`: `"escalate"` → `"phaseA"` (new value) or keep `"escalate"` and special-case in handler (see Implementation Note) |
| `src/tools/phase0.ts` | Add `executePhaseAApprove` function |
| `src/tools/negotiate.ts` | `handlePropose`: add `"phaseA"` case to the switch (or special-case `A` + `"approve"` before the switch) |
| `test/tools-split/behavior.test.ts` | Rewrite the `"A × propose('approve')"` test; add a test for non-approve in Phase A (should still escalate) |

**Implementation Note:** Two approaches are viable:

1. **New policy value:** `PROPOSE_POLICY.A = "phaseA"`, new case in
   `handlePropose` that checks `plan === "approve"` → `executePhaseAApprove`,
   else → `executeEscalatePropose`. This is cleaner but changes the policy
   type union.

2. **Special-case in existing `"escalate"` case:** In `handlePropose`, when
   `phase === "A"` and `plan.trim().toLowerCase() === "approve"`, call
   `executePhaseAApprove` instead of `executeEscalatePropose`. The policy
   mapping stays `"escalate"`, but the handler branches. This is less clean
   (the policy name lies) but avoids a type change.

**Recommendation:** Approach 1. The policy value should match what the handler
does. The type union `ProposePolicy` gains one value; the switch gains one
case. The `"escalate"` case is unchanged (it still handles `escalated` phase
and non-approve Phase A proposals via the fallthrough).

Wait — re-reading: if `PROPOSE_POLICY.A = "phaseA"`, then non-approve
proposals in Phase A hit the `"phaseA"` case, which must then escalate. So
the `"phaseA"` case is: `if (plan === "approve") → advance; else → escalate`.
This is correct and explicit.

**Imports:**

| File | Added | Removed |
|---|---|---|
| `src/tools/phase0.ts` | `import { persistState, transitionToPhaseB } from "./state-io"` (was: `persistState` only) | — |
| `src/tools/negotiate.ts` | `import { executePhaseAApprove } from "./phase0"` | — |
| `src/tools/policy.ts` | — | — |

**Call sites:**

- `handlePropose` in `src/tools/negotiate.ts`: the `switch` statement gains a
  `"phaseA"` case. The `"escalate"` case is unchanged.

**Exports:**

- `executePhaseAApprove` is exported from `src/tools/phase0.ts` (for the
  dispatcher to import). Not a public API — internal only.

## Test Strategy

**Baseline:** 1801/1801 passing as of commit 32cc09d.

**Per-test disposition:**

| Test | File | Disposition |
|---|---|---|
| `"A × propose('approve') → still escalate (no hidden auto-advance from Phase A)"` | `test/tools-split/behavior.test.ts:250` | **Rewritten** — old assertion: `phase === "escalated"`, `result` contains `"Wait for the human's decision"`. New assertion: `phase === "B"`, `lastPhase === "A"`, `round === 1`, `notify` called with `"Approved — moving to Phase B."`, `result` does NOT contain `"Wait for the human's decision"`. |
| `"A × propose → surfaced to human, loop paused (escalated)"` (the `it.each` test at line 224) | `test/tools-split/behavior.test.ts:224` | **Kept** — this test uses a non-approve plan (`"The spec genuinely needs no new tests"`), so it still escalates. No change. |

**New tests:**

1. `"A × propose('approve') → advances to Phase B round 1"` — asserts the
   full state after the call: `phase="B"`, `lastPhase="A"`, `round=1`,
   `turnsThisPhase=1`, `justTransitioned=true`, `dispute={status:"none"}`.
   Asserts `ui.notify` called with `"Approved — moving to Phase B."` and
   `"info"` level. Asserts `ui.setStatus` called with `"Phase B — round 1"`.
   Asserts the `loop-negotiate` entry has `action: "approve"`.
2. `"A × propose('APPROVE') → advances (case-insensitive)"` — same as above
   but with uppercase input.
3. `"A × propose('approve  ') → advances (trimmed)"` — same as above with
   trailing spaces.
4. `"A × propose('not approve') → still escalates"` — asserts `phase="escalated"`,
   `lastPhase="A"`, `notify` contains the plan verbatim, `result` contains
   `"Wait for the human's decision"`.

**Untouched:** all other tests in `test/tools-split/behavior.test.ts` and the
full suite. The change is isolated to the Phase A propose handler; no other
phase or tool is affected. Mechanism: the `PROPOSE_POLICY` mapping for other
phases is unchanged, and `executeEscalatePropose` is unchanged.

**Live-toolchain rules:** N/A — no tests spawn real tools. All tests mock
`pi`, `ctx.ui`, and use in-memory state.

## Scope lines

| File | Change |
|---|---|
| `src/tools/policy.ts` | `PROPOSE_POLICY.A` value changed; `ProposePolicy` type union gains `"phaseA"` |
| `src/tools/phase0.ts` | `executePhaseAApprove` added |
| `src/tools/negotiate.ts` | `handlePropose` switch gains `"phaseA"` case |
| `test/tools-split/behavior.test.ts` | 1 test rewritten, 4 tests added |

## Acceptance Criteria

1. `npx vitest run` passes (1801 + 4 new = 1805 tests, or 1804 if the rewritten
   test replaces one).
2. `npx tsc --noEmit` is clean.
3. `grep -rn 'executePhaseAApprove' src/` returns exactly 2 hits: the definition
   in `phase0.ts` and the import in `negotiate.ts`.
4. `grep -n '"phaseA"' src/tools/policy.ts` returns exactly 1 hit (the
   `PROPOSE_POLICY.A` entry).
5. `grep -n 'executePhaseAApprove' test/` returns 0 hits (the function is
   internal; tests exercise it via `runPropose`, not by importing it directly).
6. The test `"A × propose('approve') → advances to Phase B round 1"` passes
   and asserts `state.current.phase === "B"` (not `"escalated"`).

## Dependencies

- `transitionToPhaseB` in `src/tools/state-io.ts` — existing, verified. Called
  by the new `executePhaseAApprove`.
- `captureGitBaseline` in `src/scope-check.ts` — existing (commit 32cc09d).
  Called by `applyTransitionEffect` when `effect.type === "advance" &&
  effect.phase === "B" && lastPhase === "A"`.
- `ADVANCE_PROMPTS.WRITER_PHASE_B` in `src/constants.ts` — existing.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | The `PROPOSE_POLICY` type union (`ProposePolicy`) is defined in `policy.ts` but not explicitly listed in this spec's Interface section. The spec should pin the exact union: `"phase0" \| "negotiate" \| "dispute" \| "escalate" \| "reject" \| "phaseA"`. | Accepted — added to Interface. |
