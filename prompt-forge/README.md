# prompt-forge: a general prompt-strengthening system

A harness that **tests and strengthens every prompt this extension uses** —
Phase 0 (review), A (Tester), B (Writer), C (Cleaner), and the negotiate/dispute
layer. It is **general by construction**: the rubric tests *structure*, never a
specific session's data.

## The anti-overfit principle (the whole point)

The earlier `prompt-evolution/` attempt overfit: it tested one prompt against
one session (01a0d128) and had to hardcode that session's files to score
anything. `prompt-forge` fixes this with one load-bearing rule:

> **Every rubric criterion tests structure, never data.**

- A prompt passes if it has the right **shape**: carries its declared inputs
  (slots filled at runtime), states the role boundary, routes blocked work to
  the right actor, has a termination contract.
- It does **not** pass because it names one session's files. The
  `no-hardcoded-data` guarantee **fails any prompt that embeds a specific
  file/symbol beyond its declared inputs** — the check that would have caught
  the overfit variant. Verified: the overfit variant (hardcoding 01a0d128's
  files) scores 30/100 and fails `no-hardcoded-data`; the general variant
  (slots + boundary + Tester routing + false-done guard) scores 100/100.

The scenario (which files, which failure) is **parameterized data** — exactly
like the `state.negotiateResolution` fix. A prompt is scored on its shape, not
on memorized values.

## What the baseline found (real gaps in the extension)

Scoring the **actual** prompts in `src/` found genuine structural weaknesses:

| prompt | score | missing |
|---|---|---|
| `promptNegotiateAutoAdvance` | 50/100 | test-boundary, Tester routing, false-done guard ← **the 01a0d128 bug** |
| `promptWriterPhaseB` | 75/100 | test-boundary (the first Phase B turn has no "don't edit tests") |
| `buildPhaseZeroPrompt` | 75/100 | instructs-verify-heuristics (the Phase 0 noise problem) |

These are real, not artifacts: the Writer gets no test-file boundary on the
first Phase B turn (only on retries), and the auto-advance prompt — the one that
carries a negotiated resolution — has none of the 01a0d128 fixes.

## Division of labor (cost-aware)

| step | who | cost | what |
|---|---|---|---|
| baseline + evolve | local model | free, long-running | structural scoring + variant generation |
| quality ranking + rubric refinement | **frontier model** | paid, **you engage** | rank *quality within* the structurally-valid set; refine the rubric |

The local scorer can only say "structurally valid or not." The frontier does the
judgment the local scorer can't: *which valid prompt is best*, and *is the
rubric itself too loose/tight*.

## Run it

```bash
# Local phase (free, long-running) — baseline → evolve → frontier handoff:
npx tsx prompt-forge/forge.ts

# Then ENGAGE YOU (the paid frontier step):
#   1. Send prompt-forge/results/frontier-prompt.md to the frontier model.
#   2. Save its JSON response to prompt-forge/results/frontier-response.json.
#   3. npx tsx prompt-forge/ingest-frontier.ts
#      → applies rubric refinements + the frontier's best prompts.
#   4. Apply the best prompts to src/, re-run forge.ts to confirm 100/100.
```

## Files

- `catalog.ts` — the prompt catalog (single source of truth): every prompt →
  phase/role, declared inputs, structural guarantees. Adding a prompt = adding
  an entry.
- `score.ts` — the deterministic structural scorer (reproducible, no judgment).
- `real-render.ts` — renders the REAL prompts from `src/` (not stubs).
- `run.ts` — baseline: score the real prompts.
- `evolve.ts` — generate + score strengthened variants (local, free).
- `build-frontier.ts` — prepare the frontier handoff.
- `ingest-frontier.ts` — apply the frontier's response.
- `forge.ts` — top-level orchestrator (local phase).
- `results/` — artifacts (baseline, evolution, frontier-prompt, rubric).

## Extending it

- **New prompt:** add a `PromptEntry` to `catalog.ts` (phase, role, inputs,
  guarantees, render). It's automatically scored, evolved, and handed off.
- **New guarantee:** add a check function (structural, not data-specific) and
  reference it in an entry's `guarantees`. The `noHardcodedData` guard is the
  template for anti-overfit checks.

## Relationship to `prompt-evolution/`

`prompt-evolution/` was the first attempt — one prompt, one session, overfit.
Kept as the documented lesson. `prompt-forge/` is the general system that
replaces it: all prompts, structural rubric, anti-overfit enforced by
`no-hardcoded-data`.
