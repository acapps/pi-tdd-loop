# fix-phase-a-approve-advance

## Problem

**Verified current state as of writing (commit cd9abf7):**

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

- `src/tools/policy.ts`: `PROPOSE_POLICY.A` changes from `"escalate"` to
  `"phaseA"`. The `ProposePolicy` type union gains one value:
  `"phase0" | "negotiate" | "dispute" | "escalate" | "reject" | "phaseA"`.
- `src/tools/phase0.ts`: new function `executePhaseAApprove`. Calls
  `transitionToPhaseB` (the shared helper), then **overrides**
  `state.current.lastPhase = "A"` before the helper persists. Rationale:
  `resetForPhaseB` (called inside `transitionToPhaseB`) hardcodes
  `lastPhase = "negotiate"` (`src/tools/state-io.ts:34`) because the helper
  was written for the negotiate → B path. For the Phase A approve path, the
  semantic origin is `"A"`, and the scope-check baseline re-capture
  (`src/tools/state-io.ts:89`, `src/events/agent-settled/effect-applicator.ts:115`)
  already lists `"A"` as a valid origin — so the override is safe and correct.
- `src/tools/types.ts`: new helper `isPhaseAApproval(plan: string): boolean`,
  defined as `plan.trim().toLowerCase() === "approve"`. This is a **new**
  helper, not a reuse of `isApproval` — see Behavior for the rationale.

**Persisted state:** no new fields. `phase`, `round`, `turnsThisPhase`,
`justTransitioned`, `dispute` are set by `transitionToPhaseB` /
`resetForPhaseB` (existing, verified in `src/tools/state-io.ts:20-41`).
`lastPhase` is set by `resetForPhaseB` to `"negotiate"`, then **overridden**
to `"A"` by `executePhaseAApprove` before `persistState` runs.

## Behavior

**Decision table for `negotiate_propose` in Phase A:**

| Condition | Action | State after | Effect |
|---|---|---|---|
| `isPhaseAApproval(plan)` is true | `executePhaseAApprove` | `phase="B"`, `lastPhase="A"`, `round=1`, `turnsThisPhase=1`, `justTransitioned=true`, `dispute={status:"none"}` | `advance` to Phase B, `notify="Approved — moving to Phase B."`, `prompt=WRITER_PHASE_B` |
| `isPhaseAApproval(plan)` is false | `executeEscalatePropose` (existing) | `phase="escalated"`, `lastPhase="A"` | `escalated`, `notify=<plan verbatim>`, `status="escalated (proposal surfaced)"` |

**Evaluation order:** `isPhaseAApproval(plan)` is checked first in the
`"phaseA"` case of `handlePropose`. If true, `executePhaseAApprove`.
Otherwise, `executeEscalatePropose` (existing path, unchanged).

**Approve-detection predicate:**

`isPhaseAApproval(plan: string): boolean` in `src/tools/types.ts`:

```ts
export function isPhaseAApproval(plan: string): boolean {
  return plan.trim().toLowerCase() === "approve";
}
```

