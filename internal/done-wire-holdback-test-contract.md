# wire-holdback-test-contract

> **Scope note (Phase 0, read first).** This wires a *two-tier test contract* into
> the loop: the Tester's contract splits into a **visible** tier (the Writer's
> contract) and a **holdback** tier (withheld from the Writer, run by the normal
> gate, folded into the visible contract at settle). It is one cohesive capability
> but touches prompts, the spec template, scope-check, and the settle path. It is
> deliberately written as one spec; Phase 0 may decompose it. The natural seams are
> already marked below as **U1 / U2 / U3** — implement them in that order, each
> green on its own, because U1 is pure prompt/template change (no gate behavior
> changes) and the risk concentrates in U2.

## Problem

Verified current state as of writing:

- The loop enforces **adversarial separation** (SPEC Invariant 2): the Tester never
  sees the Writer's implementation, the Writer never modifies tests. This is
  **spatial** separation — the two roles never share a code view. It does **not**
  prevent the Writer from *reading every test*.
- The Writer sees the **entire** visible test contract. Passing it can mean
  implementing the behavior **or** reverse-engineering the test set — memorizing
  assertions, matching edge-case names, satisfying the letter without the intent.
  This is Goodhart on the contract: once the visible tests are the sole target,
  the Writer optimizes against them, not the spec. There is no mechanism that
  measures *generalization vs. memorization*.
- Test discovery is **filename-glob based**, by language (`src/languages/*.ts`):
  Go `go test ./...` runs every `*_test.go`; TS `npx vitest run` runs every
  `*.test.ts` / `*.spec.ts`; Java `mvn test` runs every `*Test.java` under the
  test source root. **A test file's directory does not affect whether the gate
  runs it.** This is the lever the whole feature rides on — isolation can be a
  visibility/scope device without touching execution.
- The **dispute lifecycle** (`src/types.ts` `DisputeState`: `filed` → `in-review`
  → `conceded` / `defended` → `closed`) already surfaces failures to the Tester
  (who owns all tests) and records `resolvedFailures` so a conceded failure is
  excluded from the Phase B gate (`src/transitions.ts:212-240`,
  `src/tools/dispute.ts:144-178`). Reveal-on-failure reuses this; it adds no new
  mechanism.
- **Scope-check** (`src/scope-check.ts`) fails the gate on Writer writes outside
  the spec's `## Inventory`. The Phase-B-entry baseline
  (`recaptureBaselineForPhaseB`) captures everything dirty at B-start as
  "pre-existing," so the Tester's Phase-A tests are never flagged as
  contamination.
- The **settle path** (`src/transitions.ts:275-290` `handlePhaseCTransition` →
  `markDone` → `doneEffect`) is the only terminal transition; the completion
  effect (`src/events/agent-settled/effect-applicator.ts`) is where a fold
  consolidation must hook.

Gap: the contract is one tier, the Writer sees all of it, and there is no
promotion step that turns the Tester's hidden probes into first-class contract at
the end of a run.

## Target

One paragraph: the shape after.

The Tester writes a **two-tier contract** in Phase A. The **visible** tier is the
Writer's contract — it lives in the spec's `## Inventory`, is shown to the Writer,
and defines "correct." The **holdback** tier is a bounded holdout set the Writer
never sees: it lives in a per-language **holdback subdir** inside the canonical
test tree, is withheld from the Writer's prompt, and is **run by the unchanged
normal gate** (glob). If a holdback test fails, the gate is red and the existing
dispute machinery surfaces it to the Tester; the Writer fixes or disputes the
*behavior* (revealed through dispute, never by reading the file). When the loop
settles green, a **consolidation step** promotes every holdback test into the
visible contract — it enters the spec `## Inventory`, is revealed to the
Writer's context going forward, and (tidiness pass) is merged from the holdback
subdir into its canonical test location so no shadow suite remains. After the
fold there is **one** contract, **one** test tree, **no** hidden directory.

## Interface

### Language config — one new field

Add to `LanguageConfig` (`src/languages/index.ts`):

