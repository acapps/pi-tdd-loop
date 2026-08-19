# Writing Specs for the Loop

Phase 0 reviews your spec for ambiguities and missing edge cases before any code is written. Every review round costs time; a spec written against the template below tends to survive Phase 0 in one pass.

**Provenance:** this document distills the Phase 0 findings from seven real specs run through the loop on this repo's own codebase (`internal/02`–`internal/06`, nine review rounds, plus spec 07). The first six were all extract/move units; spec 07 was the first behavior-wiring unit (fix a state machine, no code moves) and exposed the gaps the last sections close: runtime evidence, persisted state, intended shifts. Each template section exists because a first draft failed on it — the "why" column says which.

## The 12 failure classes

| Class | First drafts miss it by… | Template section that closes it |
|---|---|---|
| A. Stale-state drift | describing the repo as remembered, not as-is — wrong file, wrong line, wrong caller count; numbers typed from memory after verifying; behavior claims with no named artifact | Problem (verified state) |
| B. Paraphrased behavior | summarizing strings/branches instead of pinning them verbatim | Behavior → verbatim pins |
| C. Unclosed inventories | listing the happy path; missing a variant, a rewrite class, a dead helper | Inventory |
| D. "All tests pass" lie | claiming green without counting which assertions the change flips | Test Strategy |
| E. Unowned behavior | not saying which module does the behavior or which test file asserts it | Behavior → ownership; Scope lines |
| F. Unpinned order | leaving sequences, early returns, and conditionality implicit | Behavior → order pins |
| G. Quirks treated as bugs | silently "fixing" odd-but-current behavior — or misfiling intended new behavior as a quirk | Behavior → quirks list + intended shifts |
| H. Single-axis blast radius | checking imports/callers but not comments/strings/headers | Acceptance → grep sweep |
| I. Toolchain blind spots | writing a criterion a checker can't see (e.g. unused imports when the test run doesn't type-check) | Acceptance (name the checker) |
| J. Type-level facts | stub-vs-code contradictions, unexported types, non-exhaustive unions | Interface |
| K. Missing provenance | not recording rejections or the author's own verification misses | Findings log |
| L. Persisted-state drift | not saying what happens to saved entries, the restore path, and old sessions after the change | Interface → persisted state |
| M. Live-toolchain tests | writing a test that spawns a real tool (go/mvn/gradle/vitest) in a temp dir without pinning the fixture's buildability and the tool's absence — a test-only module that `go build` rejects, a `which`-absent tool that turns a regression test into a silent green checkmark | Test Strategy → live-toolchain rules |

## The template

