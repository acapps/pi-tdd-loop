# wire-writer-dispute-concede

## Problem

Verified current state as of writing (2026-09-04):

- `src/tools.ts:205-222` — `handleBDisputePropose`: in Phase B, `negotiate_propose` treats **every** input as a new dispute. There is no branch for the Writer accepting the test. Any `plan` string (including the literal `"agree"`) increments `disputeCount` (line 212), checks the `maxDispute` limit (line 215, default 3 per `src/commands.ts:109`), logs a `loop-dispute` entry, and calls `triggerDisputeReview` (line 221), which sets `awaitDisputeReview = true`.
- `src/events/agent-settled/dispute.ts:45-63` — `handleDisputeReview` then delivers `GP.promptTesterReviewWriterDispute(state.current.lastProposal)` to the Tester on settle. The claim slot is whatever string the Writer passed — including `"agree"`.
- `src/generic-prompts.ts:77-84` — that prompt reads, verbatim:
  ```
  TESTER (dispute review). The Writer disputed a test:

  ${claim}

  Use negotiate_review to proceed:
    - decision='approve' → you concede: the test is wrong; you will fix it
    - decision='<your rebuttal>' → you defend the test; the Writer must fix the code

  Do not write files. Call negotiate_review now.
  ```
  A claim of `"agree"` presents a *concession* as a *dispute*, and the prompt's own instructions tell the Tester that `approve` means "you concede: the test is wrong". The Tester, seeing the Writer concede, follows the instructions and approves — which `handleBDisputeReview` (src/tools.ts:344-359, `disputeMode` false → `executeBDisputeConcede`, line 396-404) reads as "the test is wrong; Tester will fix it", setting `disputeMode = true` + `awaitDisputeFix = true`. The dispute is not closed; it mutated into a Tester fix window for a test nobody said is wrong.

**Runtime evidence:** session `01a069ac-de27-758c-957b-9c4f840061ef` (spec `internal/spec-command.md`, 2026-09-04), Phase B:

1. Writer files Dispute #1 (stale pins in `test/extension.test.ts` + `test/events/registration-surface.test.ts`).
2. Tester review turn: Writer is the filer, so the *Tester* reviews — but the turn that ran was addressed to the Writer-role context and the Writer, asked to respond, called `negotiate_propose("agree")` to concede. Logged: `Dispute #2: agree` (count incremented), `loop-dispute action=dispute claim="agree"`.
3. `handleDisputeReview` delivered the prompt above with claim `"agree"`; the Tester approved, believing it was confirming the concession.
4. Writer re-filed the real claim as Dispute #3 → `disputeCount >= maxDispute` (3) → escalation.
5. Recovery required a human `/loop-continue`.

The `negotiate` phase already has the correct shape for the same word: `handleNegotiatePropose` (src/tools.ts:188-196) special-cases `plan === "agree"` into `executeNegotiateAgree`. Phase B has no equivalent.

**Adjacent specs checked, not duplicates:**

- `bug-dispute-block-trap.md` (repo root) — the *tool block* during the review window (all tools blocked → filer trapped probing). Different mechanism; its write-block text was already updated (the session shows `Negotiation is discussion-only. No file writes allowed.`).
- `bug-dispute-fix-redundant-turn.md` (repo root) — the *Tester* re-prompted for a fix it already made. Different actor, different flag (`awaitDisputeFix` delivery).
- `internal/bug-gate-green-stays-green.md` row 4 — extends the *negotiate-phase* `'agree'` no-op only; Phase B is out of its table.

## Target

In Phase B, the Writer has a real way to close a dispute it filed: `negotiate_propose("agree")` (case-insensitive, trimmed — same predicate shape as `isApproval`, src/tools.ts:51-53) is a **concession**, not a filing. It does not increment `disputeCount`, does not log a `loop-dispute` entry, clears `awaitDisputeReview` and `disputeMode`, and tells the Writer the dispute is closed and the next settle resumes the normal Phase B gate. Any other `plan` string files a dispute exactly as today. The Tester-facing review prompt can no longer receive a bare concession as its claim, because a concession never reaches `handleDisputeReview`.

## Interface

- `handleBDisputePropose` (src/tools.ts:205) gains an early branch, evaluated **before** `disputeCount++`:
  ```ts
  if (isConcession(plan)) { return executeWriterConcedeDispute(state, pi, debug, ctx); }
  ```
  with `isConcession(plan: string): boolean` → `plan.trim().toLowerCase() === "agree"` (new private helper next to `isApproval`; pinned so a future `isApproval` widening does not silently change dispute semantics).
