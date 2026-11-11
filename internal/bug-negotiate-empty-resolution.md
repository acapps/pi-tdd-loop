# bug-negotiate-empty-resolution

## Problem

The negotiate phase can auto-advance to Phase B with an empty negotiated resolution. When this happens, the Phase B prompt contains:

```
Negotiated resolution:
<<<BEGIN NEGOTIATED RESOLUTION>>>

<<<END NEGOTIATED RESOLUTION>>>
```

The Writer receives no contract, no clarifications, no agreed constraints. It just gets "Write TypeScript source files to pass all tests."

**Runtime evidence:** Session `01a0f4db` (2026-10-01, 05:17:38):

```
[DEBUG] Negotiate: settle (round 1, proposed=false, feedback=false, reprompted=true)
[DEBUG] Negotiate: auto-advancing to Phase B
[USER] Advancing to Phase B without explicit approval. Write TypeScript source files.
Negotiated resolution:
<<<BEGIN NEGOTIATED RESOLUTION>>>
<<<END NEGOTIATED RESOLUTION>>>
```

The `proposed=false` flag means no agent actually proposed a plan. The `reprompted=true` means the system re-prompted once, but the agent still didn't produce a meaningful proposal. The system then auto-advanced with the empty resolution.

**Consequence:** The "negotiated contract" that Phase B is supposed to implement against is empty. The Writer has no guidance beyond the raw spec. This defeats the purpose of the negotiate phase (reconciling Tester's tests with Writer's implementation approach).

## Target

After this fix, the negotiate phase does not auto-advance with an empty resolution. If no meaningful proposal was made, the phase either:
- Routes back to the Tester for a re-review (the tests may be incomplete), OR
- Advances with an explicit "no negotiation needed" marker (if the tests are self-evident), OR
- Escalates to the human for a decision.

## Interface

In the negotiate settle logic (`src/events/agent-settled/` or wherever `Negotiate: settle` is emitted):

1. **Check resolution content:** If the negotiated resolution text is empty (or whitespace-only), do not auto-advance.
2. **Decision tree:**
   - If `round === 1` and `proposed === false`: re-prompt the Writer with a stronger instruction ("You must propose a concrete implementation plan or explicitly agree to the tests as-is").
   - If `round >= 2` and still empty: escalate to human (or route back to Tester).
   - If the Writer explicitly said "agree" (plan='agree'): this is a valid empty resolution — the contract is the tests themselves. Mark it as `resolution: "tests-as-is"` in the Phase B prompt.
3. **Phase B prompt:** If the resolution is "tests-as-is", say so explicitly: "No additional negotiation. Implement the tests as written."

## Tests

- `test/events/agent-settled/negotiate-empty.test.ts`:
  - Negotiate settle with empty resolution, round 1 → re-prompt, no advance
  - Negotiate settle with empty resolution, round 2 → escalate or route to Tester
  - Negotiate settle with `plan='agree'` → advances with "tests-as-is" marker
  - Negotiate settle with substantive plan → advances normally
  - Phase B prompt with "tests-as-is" → contains explicit "implement tests as written"

## Acceptance Criteria

1. An empty negotiated resolution never reaches the Phase B prompt without an explicit marker.
2. The Writer always knows whether it's implementing a negotiated contract or the raw tests.
3. No infinite re-prompt loop (max 2 negotiate rounds before escalation).

## Notes

- This is a **process weakness**, not a crash. The loop still works — the Writer just has less guidance.
- Related: the "3-agent adversarial" design depends on the negotiate phase producing a contract. An empty contract means the Writer is the sole author of both tests and implementation, which is the exact failure mode the 3-agent design is supposed to prevent.