```markdown
# <verb-<object>>   ← one verb, one object, one unit (implement-, extract-, wire-, remove-)

## Problem
Verified current state as of writing: what exists, where, and the gap to the
target. Static claims cite file:line; behavior claims cite the observed
artifact (session log, captured message, command output) and name it —
file:line and runtime evidence are complementary, not competing; a process
bug is usually proven by a log, not a file. Every claim is checked against
the repo BEFORE writing, not remembered — and re-verified AFTER drafting
(numbers typed from memory rot).

## Target
One paragraph: the shape after. What exists, what does not, what the entry
point / caller sees.

## Interface            (omit if no signature or data-shape change)
Pinned signatures and data shapes. If a stub or contract file exists, it is
the canonical target shape — list every explicit adjustment (field added,
wrapper vs bare state, optional-ness, return type). Note type-level facts:
union exhaustiveness, non-exported types (use a ReturnType alias), imports
the test runner cannot catch.

Persisted state (if the change touches saved entries, a restore path, or
migration): name the saved shape, the read/restore path, and how pre-change
entries stay valid. Prefer optional/nullable extensions over rewrites, and
name the precedent field.

## Behavior
Decision table: one row per branch, explicit evaluation order
(first-match-wins), every case including terminal/idle/unknown, explicit
default branch, return value per row.

Verbatim pins: every string a user sees or a test can assert (prompts,
reasons, debug, notifications, errors, fallback defaults), plus exact branch
code where order matters (early returns, conditional vs unconditional side
effects).

Side-effect contract: every external touch — UI calls (args, level,
conditionality), messages sent (payload + trigger flags), state mutations
(fields, order), persistence.

Quirks list: odd-but-current behavior, each marked "current behavior, do not
fix". Dead branches are pinned, not removed.

Intended shifts: new behavior pre-existing code silently picks up (a
previously-wrong branch becoming correct, a shared helper inheriting new
semantics). State before/after for each. These are accepted side effects,
not quirks — "this is intended, not a quirk" inside a quirk is the red flag
that this section was missing.

Ownership: which module owns each behavior, and which test file asserts it.
The assertion lives with the code that performs the behavior.

## Inventory            (closed lists — count the items, name the last,
                        or state the grep that proves completeness)
- Files: every function/type and where it goes, INCLUDING dead code
  (with caller-count evidence for each deletion)
- Imports: every import line in every touched file — added / rewritten /
  absorbed / removed
- Call sites: who assigns what, in which order; return-value mapping
- Exports: what becomes exported, and why (e.g. testability)

## Test Strategy        (never "all existing tests pass" — prove it or plan it)
- Baseline: N/M passing; which are stub-era and assert stub behavior
- Per-test disposition: kept / rewritten (old assertion → new assertion) /
  removed (why the faithful change violates it)
- New tests: one per newly pinned behavior (fallbacks, early returns,
  orderings, default branches; restored stale entry when the change touches
  persisted state)
- Untouched: files intentionally left alone, and until when. "All other
  tests kept unchanged" must name the mechanism that makes it true (e.g.
  optional fields keep old fixtures valid) — never bare.
- Live-toolchain rules (every test that spawns a REAL tool in a temp dir —
  go/mvn/gradle/vitest — must state all four, or it is a class-M draft):
    1. FIXTURE BUILDABILITY: the temp project must satisfy the project's
       compile check, not just its test step. A Go module with only
       `main_test.go` makes `go build ./...` exit 1 ("no packages to build")
       — a gate that checks compile first never reaches the test step, so
       the test exercises the wrong check and may be unpassable by
       construction. Name the non-test file the fixture writes.
    2. TOOL ABSENCE: `it.skipIf(!toolAvailable())` with a named probe
       (`which go`-style or a pre-flight `execFile(tool, ["version"])`).
       A missing toolchain must never produce a green checkmark — a
       fallback branch that accepts `kind: "error"` as a pass IS a green
       checkmark in the summary. Pin the probe in the spec.
    3. TIMEOUT: sized to the real tool, not a blanket large value (a `go
       test` in a temp module: 30s; a cold maven build: name the larger
       number and why). Blanket 120s on a 5-second tool is a smell.
    4. VERDICT FIELD: if the test asserts on a result object with more
       than one boolean (e.g. `tests` AND `allPassed`), name which field
       is the verdict and assert the log/decision read the same field.
       Two fields for one fact is the spurious-green shape one layer up.

## Scope lines          (final shape of every touched file)
For each file: removed / kept / added. Enforced by inspection or the type
checker — whichever can actually see it.

## Acceptance Criteria  (each criterion names a checker that can see it)
- Full test run green (name the suites, incl. integration/e2e if present)
- Type-checker clean (if the test run does not type-check — say so)
- Grep sweeps: functional references (imports, call sites, disk reads)
  AND textual references (comments, strings, headers). Each sweep names its
  needle: an identifier/string that exists today and must be gone after —
  or must appear exactly N times.
- One criterion per pinned item above; no vague "clean code"

## Dependencies
Upstream units and their completion state — and what that state means for
the current code (e.g. "spec 04 is implemented; that is why the source file
is X, not the old Y").

## Findings log        (empty after a clean Phase 0; one row per finding
                        otherwise)
| # | Severity | Finding | Disposition (accepted/rejected + what was verified + what the spec now pins) |
Severity is one of: blocker / needs-doc / nit. Record rejections with
reasons, and the author's own verification misses — a miss is a finding, not
an embarrassment. No loop phase can write the spec: findings surfaced
mid-loop (review, dispute) are appended by the author after the run.
```

## The filling prompt

Paste this with the template when an agent writes or revises a spec:

