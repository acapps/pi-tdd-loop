# fix-phase0-scanner-noise

## Problem

Verified current state as of writing (2026-09-19):

- Phase 0 runs `analyzeSpec` (`src/reviewer.ts:85-98`): structural findings (missing required sections) first, then heuristic findings from `findIssues` (`src/reviewer.ts:354-370`). The combined findings are injected into the review prompt by `buildPhaseZeroPrompt` (`src/commands/loop.ts:173-200`) — header line `` `Spec content (${findingCount} potential findings):` `` (loop.ts:184), then `R.buildSummaryTable(analysis.findings)` and one `R.formatFinding(f)` block per finding (loop.ts:191-195). Sole `analyzeSpec` consumer: `src/commands/loop.ts:146`.
- `findIssues` is pure regex/keyword pattern-matching over spec **prose**. Six detector call sites (reviewer.ts:360-367): `detectVaguePhrases` (375), `detectSubjectiveThresholds` (403), `detectMissingErrorHandling` (424), `detectConflictingStatements` (446), `detectFunctionIssues` (468, per extracted "function"), `detectMissingTestStrategy` (529).
- **The detectors read prose, not code.** Three root causes, all verified in `src/reviewer.ts`:
  1. `CONCEPT_PATTERNS` (reviewer.ts:437-441): the "type" pattern is `/(?:type|interface|return)[\s:]+([`'"\w{}\[\]<>,\s\|:]+)/gi` — it matches the **English word** "type"/"return" anywhere in the spec and swallows the following prose as a "value". Two such matches with different swallowed text → a "Conflicting type" finding. The "directory" pattern `(?:directory|dir|path|location|folder)[:\s]+...` has the same flaw (any "path: X" prose, backtick-quoted identifiers, and parentheticals all become "values").
  2. `detectFunctionIssues` (reviewer.ts:468-527) runs per entry of `extractFunctions(specText)` — which extracts *prose mentions* of functions, not signatures. Its triggers are loose: `/string|str|text/i` on params → "Empty input not specified"; `/utf.?8|unicode|multi.?byte|run/i` on the description → "Invalid UTF-8 not specified" — **`/run/i` matches "round"** (as in "round 1"), so any spec mentioning rounds near a word like UTF-8/unicode fires.
  3. `detectMissingErrorHandling` (reviewer.ts:424-436): if any `IO_KEYWORDS` hit appears anywhere and the spec never mentions errors, it files "I/O without error handling" — even for specs that only *describe* a string-building function whose prose happens to contain a keyword.
- **Observed bug (runtime evidence, 2 sessions):**
  - `01a0155a` (2026-08-18, spec 10): `Spec content (4 potential findings)` — all 4 heuristic: "I/O without error handling", "Conflicting directory: string vs change. vs is vs |**Proposed,flaggedforreview.*", "Conflicting type: done vs NosignaturechangetoapplyDoneEffect vs Loopcomplete vs", "Empty input not specified — promptLoopComplete". The reviewer's first `negotiate_propose` was spent dismissing them before reaching the 4 real findings.
  - `01a0b7de` (2026-09-19, spec fix-session-restart): `Spec content (5 potential findings)` — all 5 heuristic: "Conflicting directory: B vs findLastLoopState vs and vs (Q3pin). vs has", "Conflicting type:  vs loop", "Invalid UTF-8 not specified — Quirks", "Empty input not specified — buildResumePrompt", "Empty input not specified — sweep". The reviewer's first call was `negotiate_propose("reject-findings: All 5 auto-generated findings are false positives from a mechanical scanner misreading the spec...")` — a full round-trip of reviewer tokens and user wait time on findings the reviewer was never meant to act on. A second `negotiate_propose("approve")` was then needed to advance.
- Consequence per Phase 0: ≥1 wasted `negotiate_propose` round-trip, the review prompt bloated with hallucinated findings, and the reviewer's attention budget spent on meta-dismissal instead of real findings.
- Baseline: `npx vitest run` → 60 files, 1657 tests, all passing (2026-09-19); `npx tsc --noEmit` clean.

