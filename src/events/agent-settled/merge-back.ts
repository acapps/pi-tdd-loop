// --- Git branch merge-back workflow (src/events/agent-settled/effect-applicator.ts split, step 4) ---
// Opt-in via --branch: merge the feature branch back into the mainline at
// the done effect, verify the Writer's single conflict-resolution attempt.

import type { LoopState } from "../../types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EventCtx } from "../index";
import { commitAndMerge, verifyMergeComplete, promptMergeConflict } from "../../git-workflow";
import { sendPrompt } from "../../prompt";

// Git branch workflow (opt-in via --branch): merge the feature branch back
// into the mainline at the done effect. Returns a Promise that resolves when
// the merge has been attempted:
//   - "merged"   — clean merge; state.branch.merged is set.
//   - "conflict" — the Writer was prompted for the single resolution attempt;
//                  the merge is left in progress (MERGE_HEAD set). The next
//                  settle verifies the outcome (verifyBranchMerge) and
//                  escalates if the attempt failed.
//   - "error"    — the merge could not run; the branch is left in place.
// The done effect always reports loop completion (the merge is a post-step);
// the caller awaits this before sending the completion prompt.
export async function mergeBranchBack(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: (msg: string) => void,
): Promise<"merged" | "conflict" | "error"> {
  const branch = state.current.branch;
  if (!branch || branch.merged) return "merged";

  const outcome = await commitAndMerge(ctx.cwd, branch, state.current.language);
  if (outcome.kind === "merged") {
    branch.merged = true;
    ctx.ui.notify(`Merged '${branch.name}' into '${branch.base}'.`, "info");
    debug(`--branch merge: clean (${branch.name} → ${branch.base})`);
    return "merged";
  }
  if (outcome.kind === "conflict") {
    handleMergeConflict(outcome, branch, state.current, pi, ctx, debug);
    return "conflict";
  }
  debug(`--branch merge: ERROR (${outcome.error})`);
  ctx.ui.notify(
    `Merge back failed: ${outcome.error} — the feature branch is left unmerged. Resolve manually.`,
    "warning",
  );
  return "error";
}

// A merge conflict was detected: notify the user, set the UI status, and give
// the Writer one turn to resolve it. The merge is left in progress (MERGE_HEAD
// set); the next settle verifies the outcome via verifyBranchMerge.
function handleMergeConflict(
  outcome: { files: string[] },
  branch: { name: string; base: string },
  state: LoopState,
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: (msg: string) => void,
): void {
  debug(`--branch merge: CONFLICT (${outcome.files.length} files)`);
  ctx.ui.notify(
    `Merge conflict merging '${branch.name}' into '${branch.base}' — the Writer gets one turn to resolve it.`,
    "warning",
  );
  ctx.ui.setStatus("loop", `merge conflict — Writer resolving (${branch.name})`);
  sendPrompt(pi, promptMergeConflict(outcome.files), state, debug);
}

// Verify the Writer's single conflict-resolution attempt. Called from the
// settle dispatcher when the loop is done but the merge is still in progress.
// Returns true when the merge is complete (state.branch.merged set), false
// when it is still broken (the caller escalates — the single attempt is spent).
export async function verifyBranchMerge(
  state: { current: LoopState },
  ctx: EventCtx,
  debug: (msg: string) => void,
): Promise<boolean> {
  const branch = state.current.branch;
  if (!branch || branch.merged) return true;

  const outcome = await verifyMergeComplete(ctx.cwd);
  if (outcome.kind === "merged") {
    branch.merged = true;
    ctx.ui.notify(`Merge complete: '${branch.name}' is now in '${branch.base}'.`, "info");
    debug(`--branch merge: verified complete (${branch.name} → ${branch.base})`);
    return true;
  }
  const detail = outcome.kind === "conflict"
    ? `${outcome.files.length} conflicted file(s) remain`
    : outcome.error;
  ctx.ui.notify(
    `Merge conflict resolution failed (${detail}). The Writer's single attempt is spent — resolving manually: "git merge --continue" or "git merge --abort" on '${branch.base}'.`,
    "warning",
  );
  ctx.ui.setStatus("loop", `merge conflict — ESCALATED (manual resolution needed)`);
  debug(`--branch merge: ESCALATED (${detail})`);
  return false;
}
