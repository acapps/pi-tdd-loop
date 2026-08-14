# Spec Review Phase (Phase 0)

## Overview

Add a **Spec Review** phase before test writing. The Reviewer agent reads the spec, identifies ambiguities and missing edge cases, proposes concrete test-case clarifications, and surfaces them to the human for approval. The Tester then writes tests against the clarified spec.

## Goals

- Eliminate disputes mid-loop by resolving ambiguities upfront
- Reduce token cost by 50–70% on specs with 2+ disputes
- Stabilize test counts across runs (eliminate 22% variance)
- Shift human role from *firefighter* (reacting to disputes) to *reviewer* (approving clarifications)

## Behavior

### New Phase: Phase 0 — Spec Review

The Reviewer agent:

1. Reads the spec document
2. Enumerates every ambiguity, missing edge case, and underspecified behavior
3. For each finding, proposes 2–3 concrete test cases that would resolve it
4. Surfaces findings to the human as a structured checklist
5. Human approves, rejects, or modifies each item
6. Clarification addendum passed to Phase A

### What the Reviewer Does NOT Do

- Does **not** write tests
- Does **not** implement code
- Does **not** make final decisions — it proposes, the human decides
- Does **not** rewrite the spec — it produces a clarification addendum

### Finding Format

Each finding is structured:

```
### Finding N: [Category] — [Function/Feature]

**Ambiguity:** [Quote the unclear phrase]

**Interpretation A:** [One reading]
  - Test: `Func("input")` → `expected`

**Interpretation B:** [Another reading]
  - Test: `Func("input")` → `expected`

**Recommendation:** [Agent's preferred interpretation]
```

### Finding Categories

| Category | Description | Example |
|----------|-------------|---------|
| Ambiguous phrase | Natural language allows multiple readings | "First character" in Capitalize |
| Edge case missing | No coverage for a boundary condition | Empty input not specified |
| Underspecified behavior | Behavior for a class of inputs not defined | Punctuation in IsPalindrome |
| Example-prose conflict | Example contradicts prose description | (if any) |
| Type contract gap | Return types, error handling, nil safety | (for I/O or struct functions) |

### Phase 0 Prompt

```
SPEC REVIEWER

Read the specification at {specPath}.

Identify every ambiguity, missing edge case, and underspecified behavior.
For each finding, propose concrete test cases that would resolve the ambiguity.

Check for:
- Edge cases not covered (empty, nil, single element, overflow, boundary)
- Ambiguous phrases (natural language allowing multiple readings)
- Conflicts between prose and examples
- Underspecified behavior (unicode, whitespace, case folding, errors)
- Type contract gaps (error handling, nil safety)

Output format per finding:

### Finding N: [Category] — [Function/Feature]

**Ambiguity:** [Quote the unclear phrase]
**Interpretation A:** [...]
  - Test: `Func("input")` → `expected`
**Interpretation B:** [...]
  - Test: `Func("input")` → `expected`
**Recommendation:** [Your preferred interpretation]

End with a summary table.

Do not write tests. Do not implement code. Surface findings for human review.
When done, stop producing tool calls.
```

### When to Activate Phase 0

Phase 0 activates automatically when the spec meets any threshold:

- 3+ functions described
- Any mention of errors, I/O, or concurrency
- Flagged manually by `/loop --review`

For trivial specs (1–2 functions, no I/O, no errors), Phase 0 is skipped.

### Integration

After Phase 0 completes:

1. Human reviews findings and approves/rejects each
2. Clarifications appended to spec as an addendum
3. Phase A (Tester) receives spec + addendum
4. Phase B (Writer) and Phase C (Cleaner) proceed as normal
5. Disputes can still occur (Phase 0 reduces but doesn't eliminate them)

### Flow

```
Human provides spec
    ↓
Phase 0: Reviewer identifies ambiguities
    ↓
Human approves/rejects each finding
    ↓
Clarifications appended to spec
    ↓
Phase A: Tester writes tests (against clarified spec)
    ↓
Negotiate: Writer proposes approach
    ↓
Phase B: Writer implements
    ↓
Phase C: Cleaner refactors
    ↓
Done
```

### Metrics to Track

- Findings identified per run
- Human acceptance rate (how many findings were approved)
- Dispute rate before and after Phase 0
- Token cost of Phase 0 vs. dispute savings
- Test count variance across runs