## Target

After: heuristic findings in Phase 0 are **labeled candidates**, the three prose-misread root causes are fixed so the two observed sessions' specs produce **zero** heuristic findings, and the review prompt frames auto-generated findings as *to-be-verified candidates* — so a clean spec costs the reviewer zero dismissal tokens and a noisy one costs at most a single verify-and-dismiss proposal. Structural findings (missing required sections) are unaffected — they are mechanical and correct. First-call behavior for genuinely underspecified specs (vague phrases, subjective thresholds, real missing test strategy) is preserved: those detectors stay.

## Interface

- **No signature changes.** `analyzeSpec(specText: string): SpecAnalysis` (`src/reviewer.ts:85`), `buildPhaseZeroPrompt(specText: string, analysis: SpecAnalysis): string` (`src/commands/loop.ts:173`), `findIssues(specText: string): Finding[]` (non-exported, `src/reviewer.ts:354`) — all unchanged.
- `Finding` shape (`src/types.ts` — `id`, `category`, `title`, `ambiguity`, `interpretations`, `recommendation`) unchanged; the fix changes *which* findings are produced and the *prompt framing*, not the data shape.

## Behavior

### S1 — Prompt framing (the folded-in dismissal behavior)

`buildPhaseZeroPrompt` (`src/commands/loop.ts:173-200`) gains one line between the existing "Use negotiate_propose to approve..." line (loop.ts:181) and the `Spec content (...)` line (loop.ts:184). Verbatim (rendered only when `findingCount > 0`):

```
Auto-generated findings below are heuristic candidates, not verified defects: verify each against the spec text; if a candidate is a false positive, reject it in a single negotiate_propose call (plan='reject-findings: <per-finding rationale>') before approving.
```

- Rendered **only** when `findingCount > 0` (a zero-finding review prompt must stay byte-identical to today — existing tests pin the current lines).
- The existing lines ("Phase 0: Spec Review", "The spec meets the threshold for review: ...", "Review the spec below and check for...", "Use negotiate_propose to approve (plan='approve') or provide feedback on findings.", "Spec content (N potential findings):") are all unchanged.
- The reviewer's established two-call flow (`reject-findings: ...` then `approve`) becomes the *pinned expected* flow for a fully-noisy Phase 0 — it already works mechanically (both calls are valid `negotiate_propose` plans); S1 makes it the advertised one so the reviewer doesn't burn a turn discovering it.

### S2 — `CONCEPT_PATTERNS` fix (reviewer.ts:437-441)

The "type" and "directory" patterns must not match English prose. Change:

- "type" pattern: require a backtick-quoted or code-style token, not bare prose. New pattern: `` /(?:type|interface|return)\s+`([A-Za-z_][\w.<>\[\],\s|]*)`/gi `` — i.e. the value must be backtick-quoted (the spec convention for types/identifiers). Specs that write types in backticks (the `docs/spec-authoring.md` convention) still get conflict detection; prose like "no signature changes" / "type vs loop" no longer fires.
- "directory" pattern: same treatment — value must be backtick-quoted: `` /(?:directory|dir|path|location|folder)\s*:\s*`([^`]+)`/gi ``.
- "format" pattern: unchanged (no observed false positives; keep behavior).
- The `detectConflictingStatements` logic (2+ matches, 2+ unique values → finding, reviewer.ts:446-466) is unchanged.

### S3 — `detectFunctionIssues` trigger tightening (reviewer.ts:468-527)

- The UTF-8 trigger regex changes from `/utf.?8|unicode|multi.?byte|run/i` to `/utf.?8|unicode|multi.?byte/i` — **drop `run`** (it matches "round", "running", "return"). Verified: this is what produced "Invalid UTF-8 not specified — Quirks" and "— sweep" in 01a0b7de.
- The empty-input trigger stays (`/string|str|text/i` on params) — it produced false positives in both sessions ("— buildResumePrompt", "— promptLoopComplete") **but** `extractFunctions` (reviewer.ts:295; sole call site reviewer.ts:364) is the deeper flaw: it extracts prose mentions as "functions". Narrowing: `detectFunctionIssues` runs only on entries of `extractFunctions` whose extracted `name` matches a code-identifier shape `/^[a-zA-Z_][\w]*$/` **and** appears backtick-quoted in the spec text. Prose fragments ("Quirks", "sweep" from a section header or sentence) no longer qualify.
- The false-case, case-normalization, and bool triggers inside `detectFunctionIssues` are otherwise unchanged.

### S4 — `detectMissingErrorHandling` scoping (reviewer.ts:423-436)

- The detector fires only when the spec **Inventory** section (or an `## Interface` section) contains an `IO_KEYWORDS` hit (`IO_KEYWORDS` at reviewer.ts:421 — "file", "read", "write", "persist", "save", "load", "http", …) — i.e. the spec declares I/O in its contract, not in passing prose. Implementation: locate the `## Inventory` section text (regex from `## Inventory` to the next `## ` header or EOF) and run the `IO_KEYWORDS.some(...)` check on that slice instead of the whole `specText`. The `mentionsErrors(specText)` early-out stays whole-spec (an error mention anywhere is a valid suppression).
- Verified: 01a0155a's spec had no I/O contract — the keyword hit was in prose; under S4 the detector sees an empty Inventory slice → no finding.