- New private `executeWriterConcedeDispute(state, pi, debug, ctx)` in `src/tools.ts`:
  - debug: `Writer conceded — dispute closed`
  - state mutations, in order: `disputeMode = false`, `awaitDisputeReview = false`, `negotiateFeedback = ""`; `persistState(state, pi)`
  - returns tool result text, verbatim: `Dispute closed. The tests stand. Continue Phase B; the gate runs when your turn ends.`
  - No `loop-dispute` entry, no `disputeCount` change, no `sendUserMessage` (the Writer keeps its own turn; the normal settle path resumes the gate).
- `LoopState` (src/types.ts): no new fields — the concession reuses existing flags. Persisted state: a `loop-state` entry written mid-dispute by an old build (with `awaitDisputeReview: true`) restores exactly as today; nothing migrates.
- `negotiate_propose` tool description (src/tools.ts:151): updated, verbatim: `"Propose an implementation approach, dispute a test, or concede with 'agree'."`

## Behavior

Decision table for `negotiate_propose` in Phase B (first-match-wins; the negotiate-phase and other-phase rows are unchanged):

| # | Condition | Effect | `disputeCount` | `awaitDisputeReview` | `disputeMode` | Next event |
|---|---|---|---|---|---|---|
| 1 | `isConcession(plan)` true | `executeWriterConcedeDispute` | unchanged | `false` | `false` | Writer's turn ends → normal B settle → gate |
| 2 | `disputeCount + 1 >= maxDispute` (after increment) | escalation (today's path, src/tools.ts:215-217) | incremented | unchanged | unchanged | escalated |
| 3 | otherwise | file dispute (today's path: log + `triggerDisputeReview`) | incremented | `true` | unchanged | settle → `handleDisputeReview` → Tester review turn |

Evaluation order is load-bearing: row 1 is checked before the increment, so a concession can never trip the escalation limit.

Side-effect contract for row 1: one `loop-state` entry (`persistState`), one debug line, the pinned tool-result string. No `ui.notify`, no `sendUserMessage`, no `loop-dispute` entry.

Verbatim pins:

- Tool result (row 1): `Dispute closed. The tests stand. Continue Phase B; the gate runs when your turn ends.`
- Debug (row 1): `Writer conceded — dispute closed`
- Tool description: `Propose an implementation approach, dispute a test, or concede with 'agree'.`

Quirks (current behavior, do not fix):

- `handlePropose` sets `state.current.lastProposal = plan` (src/tools.ts:178) for **all** phases before dispatch, including a Phase B concession. After this change, `lastProposal` may hold `"agree"` with no open dispute. Nothing reads `lastProposal` outside the dispute-review and negotiate paths (caller sweep: `src/events/agent-settled/dispute.ts:54-55`, `src/events/agent-settled/negotiate.ts`), and both are gated on flags the concession clears — so the stale value is inert. Pinned, not cleaned.
- `triggerDisputeReview`'s result text still reads `Dispute filed. STOP producing tool calls. …` (src/tools.ts:249) — the "STOP producing tool calls" phrasing that `bug-dispute-block-trap.md` proposed rewording. Out of scope here; that spec owns it.

Intended shifts:

- A Writer that concedes in Phase B no longer burns a `maxDispute` slot. Before: concession was impossible; the only "concede" was to file `"agree"` as a dispute (cost: 1 slot + a confused Tester turn + likely escalation). After: cost is zero slots, dispute closed in-turn.
- The Tester review prompt (`promptTesterReviewWriterDispute`) can no longer be delivered a claim of `"agree"`, because that string no longer files. Its instructions are **not** edited in this unit — with the concession path, the prompt's existing semantics (approve = you concede the test) are only ever reached with a genuine dispute claim.

Ownership: `src/tools.ts` performs the branch and the concession; `test/extension.test.ts` asserts the command/tool-level behavior (existing home for `negotiate_propose` tests) and `test/prompts.test.ts` keeps asserting the unchanged prompt strings.

## Inventory

- `src/tools.ts`: added `isConcession` (private), added `executeWriterConcedeDispute` (private), modified `handleBDisputePropose` (early branch), modified `negotiate_propose` description string. No imports added.
- `src/types.ts`: untouched.
- `src/generic-prompts.ts`: untouched (both dispute prompts kept verbatim).
- `src/events/agent-settled/dispute.ts`: untouched — `handleDisputeReview`'s flag gate (`awaitDisputeReview`, line 47) already prevents delivery when the concession cleared the flag.
- `src/languages/typescript.ts` (and go/java prompt tables): the Phase B prompts say `Dispute wrong tests via negotiate_propose.` — still true. One line added to each language's `promptWriterPhaseB` and `promptWriterPhaseBContinue`: `Concede with negotiate_propose("agree") if the test is correct and your code is wrong.` — pinned verbatim; three language files, two prompts each.
- `test/extension.test.ts`: new concession cases (see Test Strategy).
- `test/prompts.test.ts`: new pin for the added prompt line ×3 languages ×2 prompts; existing prompt pins kept (the added line is appended, not a rewrite — verify the existing assertions match on substring, not full-string, before editing; if any pin is a full-string equality, it is rewritten old→new, counted below).

## Test Strategy

- Baseline: `npx vitest run` green (1150 passed, 12 skipped as of writing); `npx tsc --noEmit` clean.
- Per-test disposition:
  - Kept: all existing `negotiate_propose` Phase B dispute-filing tests (count at implementation: enumerate the `describe` blocks in `test/extension.test.ts` that assert `disputeCount` increment / `awaitDisputeReview` set — each stays green because row 3 is byte-identical to today for non-concession input).
  - Kept: all `negotiate_review` / dispute-review tests — `handleBDisputeReview` is untouched.
- New tests (all in-process, mocked `TestAPI`, no toolchain):
  1. Phase B, `negotiate_propose("agree")` → `disputeCount` unchanged, `awaitDisputeReview` false, `disputeMode` false, no `loop-dispute` entry appended, tool result equals the pinned string.
  2. Variant matrix for `isConcession` via the tool: `"agree"`, `"  AGREE  "`, `"agreed"` (must file, not concede — pins the exact-match predicate), `"I agree with the tests"` (must file).
  3. Concession does not trip the limit: `disputeCount = maxDispute - 1`, then `negotiate_propose("agree")` → phase stays `B`, not `escalated`.
  4. Filing still escalates at the limit: `disputeCount = maxDispute - 1`, then `negotiate_propose("test X is wrong")` → escalated (regression pin for row 2).
  5. `handleDisputeReview` with `awaitDisputeReview: false` returns `{ handled: false }` and sends no message (existing behavior, pinned so the post-concession settle can't deliver a stale review).
  6. Prompt pins: the new line appears in `promptWriterPhaseB`/`promptWriterPhaseBContinue` for go, java, typescript (3×2 assertions in `test/prompts.test.ts`).
- Untouched: `test/gate-signal-integrity.test.ts`, `test/transitions.test.ts`, `test/events/**` stay unchanged; the mechanism is that rows 2–3 of the decision table are the existing code path.
- Live-toolchain rules: not applicable — no test spawns a real tool.

## Scope lines

- `src/tools.ts`: `isConcession` + `executeWriterConcedeDispute` added; `handleBDisputePropose` modified; tool description modified; everything else kept.
- `src/languages/{go,java,typescript}.ts`: one line added to two prompts each; everything else kept.
- `src/generic-prompts.ts`, `src/types.ts`, `src/events/**`: untouched.
- `bug-dispute-block-trap.md`, `bug-dispute-fix-redundant-turn.md` (repo root): untouched — different failure classes, still open.

## Acceptance Criteria

- `npx vitest run` green (38 files) and `npx tsc --noEmit` clean.
- Grep sweep 1 (functional): `rg -n "executeWriterConcedeDispute" src/` → defined once in `src/tools.ts`, called once (the row-1 branch).
- Grep sweep 2 (functional): `rg -n 'disputeCount\+\+' src/tools.ts` → exactly 1 occurrence, and it is not reachable from the concession branch (the branch returns before it — verified by test 3).
- Grep sweep 3 (textual): `rg -n "Concede with negotiate_propose" src/languages/` → exactly 6 occurrences (3 languages × 2 prompts).
- Grep sweep 4 (textual): `rg -n "Dispute closed. The tests stand" src/ test/` → 1 in `src/tools.ts`, ≥1 in `test/extension.test.ts`.
- One criterion per decision-table row: row 1 → tests 1–4; row 2 → test 4; row 3 → existing filing tests (named in Test Strategy).

## Dependencies

- None upstream. Independent of `bug-dispute-block-trap.md` and `bug-dispute-fix-redundant-turn.md` (different mechanisms); can land in any order with them.
- `internal/bug-gate-green-stays-green.md` row 4 (negotiate-phase `'agree'` no-op) — implemented; this spec extends the same word's semantics to Phase B without touching that row.

## Findings log

(empty — to be filled by Phase 0)
