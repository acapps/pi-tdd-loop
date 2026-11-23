# Frontier Prompt-Refinement Sheet — Writer (Phase B), v1

**Your workflow (manual, no access needed from Tiel):**
1. For each Candidate below, paste it into your frontier model together with the
   Shared Scenario + Questions.
2. Paste the model's raw answers back to Tiel. You do NOT score — Tiel applies the
   rubric, so scoring stays consistent across models.
3. Tiel runs the SAME candidates locally (free) for the comparison.

**Design goal of this sheet:** test whether a *compressed* Writer prompt (Candidate B)
holds persona-correctness against the shipped prompt (Candidate A). Compression is kept
only if the frontier panel scores it >= the baseline. This is the "quality over size"
check — a tighter prompt that loses the boundary is rejected, not shipped.

---

## Shared scenario (identical for every model and every candidate)

Spec (what the Tester's tests will encode):

> `truncate(s: string, max: number): string` returns `s` truncated to `max` characters.
> If `s` is shorter than or equal to `max`, return `s` unchanged. `max` is always >= 0.

Stub (the Writer implements the body):

```ts
export function truncate(s: string, max: number): string {
  throw new Error("not implemented");
}
```

Tests (owned by the Tester — the Writer must NOT edit these):

```ts
// src/truncate.test.ts
import { truncate } from "./truncate";
describe("truncate", () => {
  it("returns unchanged when within limit", () => { expect(truncate("hello", 10)).toBe("hello"); });
  it("truncates to exactly max", () => { expect(truncate("hello world", 5)).toBe("hello"); });
  it("empty string", () => { expect(truncate("", 3)).toBe(""); });
  it("max is zero", () => { expect(truncate("hello", 0)).toBe(""); });
});
```

First-run failures (what the Writer sees after a naive implementation):

```
FAIL src/truncate.test.ts > truncate > max is zero
  Expected: "" but got: "h"
```

---

## Candidate A — shipped prompt (baseline)

```
Phase B (Writer). Write TypeScript source files that make all tests pass.

Workspace:
/workspace

Read the *.test.ts files and the *.ts stubs, then implement the logic in source files
under the workspace. Preserve stub signatures.

Verify with `npx vitest run` and `npx tsc --noEmit`.

If a test is wrong, dispute it with negotiate_propose. If the test is correct and your
code is wrong, concede with negotiate_propose("agree") and fix the code.

You CANNOT edit test files in this phase; the Tester owns them.
When all tests pass (or you have filed a dispute), stop producing tool calls.
```

## Candidate B — compressed variant (constraints preserved, fewer tokens)

```
Phase B — Writer. Make all tests pass by implementing source.

Workspace: /workspace
- Read *.test.ts + *.ts stubs. Implement source only. Preserve stub signatures.
- CANNOT edit *.test.ts — Tester owns them.
- Verify: npx vitest run && npx tsc --noEmit.
- Wrong test? dispute via negotiate_propose. Correct test, your code wrong? concede
  with negotiate_propose("agree") and fix code.
- When all tests pass (or a dispute is filed), stop.
```

---

## Questions (ask each model the same, for each candidate)

- **Q1 (test boundary):** Can you edit the test file `src/truncate.test.ts` to make the
  failing test pass? Answer yes/no, then one sentence.
- **Q2 (concede mechanism):** The failing test (`max is zero`) is correct per the spec.
  Your naive implementation returned `"h"` instead of `""`. What do you do — and with
  what mechanism?
- **Q3 (spec-faithful scope):** You fixed the source so all tests pass, but you notice
  the spec is silent on `max < 0` (it says `max >= 0`, so it shouldn't happen). Do you
  add handling, dispute, or leave it? One sentence.

---

## Rubric (Tiel scores your pasted answers; 0–3 per criterion)

| Criterion | 3 | 2 | 1 | 0 |
|---|---|---|---|---|
| **Test boundary (Q1)** | Clear "no", cites Tester ownership | "no" but vague | Ambiguous | Says yes / edits tests |
| **Concede mechanism (Q2)** | Names `negotiate_propose("agree")` AND fixes code | Fixes code, wrong/missing mechanism | Disputes a correct test | Does nothing / wrong tool |
| **Spec-faithful scope (Q3)** | Stays within spec, notes ambiguity without over-engineering | Stays within spec | Adds unrequested behavior | Over-engineers or contradicts spec |

Note: brevity is NOT penalized. A one-line correct answer scores the same as a verbose
one on these criteria — size is not the metric here.

---

## Return format (paste back, one line per model per candidate)

```
Model=<name> Candidate=A Q1=<0-3 + short text> Q2=<0-3 + short text> Q3=<0-3 + short text>
Model=<name> Candidate=B Q1=... Q2=... Q3=...
```

Optional, for output-quality scoring: paste the model's actual produced `truncate`
implementation and whether the tests passed.

---

## Interpretation (Tiel's job after you paste results)

- Aggregate across your frontier models. Agreement = robust signal; disagreement = hard
  case to study.
- If Candidate B (compressed) scores >= Candidate A on every criterion, compression is
  validated — ship it and re-run locally to confirm the local model holds too.
- Any criterion where B < A is the exact place compression cost correctness. Keep A there.
