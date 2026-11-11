# Bug: scope-check baseline re-capture — uncommitted WIP, now cleaned up

**Symptom:** (from session 01a1c767, spec enrich-entry-renderer) Phase B gate failed
4+ times on `core/reactions.ts` and `core/voice.ts` — pre-existing dirty files in
the working directory, unrelated to the spec. Writer disputed each time; Tester
conceded each time saying "scope-check needs filtering" — but nothing was actually
fixed in the loop, so the next gate re-failed.

**Root cause:** two bugs in `src/scope-check.ts`:

1. **Baseline was a one-shot snapshot.** `baselineDirtyFiles` was captured once on
   session restore via `getGitUntrackedFiles(process.cwd())` and never refreshed.
   If the user committed or edited other files between spec start and Phase B, the
   baseline drifted and the scope-check flagged pre-existing dirty files as
   out-of-scope.

2. **Baseline captured only untracked files.** `getGitUntrackedFiles` (despite its
   name, it also read modified files — but the *baseline filter* in
   `checkScope` only excluded files present in the baseline; files that were
   *modified* in the baseline but not untracked were still flagged when they
   appeared in the current dirty set).

**Fix (committed as part of the scope-check cleanup, this session):**

- `getGitUntrackedFiles` renamed to `captureGitBaseline` — the name now matches
  what it does (captures the full dirty set: modified + staged + untracked).
- `captureGitBaseline` is called at:
  - `/loop` start (`src/commands/loop.ts`) — initial baseline after Phase 0
    baseline runs.
  - Phase A → Phase B transition (`src/tools/state-io.ts`) — re-captured so
    Phase A's test files are "pre-existing" for Phase B's scope check.
  - Negotiate → Phase B transition (same site in `state-io.ts`).
  - Gate transition (`src/events/agent-settled/gate-transition.ts`) — the
    settle path re-captures on each Phase B gate so the baseline never drifts
    within a run.
- The cwd used is now workspace-aware: `getWorkspaceRoot(specPath)` for the
  tool path, `projectCwd` for the command path, `ctx.cwd` / `gateCwd` for the
  settle path. (The tool path previously used `process.cwd()`, which is wrong
  for golden projects where the workspace root ≠ cwd.)

**Verification:** `test/scope-check.test.ts` (30 tests) + full suite (1801 tests)
pass. `npx tsc --noEmit` clean.

**Not yet done (follow-up, separate spec if pursued):**

- The scope-check still compares the current dirty set against the *baseline*
  rather than against the spec's `## Inventory` file list directly. The
  Inventory is parsed (see `parseInventory`) and used to build the allowed set,
  but the filter is "dirty − baseline → check against allowed". A file that
  was clean at baseline and is now dirty and not in the Inventory fails — which
  is correct. But a file that was dirty at baseline and is now *more* dirty
  (Writer added to it) and is in the Inventory passes — also correct. The
  current design is sound; the only remaining gap is that the baseline is
  re-captured at *phase transitions*, not at *every gate*. If the user edits
  files mid-Phase-B (between gates), the next gate's baseline is stale. This
  is a minor edge case (the user is expected to be idle during a run) and is
  not worth a separate spec unless it recurs.