```ts
holdbackSubdir: string;   // subdir of the canonical test tree that holds withheld tests
```

Values (each is *inside* the runner's test root so the gate executes them):

| Language | `holdbackSubdir` | Why here |
|---|---|---|
| go | `test/holdback` | `go test ./...` descends it |
| typescript | `test/holdback` | vitest default glob includes it |
| java | `src/test/java/holdback` | `mvn test` only runs the test source root — **must** be inside it, or the holdback set is never executed (the one language where an external dir would silently drop the tests) |

Set it in `src/languages/{go,typescript,java}.ts` alongside `testFilePattern`.
The value is the location the Tester writes the withheld tier to and the U3 merge
reads it from. The fold's *promotion* keys off the `[holdback]` Inventory tag (not
the path), and scope-check is author-agnostic — it does not use the path to
discriminate a holdback file (Findings #8, #4).

### Spec template — Inventory gains a tier

`docs/spec-authoring.md` `## Inventory` section: files are tagged
`[visible]` or `[holdback]`. `[holdback]` files are withheld from the Writer's contract surface **by prompt**
(their text never enters the Writer's context) — they are NOT excluded from
scope-check's allowed set. `parseInventory` (scope-check) strips the tags and adds
every Inventory path, so scope-check is author-agnostic and does not flag a Writer
write to a holdback file. Isolation of the holdback tier is prompt discipline, not
scope-check (Findings #8, #4). The Author agent (spec-command) must emit the tag so
the fold knows which files to promote. **This is the one doc change without which the whole
feature is unverifiable** — an untagged Inventory makes holdback indistinguishable
from visible.

### Prompt functions — three additions

`LanguageConfig.prompts` gains:

```ts
promptTesterHoldback: (holdbackSubdir: string) => string;   // Phase A: write the withheld tier here
promptWriterHoldbackNotice: (holdbackSubdir: string) => string;  // B/C: do not read/modify this dir
promptConsolidationStatus: (promoted: number, dropped: number, merged: boolean) => string; // settle: what folded
```

Wired into the existing `promptTesterPhaseA` / `promptWriterPhaseB*` /
`promptCleanerPhaseC*` via the same `(specPath, buildTool, workspaceRoot)` call
sites — the holdback subdir is passed as an extra arg, not a new prompt shape.

### State — no new persisted fields

The fold is derivable, not stored: a holdback file is "folded" iff it appears in
the spec `## Inventory` as `[visible]` after the run **and was not conceded**. A
holdback test the Tester conceded (dispute resolved in `DisputeState.resolvedFailures`)
is mis-specified by the Tester's own admission and is **dropped** — excluded from
promotion and removed from the holdback set. Removal happens **at concede time**
(reveal-on-failure step 4), not at fold — the fold's drop is defensive only. Reuse
`DisputeState.resolvedFailures` to identify conceded holdback tests at fold time (matched by
test+subtest, then mapped to their file). If Phase 0 finds a cleaner signal (e.g. a
`holdbackConsolidated: boolean`), add exactly one field — no more.

## Behavior

### Lifecycle decision table

| # | Phase | Actor | Condition | Actions (pinned order) |
|---|---|---|---|---|
| 1 | A | Tester | spec received | 1. Write the **visible** contract → canonical test location, tagged `[visible]` in Inventory. 2. Write the **holdback** contract → `holdbackSubdir`, tagged `[holdback]`. 3. Both run under the normal gate (glob). Holdback set is **complete in Phase A** — the holdout is pre-committed before the Writer implements; adding to it mid-run defeats the holdout and is a scope decision (same as extending the visible contract), enforced via the normal dispute/scope-decision path, **not** by scope-check. (scope-check is author-agnostic and, via parseInventory, puts holdback files in the allowed set, so it does not flag new holdback files — see Findings #8 and #5.) |
| 2 | B | Writer | gate red, a failure is a holdback failure | The failure is surfaced raw (Invariant 3). Because the Writer never saw it, it enters **dispute**: the Tester reviews (owns all tests), the behavior is clarified, the Writer fixes the source half or the Tester concedes the interpretation. Never let the Writer open or modify the holdback file — isolation is **prompt discipline** (the notice, row 4), the same stance as Finding #4. scope-check is **author-agnostic** and cannot distinguish a Writer's write to a holdback file from the Tester's (holdback files are baseline-captured and, via parseInventory, in the allowed set), so it does NOT flag a Writer write to a holdback file — see Findings #8 and #4. |
| 3 | B | Writer | gate green | Advance normally. Holdback tests that passed are silently carried to the fold. |
| 4 | B/C | Writer | any round | Prompt notice: `holdbackSubdir` is the Tester's withheld tier — do not read or modify it. A Writer write there is a **role violation enforced by prompt discipline** (same as read isolation, Finding #4), NOT by scope-check: scope-check is author-agnostic (holdback files are baseline-captured and in the allowed set) and cannot flag it — see Findings #8 and #4. |
| 5 | C→done | loop (effect) | Phase C gate green, about to settle | **Consolidation** (U2): 1. Promote every `[holdback]` file that was **not conceded** into the visible `## Inventory` (rewrite the tag to `[visible]`). 2. Drop every conceded `[holdback]` file still on disk — leave it out of the Inventory and remove it (defensive; the conceded test was already removed at concede time, reveal-on-failure step 4). 3. Reveal the promoted files to the Writer's context going forward (they are no longer withheld). 4. Tidiness (U3): merge each promoted file from `holdbackSubdir` into its canonical test location, remove the now-empty subdir. 5. Emit `promptConsolidationStatus(promoted, dropped, merged)`. |

- **Row 5 is the guarantee against lingering.** It runs *before* `markDone`, so
  the loop cannot report green with an un-promoted holdback tier. It is a
  precondition of completion, not an optional post-step.
- **The fold is a mechanical effect, not an agent write.** Moving files +
  rewriting the Inventory is deterministic; doing it through the agent would
  reintroduce nondeterminism and a scope-check race (the move is a write outside
  the visible Inventory). It belongs in the settle effect, after the last gate,
  where scope-check no longer runs.

### Reveal-on-failure (row 2) — what the Writer actually gets

The Writer must fix a failing holdback **without seeing it**. The path:

1. Gate is red; the failing test is a raw signal (no LLM summarization — Invariant 3).
2. The failure routes through dispute (the Writer can't attribute it to the
   visible contract it was given).
3. The Tester — who owns the holdback set — reviews. The **behavior/expectation**
   is clarified in the dispute claim/review (not the raw test file handed to the
   Writer).
4. The Tester **removes the conceded holdback test from disk at concede time**
   (Phase B). This is the existing "Tester fixes the test on concede" pattern
   (`handleBDisputeReview`, Table 2: a Writer-filed dispute → the Tester fixes the
   flagged test), specialized to *remove* for a mis-specified holdback. The removal
   is what keeps the Phase C gate green: `excludeResolvedDisputeFailures`
   (`src/events/agent-settled/gate-transition.ts:150`) excludes resolved failures
   **only in Phase B**, and the Phase C gate has **no** dispute-failure exclusion —
   so a conceded test left on disk would still fail at Phase C, the loop could not
   reach `done`, the fold would never run, and the test would never drop. That is a
   deadlock. Removing it at concede sidesteps it: the mis-specified test is gone
   before Phase C. The test is never promoted. If the Tester **defends**, the Writer
   must fix to match, and the test is promoted at fold like any surviving holdback.

Pin: the holdback test file is **never** delivered to the Writer's tool context.
Only its resolved behavior is.

### Consolidation mechanics (row 5)

- **Promote:** parse the spec `## Inventory`, flip each `[holdback]` entry to
  `[visible]`, write the spec back. The spec path is scope-allowed (it is the
  archive target), so this write is safe.
- **Drop conceded (defensive):** the primary removal happens at concede time
  (reveal-on-failure step 4). This fold-time drop is a **safety net**: if a conceded
  test somehow remains on disk at fold (the concede-time removal was not applied),
  it is excluded from promotion and removed. Promotion is file-granular: a holdback
  file containing a conceded test is dropped wholesale. Concession is terminal — a
  conceded test is never promoted, whether removed at concede or at fold.
- **Merge (U3, tidiness):** move each promoted file from `holdbackSubdir` to its
  canonical location (Go: alongside the package it tests; TS: its `describe`
  sibling; Java: its package dir), then delete the empty subdir. **This is the
  fiddly, riskiest sub-unit** — physical moves + Inventory rewriting. It is
  separable (U3) and can be a follow-up if Phase 0 judges it too fiddly to bundle;
  the contract is already fully unified after Promote + Reveal even if the subdir
  physically remains.
- **Idempotency:** if consolidation runs twice (reload between C and done), a
  second run finds no `[holdback]` entries and no files to move — a no-op. Pin a
  test for the double-run case.

## Inventory

**U1 — two-tier contract + isolation (prompt/template only; no gate behavior change):**
- `src/languages/index.ts` — `holdbackSubdir` + 3 prompt fn fields on `LanguageConfig`.
- `src/languages/go.ts`, `src/languages/typescript.ts`, `src/languages/java.ts` — set `holdbackSubdir`; thread it into `promptTesterPhaseA` (→ `promptTesterHoldback`), `promptWriterPhaseBContinue` (→ `promptWriterHoldbackNotice`), `promptCleanerPhaseC` / `promptCleanerRetry`.
- `src/generic-prompts.ts` — `promptTesterHoldback`, `promptWriterHoldbackNotice`, `promptConsolidationStatus` (language-agnostic, same section as the other flow prompts).
- `docs/spec-authoring.md` — `## Inventory` tag convention `[visible]` / `[holdback]` + the filling-prompt rule that makes it mandatory.

**U2 — fold-at-settle (the guarantee):**
- `src/transitions.ts` — call the consolidation before `markDone` in `handlePhaseCTransition`.
- `src/events/agent-settled/effect-applicator.ts` — new `consolidateEffect` (promote + status), dispatched in `applyEffect`.
- `src/scope-check.ts` — document that the holdback subdir is Tester-owned (baseline-captured); no behavior change unless Phase 0 finds the merge write racing the gate (it shouldn't — consolidation runs post-gate).

**U3 — physical merge tidiness (optional separable unit):**
- A move helper (pure path logic, unit-testable) + the file-move half of the consolidation effect.

## Test Strategy

- Baseline: existing `test/` suite green; the new behavior adds tests, rewrites none.
- **U1 tests:** `test/languages/*.test.ts` — each language's `holdbackSubdir` resolves to the pinned path; the holdback prompt fn contains the subdir and the "do not read/modify" instruction; the Writer prompt names the subdir. `test/spec-authoring` / prompt-render test — an Inventory without tags is rejected or flagged (the unverifiable-default rule).
- **U2 tests:** `test/scope-check.test.ts` — asserts only what scope-check can see (it is author-agnostic; holdback write-isolation is prompt discipline, not scope-check): (a) a Tester-written file in `holdbackSubdir` captured in the baseline is **not** flagged as contamination (this baseline-capture is what lets the Tester remove the conceded test at concede time without being flagged — see the concede-time deadlock fix); (b) a **Writer** write into `holdbackSubdir` during B is **not** flagged by scope-check (author-agnostic — this is the prompt-discipline boundary, not a scope-check failure). Do NOT assert Writer-write-to-holdback is flagged; that would contradict the author-agnostic design (Finding #8). `test/events/agent-settled/*.test.ts` — the consolidation effect flips `[holdback]`→`[visible]` in the Inventory, emits the status prompt, and is idempotent on a second run. `test/transitions.test.ts` — Phase C green triggers consolidation **before** `markDone`; a run with an un-promoted holdback tier cannot reach `done`.
- **Drop-concede (the drop feature's reliability crux):** `test/events/agent-settled/consolidation.test.ts` — one consolidation run over a **mixed** set (one conceded holdback test named in `resolvedFailures`, one non-conceded) drops the conceded file — absent from the post-fold Inventory **and** removed from disk — while promoting the non-conceded one (`[visible]`, file retained). The fixture's conceded entry is keyed by **test+subtest**, and the assertion checks that the file mapped from that test+subtest is the one dropped (not a sibling). This pins the test-to-file mapping — "matched by test+subtest, then mapped to their file" — because a wrong mapping would drop the correct file and promote the conceded one, the exact failure mode of the confirmed gap.
- **Deadlock fix (Phase C not blocked):** the same suite must assert the concede-time removal keeps the loop moving — after a concede, the conceded holdback test is **removed from disk at concede time**, so a subsequent **Phase C** gate run — `excludeResolvedDisputeFailures` excludes resolved failures **only in Phase B**, so Phase C has no dispute fallback — is green *because the file is gone, not because the gate masked it*. The assertion: a conceded holdback test does not block the Phase C gate from reaching `done`. This is the deeper half of the confirmed gap and the reason removal is at concede, not at fold.
- **U3 tests:** the move helper — a file moves from `holdbackSubdir` to its canonical location and the subdir is removed; a non-empty subdir is left intact (only the empty one is deleted).
- **Live-toolchain rules (class M):** this feature adds **no** test that spawns a real
  tool in a temp dir — the holdback tests themselves are the feature's subject,
  written by the Tester against the *target project*, not a scaffold. N/A. If Phase 0
  adds an e2e that runs `/loop` on a golden project with a holdback tier, it must
  satisfy all four class-M pins in `docs/spec-authoring.md` (fixture buildability,
  tool probe, timeout, verdict field) and live in `test/e2e/`, not the default suite.
- Untouched: the normal gate command, the test parser (`fillTestResults`), and the
  dispute review decision logic — holdback failures flow through the **existing**
  red-gate + dispute path. Name this explicitly: the gate does not special-case
  holdback failures; it reports them like any failure, and dispute resolves them.

## Scope lines

- `src/gates.ts` — **unchanged.** The gate runs the whole glob; it does not know or care which failures are holdback. (If Phase 0 wants an isolated holdback sub-run for a cleaner signal, that is a *separate* change with a speed cost — see Findings row 1 — not this spec.)
- `src/transitions.ts` — one call site added (consolidation before `markDone`); dispute/advance paths unchanged.
- `src/tools/dispute.ts` — **unchanged**; holdback failures already route through it.
- `src/scope-check.ts` — **unchanged (author-agnostic).** It enforces cross-spec contamination only; it does NOT enforce holdback write-isolation and cannot (holdback files are baseline-captured and, via parseInventory, in the allowed set, so a Writer write to them is not flagged). Holdback write-isolation is prompt discipline, the same stance as read-isolation (Finding #4). Post-gate consolidation avoids the race.
- Test tree — visible tests untouched; holdback tests are new, in `holdbackSubdir`.

## Acceptance Criteria

- [ ] Each language's `holdbackSubdir` is set and asserted in `test/languages/*` (3 hits, one per language).
- [ ] The Tester Phase A prompt instructs writing the holdback tier into `holdbackSubdir`; the Writer/Cleaner prompts name that subdir as read/modify-forbidden (grep the rendered prompt fixtures).
- [ ] The `[holdback]` tag keeps holdback files identifiable for the fold;
  enforcement of the withheld tier is **prompt discipline**, not scope-check.
  `test/scope-check.test.ts` asserts only what scope-check can actually see (Scope
  lines): a Tester-written holdback file captured at B-start is baseline-captured
  and **not** flagged; a Writer write into the subdir is **not** flagged either
  (author-agnostic — prompt discipline). It does NOT assert Writer-write-to-holdback
  is flagged.
- [ ] A Tester-written holdback file captured at B-entry is **not** flagged as contamination (baseline).
- [ ] Consolidation runs before `markDone` on Phase C green and flips every `[holdback]`→`[visible]` in the spec Inventory (`test/transitions.test.ts` + `test/events/agent-settled/*`).
- [ ] Consolidation is idempotent on a second run (no `[holdback]` entries, no files moved).
- [ ] **Drop-concede (U2):** given a mixed holdback set, a *conceded* holdback test is dropped — absent from the post-fold `## Inventory` and its file removed from disk — while a *non-conceded* holdback test is promoted (`[visible]`, file retained). Asserted in `test/events/agent-settled/consolidation.test.ts`, which seeds `resolvedFailures` with a test+subtest name and asserts the *correct file* is dropped vs promoted — exercising the test-to-file mapping ("matched by test+subtest, then mapped to their file"). **The concede removes the test from disk at concede time (Phase B), so the Phase C gate — which excludes no dispute failures — is green and the loop reaches `done`; assert a conceded test does not block the Phase C gate.**
- [ ] U3 (if bundled): each promoted file lands in its canonical test location and the empty `holdbackSubdir` is removed; a non-empty subdir is preserved.
- [ ] Full test run green (unit incl. `test/`, e2e if added) — name the suites.
- [ ] `npx tsc --noEmit` clean (the test run does not type-check the new `holdbackSubdir` field's absence — assert it).
- [ ] Grep sweeps: no dangling reference to a holdback concept outside the three language configs + the effect; the visible test parser in `gates.ts` has no holdback branch.

### Soft vs hard

- Hard: criteria above are all mechanical (grep, test run, type-checker, idempotency).
- Soft (name the judgment): "the merge places each file in its *canonical* location."
  There is no line-count/exact-path proxy — a file is correctly placed iff the full
  suite still compiles and passes *and* the holdback subdir is empty. Verify by the
  test run, not by matching a path string. If Phase 0 forces a hard path AC here,
  it is forcing the merge for the wrong reason (see the soft/hard guidance in the template).

## Findings log

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | needs-doc | An **isolated holdback sub-run** (`go test ./test/holdback/...`, `vitest run test/holdback/`) would give a clean holdback-only failure signal without path-mapping Go failures to files. Cost: a second test invocation (speed rule) and a new gate axis. | **Rejected for U1/U2.** The normal glob already runs holdbacks; red-gate + dispute already surfaces failures. A sub-run is a candidate *follow-up* if reveal-on-future proves fuzzy, not a requirement. Speed rule (CLAUDE.md) weighs against it. |
| 2 | needs-doc | **Java holdback must live inside `src/test/java`.** An external dir is never executed by `mvn test`, so a "clean" isolation would silently drop the holdback set — the worst failure mode (silent green). | **Pinned:** `holdbackSubdir` for java is `src/test/java/holdback`, asserted in tests. This is the language where isolation has a hard execution constraint. |
| 3 | blocker-to-decide | **Physical merge (U3) is the riskiest unit** — moving files + rewriting the markdown Inventory is deterministic-but-fiddly, and a mid-run move races scope-check. | **Separable.** U1 + U2 deliver a fully unified *contract* (Inventory + reveal) without any file move. U3 is optional tidiness; Phase 0 may defer it to a follow-up and ship the subdir as a first-class, Inventory-owned folder. The guarantee against lingering (row 5) holds via Promote + Reveal alone. |
| 4 | nit | scope-check is **author-agnostic**: it catches neither the Writer *reading* a holdback file NOR a Writer *writing* one (holdback files are baseline-captured and, via parseInventory, in the allowed set, so a Writer write is not flagged). Isolation of both reads and writes is prompt discipline. | **Accepted, flagged.** Holdback isolation (read AND write) is prompt discipline — the same mechanism, not scope-check. scope-check enforces cross-spec contamination only. This is the stance behind Finding #8's resolution. Combined with "do not read/modify the subdir" in the Writer prompt and the fact that a holdback failure routes through dispute (the Writer gets the behavior, not the file), tampering is neither norable nor productive. If a hard guarantee is desired later, isolate the subdir outside the Writer's git scope — a separate enforcement change (next-step #3). |
| 5 | nit | Adding holdback tests mid-run (after B-entry) was stated to fail scope-check (dirty-but-not-in-baseline), but scope-check is author-agnostic and (via parseInventory) puts holdback files in the allowed set, so it does not flag them. | **Pinned:** the holdback set is **frozen at Phase A** by design — the holdout is pre-committed before the Writer implements, and extending it mid-run is a scope decision (same as extending the visible contract), enforced via the normal dispute/scope-decision path, NOT by scope-check. See also Finding #8. |
| 6 | blocker | **Confirmed gap (Phase 0):** a conceded holdback test was promoted into the Writer's contract. Concession records the failure in `resolvedFailures` (Phase B gate excludes it) but never removes the test from the holdback set, so row 5 promotes it. | **Resolved:** conceded holdback tests are dropped — excluded from promotion and removed at fold (State definition of "folded", Row 5 steps 1–2, Consolidation mechanics drop bullet, reveal-on-failure step 4). Promotion is file-granular; a conceded test drops its whole holdback file. **Test-locked:** Acceptance criterion (drop-concede) + `test/events/agent-settled/consolidation.test.ts`, which asserts the file mapped from the conceded test+subtest is the one dropped. |
| 7 | blocker | **Confirmed gap (Phase 0, deeper):** a conceded holdback test deadlocks the loop at Phase C. `excludeResolvedDisputeFailures` (gate-transition.ts:150) excludes resolved failures **only in Phase B**; the Phase C gate has **no** dispute exclusion. The spec's drop runs at fold (Row 5, Phase C→done) — *after* Phase C. A conceded test stays on disk and still fails; at Phase C it is not excluded, the gate is red, the loop never reaches `done`, the fold never runs, and the test is never dropped. Deadlock. The existing dispute flow avoids this because on concede the counterpart "fixes the test" (`handleBDisputeReview`, Table 2) — a disk change *before* Phase C; the holdback spec deferred removal to fold. | **Resolved by option (a):** the Tester removes the conceded holdback test from disk **at concede time (Phase B)**, consistent with the existing "Tester fixes the test on concede" pattern; the fold's drop is defensive (Row 5, Consolidation mechanics). The Phase C gate is left unchanged. Test-locked by the drop-concede AC + `consolidation.test.ts`, which asserts the conceded test is removed at concede and does not block the Phase C gate. Option (b) — extending the exclusion to Phase C — rejected: it masks a red test instead of removing the mis-specified one, and `resolvedFailures` may not survive to Phase C. |
| 8 | blocker | **Confirmed gap (Phase 0):** the spec asserts scope-check enforces "Writer must not modify the holdback tier" (Row 2, Row 4, AC, Test Strategy U2-b), but scope-check is author-agnostic: parseInventory (scope-check.ts:80) strips the `[visible]`/`[holdback]` tags → holdback paths enter the allowed set; captureGitBaseline captures all B-start dirty files → holdback files are baseline-captured; checkScope flags only files that are dirty, not in the allowed set, and not in the baseline — with no author tracking. So a Writer write to a holdback file is dirty + in-allowed + in-baseline → not flagged. Satisfying the stated AC requires author-aware scope-check, which the design lacks and the Scope lines forbid. | **Resolved by option (a) — prompt discipline:** scope-check is left author-agnostic and enforces cross-spec contamination only (Scope lines). Holdback write-isolation is prompt discipline, the same stance as read-isolation (Finding #4). Row 2, Row 4, the AC, Test Strategy U2-b, the Interface Inventory claim, and Findings #4/#5 are corrected to state that scope-check does NOT flag a Writer write to holdback. The fold's drop and concede-time removal are unaffected. Option (b) — author-aware scope-check — rejected as a behavior change the Scope lines deny for U1; it is a candidate for the separate enforcement layer (next-step #3). Test-locked by the corrected AC + `test/scope-check.test.ts`, which asserts only baseline-capture (what scope-check can see), not Writer-write enforcement. |

## Dependencies

- Depends on the existing dispute lifecycle (`DisputeState`, `resolvedFailures`) and the
  scope-check baseline — both verified present above. No upstream unit.
- The spec-template change (`docs/spec-authoring.md`) is consumed by the Author agent
  (`src/spec-command.ts` / `spec-author.ts`); the `[visible]`/`[holdback]` tag must be
  part of the filling prompt or the Author emits an untagged, unverifiable Inventory.