This is a **new helper**, deliberately distinct from `isApproval`
(`src/tools/types.ts:56`, which accepts `"approve" | "approved"` with no
trim or case-folding). Rationale: `isApproval` is for `negotiate_review`
decisions (a different tool, a different semantic — the human's review
verdict). `isPhaseAApproval` is for `negotiate_propose` in Phase A (the
Tester's self-approval of the contract). The two paths have different
input sources (human-typed review decision vs. LLM-generated proposal text),
so they warrant different predicates. The Phase 0 path
(`handlePropose` case `"phase0"`, `plan === "approve"`) is **unchanged** —
it is not in scope for this spec.

**Verbatim pins:**

- `notify` on approve: `"Approved — moving to Phase B."` (same string as
  `transitionToPhaseB` in `src/tools/state-io.ts:25`).
- `prompt` key: `ADVANCE_PROMPTS.WRITER_PHASE_B` (`"writer_phase_b"`).
- `status`: `"Phase B — round 1"`.
- `ToolResult` text on approve: `"Approved. Moving to Phase B."` — the
  signal to the Tester/agent that the tool call succeeded. (Distinct from
  the `notify` string, which is for the human.)
- `ESCALATE_NOTICE` (for non-approve): unchanged — `"Your proposal has been
  surfaced to the human and the loop is paused. Wait for the human's decision
  — do not take further action. To resume: /loop-continue (or /loop-restart
  <phase>)."`.

**Side-effect contract (approve path), in order:**

1. `pi.appendEntry("loop-negotiate", { phase: "A", round: <current>, action: "approve", text: plan.slice(0, 500) })`
2. `transitionToPhaseB(state, pi, ctx, debug)` — internally calls
   `resetForPhaseB(state)` (sets `phase="B"`, `lastPhase="negotiate"`,
   `round=1`, `turnsThisPhase=1`, `justTransitioned=true`,
   `dispute={status:"none"}`, clears `negotiateReprompted`,
   `negotiateProposed`, `negotiateFeedback`, `negotiateResolution`), then
   `applyTransitionEffect` (persists, sets status, re-captures scope-check
   baseline, notifies, delivers advance prompt).
3. **Override:** `state.current.lastPhase = "A"` — corrects the
   `resetForPhaseB` hardcode. This runs AFTER `transitionToPhaseB` returns
   (i.e., after the state is already persisted with `lastPhase="negotiate"`).
   The override is a second mutation that must be persisted: call
   `persistState(state, pi, debug)` again after the override.

   **Wait — this is wrong.** `transitionToPhaseB` calls `persistState`
   internally (via `applyTransitionEffect`). If we override `lastPhase`
   after `transitionToPhaseB` returns, we need a second `persistState`
   call. This is correct but slightly unusual. Alternative: extract the
   `resetForPhaseB` logic, set `lastPhase="A"` BEFORE calling
   `applyTransitionEffect`, so there is only one persist.

   **Chosen approach:** `executePhaseAApprove` does NOT call
   `transitionToPhaseB`. Instead it replicates the two steps:
   (a) `resetForPhaseB(state)` — but with `lastPhase` set to `"A"` instead
   of `"negotiate"`. Since `resetForPhaseB` is private to `state-io.ts`,
   the cleanest path is: call `transitionToPhaseB` (which does the full
   sequence including persist + notify + deliverAdvancePrompt), then
   override `lastPhase = "A"` and call `persistState` again. Two persists
   is acceptable — the second one is a correction, not a new transition.

   **Final sequence:**
   1. `pi.appendEntry("loop-negotiate", ...)` (action: "approve")
   2. `transitionToPhaseB(state, pi, ctx, debug)` — full helper, one persist
   3. `state.current.lastPhase = "A"` — override
   4. `persistState(state, pi, debug)` — second persist (correction)
   5. `return { content: [{ text: "Approved. Moving to Phase B." }] }`

4. (steps 2-5 above are the full sequence; no additional side effects)

**Quirks list:**

- **Current behavior, do not fix:** non-approve proposals in Phase A still
  escalate. The `escalated` state is correct for genuine escalations (dispute
  limit, gate error, human-directed work outside the loop). Only the `"approve"`
  case changes.
- **Current behavior, do not fix:** `negotiate_review` in Phase A is still
  `"reject"` (unchanged). The Tester does not call `negotiate_review` in Phase
  A; the human does via `/loop-approve` (which is a command, not a tool).
- **Current behavior, do not fix:** the Phase 0 approve path
  (`handlePropose` case `"phase0"`, `plan === "approve"`) uses a bare string
  comparison, not `isPhaseAApproval`. This is intentional — Phase 0 is a
  different semantic (human review verdict) and is not in scope.

**Intended shifts:**

- `test/tools-split/behavior.test.ts:250` — the test
  `"A × propose('approve') → still escalate"` is **intentionally invalidated**
  by this change. It must be rewritten to assert the new behavior (advance to
  Phase B, not escalate). This is not a quirk; it is the bug being fixed.
- The scope-check baseline re-capture in `src/tools/state-io.ts:89` and
  `src/events/agent-settled/effect-applicator.ts:115` checks
  `lastPhase === "A" || lastPhase === "negotiate"`. After this change, the
  Phase A approve path will have `lastPhase="A"` (not `"negotiate"`), so the
  re-capture will fire on the `"A"` branch. This is the correct behavior —
  the baseline should be re-captured when entering Phase B from Phase A.

**Ownership:**

- `src/tools/phase0.ts` owns `executePhaseAApprove` (new function).
- `src/tools/policy.ts` owns `PROPOSE_POLICY` (the `A` entry changes).
- `src/tools/negotiate.ts` owns the dispatcher (`handlePropose` — the `switch`
  gains a `"phaseA"` case).
- `src/tools/types.ts` owns `isPhaseAApproval` (new helper).
- `test/tools-split/behavior.test.ts` asserts the new behavior.

## Inventory

**Files:**

| File | Change |
|---|---|
| `src/tools/policy.ts` | `PROPOSE_POLICY.A`: `"escalate"` → `"phaseA"`; `ProposePolicy` type union gains `"phaseA"` |
| `src/tools/phase0.ts` | Add `executePhaseAApprove` function; import `transitionToPhaseB` from `./state-io` (already imports `persistState` from same module) |
| `src/tools/negotiate.ts` | `handlePropose`: add `"phaseA"` case to the switch; import `executePhaseAApprove` from `./phase0`; import `isPhaseAApproval` from `./types` |
| `src/tools/types.ts` | Add `isPhaseAApproval` helper |
| `test/tools-split/behavior.test.ts` | Rewrite the `"A × propose('approve')"` test; add 4 new tests |

**Implementation Note:** `PROPOSE_POLICY.A = "phaseA"`. The `"phaseA"` case
in `handlePropose` is: `if (isPhaseAApproval(plan)) → executePhaseAApprove;
else → executeEscalatePropose`. The `"escalate"` case is unchanged (it still
handles the `escalated` phase). Non-approve Phase A proposals hit the
`"phaseA"` case and fall through to `executeEscalatePropose` — same behavior
as today, just routed through a different case label.

**Imports:**

| File | Added | Removed |
|---|---|---|
| `src/tools/phase0.ts` | `import { persistState, transitionToPhaseB } from "./state-io"` (was: `persistState` only) | — |
| `src/tools/negotiate.ts` | `import { executePhaseAApprove } from "./phase0"`; `import { isPhaseAApproval } from "./types"` | — |
| `src/tools/policy.ts` | — | — |
| `src/tools/types.ts` | — (no new imports; `isPhaseAApproval` is a pure string function) | — |

**Call sites:**

- `handlePropose` in `src/tools/negotiate.ts`: the `switch` statement gains a
  `"phaseA"` case. The `"escalate"` case is unchanged.

**Exports:**

- `executePhaseAApprove` is exported from `src/tools/phase0.ts` (for the
  dispatcher to import). Not a public API — internal only.
- `isPhaseAApproval` is exported from `src/tools/types.ts` (for the dispatcher
  to import). Not a public API — internal only.

## Test Strategy

**Baseline:** 1801/1801 passing as of commit cd9abf7.

**Per-test disposition:**

| Test | File | Disposition |
|---|---|---|
| `"A × propose('approve') → still escalate (no hidden auto-advance from Phase A)"` | `test/tools-split/behavior.test.ts:250` | **Rewritten** — old assertion: `phase === "escalated"`, `result` contains `"Wait for the human's decision"`. New assertion: `phase === "B"`, `lastPhase === "A"`, `round === 1`, `notify` called with `"Approved — moving to Phase B."`, `result.content[0].text` is `"Approved. Moving to Phase B."`. |
| `"A × propose → surfaced to human, loop paused (escalated)"` (the `it.each` test at line 224) | `test/tools-split/behavior.test.ts:224` | **Kept** — this test uses a non-approve plan (`"The spec genuinely needs no new tests"`), so it still escalates. No change. |

**New tests:**

1. `"A × propose('approve') → advances to Phase B round 1"` — asserts the
   full state after the call: `phase="B"`, `lastPhase="A"`, `round=1`,
   `turnsThisPhase=1`, `justTransitioned=true`, `dispute={status:"none"}`.
   Asserts `ui.notify` called with `"Approved — moving to Phase B."` and
   `"info"` level. Asserts `ui.setStatus` called with `"Phase B — round 1"`.
   Asserts the `loop-negotiate` entry has `action: "approve"`.
   Asserts `result.content[0].text` is `"Approved. Moving to Phase B."`.
2. `"A × propose('APPROVE') → advances (case-insensitive)"` — same as #1
   but with uppercase input. Asserts `phase === "B"`.
3. `"A × propose('approve  ') → advances (trimmed)"` — same as #1 with
   trailing spaces. Asserts `phase === "B"`.
4. `"A × propose('not approve') → still escalates"` — asserts
   `phase="escalated"`, `lastPhase="A"`, `notify` contains the plan verbatim,
   `result.content[0].text` contains `"Wait for the human's decision"`.

**Untouched:** all other tests in `test/tools-split/behavior.test.ts` and the
full suite. The change is isolated to the Phase A propose handler; no other
phase or tool is affected. Mechanism: the `PROPOSE_POLICY` mapping for other
phases is unchanged, `executeEscalatePropose` is unchanged, and `isApproval`
(negotiate_review) is unchanged.

**Live-toolchain rules:** N/A — no tests spawn real tools. All tests mock
`pi`, `ctx.ui`, and use in-memory state.

## Scope lines

| File | Change |
|---|---|
| `src/tools/policy.ts` | `PROPOSE_POLICY.A` value changed; `ProposePolicy` type union gains `"phaseA"` |
| `src/tools/phase0.ts` | `executePhaseAApprove` added; import line updated |
| `src/tools/negotiate.ts` | `handlePropose` switch gains `"phaseA"` case; 2 imports added |
| `src/tools/types.ts` | `isPhaseAApproval` added |
| `test/tools-split/behavior.test.ts` | 1 test rewritten, 4 tests added |

## Acceptance Criteria

1. `npx vitest run` passes (1801 + 4 new = 1805 tests; the rewritten test
   replaces one, so net +4).
2. `npx tsc --noEmit` is clean.
3. `grep -rn 'executePhaseAApprove' src/` returns exactly 2 hits: the definition
   in `phase0.ts` and the import in `negotiate.ts`.
4. `grep -rn 'isPhaseAApproval' src/` returns exactly 3 hits: the definition
   in `types.ts`, the import in `negotiate.ts`, and the call in `negotiate.ts`.
5. `grep -n '"phaseA"' src/tools/policy.ts` returns exactly 2 hits: the type
   union and the `PROPOSE_POLICY.A` entry.
6. `grep -n 'executePhaseAApprove' test/` returns 0 hits (the function is
   internal; tests exercise it via `runPropose`, not by importing it directly).
7. The test `"A × propose('approve') → advances to Phase B round 1"` passes
   and asserts `state.current.phase === "B"` and `state.current.lastPhase === "A"`.

## Dependencies

- `transitionToPhaseB` in `src/tools/state-io.ts` — existing, verified. Called
  by the new `executePhaseAApprove`.
- `persistState` in `src/tools/state-io.ts` — existing, verified. Called twice
  by `executePhaseAApprove` (once via `transitionToPhaseB`, once for the
  `lastPhase` correction).
- `captureGitBaseline` in `src/scope-check.ts` — existing (commit 32cc09d).
  Called by `applyTransitionEffect` when `effect.type === "advance" &&
  effect.phase === "B" && lastPhase === "A"`.
- `ADVANCE_PROMPTS.WRITER_PHASE_B` in `src/constants.ts` — existing.

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | The `PROPOSE_POLICY` type union (`ProposePolicy`) is not explicitly listed in the Interface section. | Accepted — pinned the full union in Interface. |
| 2 | blocker | Spec claims `resetForPhaseB` sets `lastPhase="A"`. It does not — `state-io.ts:34` hardcodes `"negotiate"`, pinned by `behavior.test.ts:397`. | Accepted — spec now documents the override: `executePhaseAApprove` calls `transitionToPhaseB` (which persists with `lastPhase="negotiate"`), then overrides `lastPhase="A"` and calls `persistState` again. The two-persist sequence is pinned in the side-effect contract. |
| 3 | needs-doc | Approve-detection predicate inconsistent with `isApproval` (no trim/case-fold in `isApproval`; spec's tests demand both). | Accepted — new helper `isPhaseAApproval` in `types.ts`, defined as `plan.trim().toLowerCase() === "approve"`. Documented as deliberately distinct from `isApproval` (different tool, different input source). Phase 0 path unchanged. |
| 4 | needs-doc | `ToolResult` text not pinned. | Accepted — pinned as `"Approved. Moving to Phase B."` (distinct from the `notify` string). Added to test assertions. |