### S5 — Preserved detectors (no change)

`detectVaguePhrases` (375), `detectSubjectiveThresholds` (403), `detectMissingTestStrategy` (529), and the structural `validateSpecStructure` (reviewer.ts:101+) are untouched. Genuinely underspecified specs still get their findings.

### Q — Quirks / non-goals

- **Q1:** `extractFunctions`'s extraction heuristic is not redesigned. S3 narrows which extracted entries get per-function checks; the extractor itself (and its other consumers, if any) is out of scope. Re-verify during implementation: if `extractFunctions` has consumers outside `findIssues`, note them in the Findings log and do not change its behavior.
- **Q2:** The `reject-findings:` plan prefix is a reviewer convention, not a parser feature — `negotiate_propose` accepts any plan string; Phase 0 treats non-`agree` plans as feedback. S1 documents the convention; no parser change.
- **Q3:** Coverage of the *scanner itself* is unit-tested with the two observed session specs as fixtures (inlined, abridged to the offending lines — not full session transcripts). No live-toolchain test; `findIssues` is a pure string function.
- **Q4:** Java/Go/TS language configs are untouched — Phase 0 is language-agnostic.

## Inventory

| File | Action |
|------|--------|
| `src/reviewer.ts` | **Modify** — S2 (CONCEPT_PATTERNS), S3 (UTF-8 trigger + name-shape gate), S4 (Inventory scoping). ~15 lines changed. |
| `src/commands/loop.ts` | **Modify** — S1 framing line in `buildPhaseZeroPrompt` (3 lines: condition + string + push). |
| `test/reviewer.test.ts` | **Modify** — regression fixtures: the two session-observed spec fragments must yield 0 findings from the 3 fixed detectors; the preserved detectors still fire on their canonical inputs. |
| `test/commands-split/loop.test.ts` | **Modify** — the existing `buildPhaseZeroPrompt` pin (line 161, "verbatim from src/commands.ts:334-362") gains the S1 framing line: present when findings > 0, absent when 0; all existing pinned lines unchanged. |
| `internal/bug-phase0-scanner-noise.md` | **Rename** → `done-bug-phase0-scanner-noise.md` on completion. |
| `internal/bug-phase-restart-on-reload.md` | **Rename** → `done-bug-phase-restart-on-reload.md` (housekeeping: superseded by `internal/done-fix-session-restart.md`, commit 46236a4; the open file's "no resume path" prose is stale). |

## Test Strategy

1. **No behavioral change for clean specs:** a spec with no heuristic triggers produces the same findings as today (structural-only). Existing `buildPhaseZeroPrompt` output for a 0-finding analysis is byte-identical.
2. **Session-fragment regression (the core):** inline abridged fragments of the 01a0155a and 01a0b7de specs (the exact lines that fired: the "type" prose, the "path: X" prose, the "round ... UTF-8"-adjacent prose, the string-building function prose, the IO-keyword-in-prose line). Assert `findIssues(fragment)` returns `[]` for the S2/S3/S4 detectors. Unit, no process spawning (Q3).
3. **Preserved detectors still fire:** canonical inputs — a spec containing "properly" (vague), "within 3 rounds" (subjective), no "test"/"assert" mention (missing test strategy), a backtick-quoted type stated twice with different values (conflict still detected under S2), a backtick-quoted function with string param and no empty-behavior mention (empty-input still detected under S3), an Inventory section containing a real IO keyword with no error mention (I/O finding still fires under S4).
4. **Framing line:** `buildPhaseZeroPrompt` with findings > 0 contains the S1 line verbatim; with 0 findings it does not, and the full output equals the pre-change output.
5. Run `npx tsc --noEmit`; run `npx vitest run` — all 1657+ tests pass.

## Scope lines

- **IN:** `src/reviewer.ts` (3 detectors), `src/commands/loop.ts` (1 prompt line), tests for both, the two housekeeping renames.
- **OUT:** redesigning `extractFunctions`; changing the `Finding` type; touching structural validation; changing `negotiate_propose` parsing; the Phase-0 double-call quirk (reject-findings then approve is the pinned flow, not a bug to fix); the latent pre-fix `justTransitioned` quarantine gap (unobserved — logged in Findings, not spec'd).

## Acceptance Criteria

1. `findIssues` on the inlined 01a0155a fragment returns 0 findings from `detectConflictingStatements`, `detectMissingErrorHandling`, and `detectFunctionIssues`. (hard)
2. `findIssues` on the inlined 01a0b7de fragment returns 0 findings from the same three detectors. (hard)
3. `buildPhaseZeroPrompt` output for a 0-finding analysis is byte-identical to the pre-change output; for a >0-finding analysis it contains the S1 line verbatim. (hard)
4. The preserved-detector tests in Test Strategy item 3 all pass (conflict-on-backticked-types, empty-input-on-backticked-function, I/O-on-Inventory-keyword, vague, subjective, missing-test-strategy). (hard)
5. `npx tsc --noEmit` clean; `npx vitest run` all green. (hard)
6. `internal/bug-phase0-scanner-noise.md` and `internal/bug-phase-restart-on-reload.md` renamed to `done-` with a one-line "superseded by / fixed by" note at the top. (hard)
7. `src/reviewer.ts` stays under ~600 lines (soft — it is 555 lines as of writing; the fix is net-neutral to net-negative).

## Dependencies

None. Pure reviewer/prompt change. Independent of the open `bug-dispute-fix-redundant-turn.md`, `bug-role-context-mismatch.md`, and the Java/jacoco row of `bug-coverage-noop-ts.md`.

## Findings log

- **F1 (accepted, verified):** 01a0b7de Phase 0 — 5/5 findings heuristic, all false positives; reviewer's first `negotiate_propose` was `reject-findings:` dismissal. Source: session extract, 2026-09-19T04:14:38Z.
- **F2 (accepted, verified):** 01a0155a Phase 0 — 4/4 findings heuristic, all false positives, including "Conflicting directory: string vs change. vs is vs |**Proposed,flaggedforreview.*" (regex swallowing markdown). Source: session extract, 2026-08-18T14:50:59Z.
- **F3 (accepted, latent — NOT spec'd here):** pre-fix `loop-state` entries (written before commit 46236a4) lack `justTransitioned`, a required boolean (`src/state-validation.ts:45`); `restoreState` (`src/events/session-start.ts:151-154`) quarantines on validation failure. An upgrade mid-loop therefore quarantines instead of resuming. Unobserved in any session as of writing (user confirmation 2026-09-19). If ever observed, spec it: heal absent→`false` in `clearTransientFlags` following the spec-07 heal precedent (`session-start.ts:91-93`).