```
You are writing a spec for a code change in this repo. Follow the template in
docs/spec-authoring.md. The rules below each prevent a real, observed failure
class — violating any of them costs a review round.

Before writing:
1. VERIFY, don't remember. Every file, line number, function name, caller
   count, and import in the spec must be checked against the repo NOW. Mark
   line references "as of writing". (Failure class A: a spec was written
   against a file that an upstream spec had already moved.)
2. CHECK THE TEST SUITE'S SIGHTS. What does the test runner actually see?
   (Many runners don't type-check; some ignore unused imports. Name the
   checker that can see each pinned item.) (Class I.)
3. MAP BOTH AXES OF BLAST RADIUS. Functional: imports, call sites, files
   read on disk. Textual: comments, error strings, headers, docs. Grep for
   both; the grep becomes an acceptance criterion. (Class H.)

While writing:
4. PIN VERBATIM, never paraphrase. Any string a user sees or a test can
   assert — prompts, reasons, debug, notifications, errors, fallback
   defaults — goes in the spec exactly as written in code. If a branch's
   ORDER matters (early return, conditional vs unconditional), pin the code,
   not a description. (Class B, F.)
5. CLOSE EVERY LIST. Count the items, name the last, or state the grep that
   proves completeness. If you wrote "two mechanical differences", stop and
   look for the third. Inventories include dead code, with caller-count
   evidence for each deletion. (Class C.)
6. OWN EVERY BEHAVIOR. For each behavior, name the module that performs it
   and the test file that asserts it — the assertion lives with the code.
7. PLAN THE TESTS. Count how many existing tests flip. Write per-test
   dispositions (kept / rewritten old→new / removed + why) and the new tests
   each pinned behavior needs. The sentence "all existing tests pass" may
   only appear if the per-test flip-count self-check below proves it.
   (Class D, E.)
8. PRESERVE QUIRKS. Odd-but-current behavior — dead branches, surprising
   fallbacks, throw asymmetries — goes in the quirks list marked "current
   behavior, do not fix". "No behavioral change" includes preserving
   oddities. New behavior pre-existing code silently picks up is NOT a
   quirk — it goes in the intended-shifts section with before/after.
   (Class G.)
9. RESOLVE TYPE FACTS. If a stub or contract file exists, it is canonical;
   pin every explicit adjustment. Note non-exported types, non-exhaustive
   unions, and wrapper-vs-bare state shapes. If the change touches persisted
   state, name the saved shape, the restore path, and the compatibility
   strategy — prefer optional/nullable extensions, name the precedent.
   (Classes J, L.)
10. LOG PROVENANCE. Every Phase 0 finding gets a row: accepted/rejected,
    what was verified, what the spec now pins — including rejections with
    reasons and your own verification misses. (Class K.)
11. DRY-RUN THE LIVE TESTS. For every test that spawns a real tool, run
    the fixture's commands in a temp dir BEFORE submitting: the compile
    command, the test command, and the tool-absent case (run with a
    stripped PATH). A test you have not run in its own fixture is a class-M
    draft. (Observed: a spec's "green stays green" regression shipped with
    a test-only Go module — `go build` exit 1 — so the test could never
    reach the assertion it named, and the implementing agent ground on it
    for 30+ minutes because the prompt offered no dispute path for an
    unpassable test.)

Self-check before submitting:
- Can I name a line number for every factual claim? (A)
- After drafting, did I re-run every cited line number and grep against the
  repo? Numbers typed from memory rot. (A)
- Can I name the observed artifact for every behavior claim? (A)
- Is every list closed — can I prove the last item? (C)
- Is every user-visible string verbatim, and every order pinned? (B, F)
- Does "all tests pass" survive a per-test flip count? (D)
- Can I name the owning module and asserting test file for each behavior? (E)
- Is every oddity in the quirks list, marked do-not-fix — and every intended
  shift named with before/after? (G)
- Did I grep functional AND textual references? (H)
- Does each acceptance criterion name a checker that can see it? (I)
- Are the stub adjustments and type facts resolved? (J)
- If the change touches persisted state: saved entries, restore path, and
  compatibility strategy named? (L)
- Is the findings log ready? (K)
- For every live-toolchain test: fixture buildability, tool-absence skip,
  sized timeout, and verdict field all named — and did I dry-run the
  fixture's commands, including the stripped-PATH case? (M)
```

## Unit sizing

The template fits one unit: one verb, one object, one dependency direction. When a change doesn't fit — the original six-unit events refactor here is the example — split it into dependency-ordered units, each with its own spec, and number them —
filenames in dependency order (e.g. `02-extract-effect-applicator.md`). "Refactor everything" is not a spec; it is a backlog.
