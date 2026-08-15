# internal/

Development backlog for the extension itself. These are **not** user-facing feature specs — they're the improvements you capture while dog-fooding the loop and debugging your own runs.

Feeding any of these through the loop (`/loop internal/01-wire-session-start.md`) is how you dog-food: the extension refactors itself under its own gates.

## Naming convention

```
[NN]-<slug>.md        → active work item (NN = dependency order)
done-<name>.md        → implemented and verified; kept as provenance
<name>.md             → active work item with no ordering constraints
```

When a spec is fully implemented and tests pass: **rename the file to `done-<name>.md`**. Don't delete — it's the record of what was built and why.

## Current backlog

### Active (in dependency order)

| Spec | Status |
|---|---|
| `01-wire-session-start.md` | Ready — module implemented, needs wiring |
| `02-implement-tool-call-handler.md` | Ready |
| `03-implement-before-agent-handler.md` | Ready |
| `04-implement-agent-settled-handlers.md` | Ready (depends on nothing external) |
| `05-extract-effect-applicator.md` | Depends on 04 |
| `06-remove-monolith.md` | Depends on 01–05 |
| `events-architectural-cleanup.md` | Source material for 01–06 — keep until all six are done |
| `golden-workspace-fix.md` | Not started |
| `logging-spec.md` | Not started |
| `log-bug-spec.md` | Not started — `/loop-debug --log-bug <name>` flag; independent of 01–06 |
| `missing-test-coverage.md` | Partial — reviewer tests exist, commands.ts helpers untested |

### Done

- `done-phase-0-spec-review.md`
- `done-loop-state-refactor.md`
- `done-loop-metrics-spec.md`
- `done-golden-test-spec.md`

## What does NOT belong here

- **Golden project specs** — test inputs that live in `test/golden/` (e.g., the stringutil Go package). These are loop *inputs*, not loop *improvements*.
- **User-facing feature specs** — new flags, phases, or language support that change the extension's public contract. Those update README.md / SPEC.md first, then get a spec here or in `test/golden/` depending on whether they're behavior or a refactor.
