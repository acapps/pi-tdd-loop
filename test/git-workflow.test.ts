// Git branch workflow (--branch, opt-in) — unit tests.
//
// The process boundary (git) is mocked at the node:child_process level with
// vi.mock, per CLAUDE.md TEST SPEED RULE: no real git, no real processes.
// Tests assert on the interpretation of git output / exit codes.
//
// Real end-to-end git verification lives in test/e2e/ (out of scope here).

import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";

// vi.mock replaces execFile with a controllable fake for this file only.
// (ESM module namespaces are frozen — vi.spyOn on node:child_process is
// not possible.) The fake is a plain vi.fn() queued with per-test behavior.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)}));

// The test file's own imports (vitest, the mock factory above) can load
// node:child_process through other modules before vi.mock's factory is
// installed. Seed the mock with a default no-op so any stray call is a
// no-op with an error callback instead of "cb is not a function".
execFileMock.mockImplementation(
  (_file: string, _args: string[], _opts: unknown, cb?: Function) => {
    if (typeof cb === "function") {
      cb(new Error("execFile not stubbed in this test"), "", "");
    }
  });

import {
  branchNameFromSpec,
  parseConflictedFiles,
  promptMergeConflict,
  resolveMainline,
  setupBranch,
  commitAndMerge,
  verifyMergeComplete} from "../src/git-workflow";
import { mergeBranchBack, verifyBranchMerge } from "../src/events/agent-settled/effect-applicator";
import { parseLoopArgs, formatStatus } from "../src/selectors";
import type { LoopState } from "../src/types";
import { createMockExtensionAPI } from "./__mocks__/@earendil-works/pi-coding-agent";

// ================================================================
// Helpers
// ================================================================

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "done",
    round: 0,
    specPath: "internal/01-feature.md",
    language: "go",
    buildTool: "go",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
  coverageThreshold: 80,
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "C",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides};
}

function makeMockCtx(cwd: string = os.tmpdir()): any {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd};
}

/**
 * Queue execFileMock responses in call order. Each entry:
 *   { ok: boolean, stdout?: string, stderr?: string, code?: number }
 * The mock invokes the callback with (error, stdout, stderr) where error is
 * null on ok, or an Error with .code = exitCode on failure (mirroring how
 * node's execFile reports non-zero exits).
 */
function queueGitResponses(responses: { ok: boolean; stdout?: string; stderr?: string; code?: number }[]): void {
  execFileMock.mockReset();
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: Function) => {
      const r = responses.shift();
      if (!r) {
        cb(new Error("unexpected git call"), "", "");
        return;
      }
      if (r.ok) {
        cb(null, r.stdout ?? "", r.stderr ?? "");
      } else {
        const err = new Error("git failed") as NodeJS.ErrnoException;
        (err as { code: number | string }).code = r.code ?? 1;
        cb(err, r.stdout ?? "", r.stderr ?? "");
      }
    });
}

// ================================================================
// branchNameFromSpec — pure
// ================================================================

describe("branchNameFromSpec", () => {
  it("derives loop/<slug> from the spec filename", () => {
    expect(branchNameFromSpec("internal/01-add-feature.md")).toBe("loop/01-add-feature");
  });

  it("handles windows-style paths", () => {
    expect(branchNameFromSpec("specs\\my cool spec.md")).toBe("loop/my-cool-spec");
  });

  it("collapses non-alphanumeric runs to single dashes", () => {
    expect(branchNameFromSpec("a--b__c  d.md")).toBe("loop/a-b-c-d");
  });

  it("falls back to 'spec' when the slug is empty", () => {
    expect(branchNameFromSpec("....md")).toBe("loop/spec");
  });

  it("lowercases the slug", () => {
    expect(branchNameFromSpec("My_SPEC.md")).toBe("loop/my-spec");
  });
});

// ================================================================
// parseConflictedFiles — pure
// ================================================================

describe("parseConflictedFiles", () => {
  it("splits output into trimmed non-empty paths", () => {
    expect(parseConflictedFiles("a.go\n\n  b.go \nc.go\n")).toEqual(["a.go", "b.go", "c.go"]);
  });

  it("returns [] for empty output", () => {
    expect(parseConflictedFiles("")).toEqual([]);
  });

  it("returns [] for whitespace-only output", () => {
    expect(parseConflictedFiles("  \n \n")).toEqual([]);
  });
});

// ================================================================
// promptMergeConflict — pinned verbatim
// ================================================================

describe("promptMergeConflict", () => {
  it("lists the conflicted files", () => {
    const p = promptMergeConflict(["a.go", "b.go"]);
    expect(p).toContain("  - a.go");
    expect(p).toContain("  - b.go");
  });

  it("states the single-attempt rule explicitly", () => {
    const p = promptMergeConflict(["a.go"]);
    expect(p).toContain("exactly ONE turn");
    expect(p).toContain("escalates to the");
  });

  it("falls back to a placeholder when no files are listed", () => {
    const p = promptMergeConflict([]);
    expect(p).toContain("(no file list available)");
  });

  it("instructs to finish with git commit", () => {
    const p = promptMergeConflict(["a.go"]);
    expect(p).toContain("git commit");
  });
});

// ================================================================
// resolveMainline — origin/HEAD → main → master
// ================================================================

describe("resolveMainline", () => {
  it("prefers origin/HEAD", async () => {
    queueGitResponses([
      { ok: true, stdout: "refs/remotes/origin/main\n" },
    ]);
    await expect(resolveMainline("/tmp/x")).resolves.toBe("main");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to main when origin/HEAD is absent", async () => {
    queueGitResponses([
      { ok: false, code: 1 },
      { ok: true, stdout: "abc123\n" }, // rev-parse --verify refs/heads/main
    ]);
    await expect(resolveMainline("/tmp/x")).resolves.toBe("main");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to master when main is absent", async () => {
    queueGitResponses([
      { ok: false, code: 1 },
      { ok: false, code: 1 },
      { ok: true, stdout: "abc123\n" }, // rev-parse --verify refs/heads/master
    ]);
    await expect(resolveMainline("/tmp/x")).resolves.toBe("master");
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("returns null when no mainline exists (not a repo)", async () => {
    queueGitResponses([
      { ok: false, code: 1 },
      { ok: false, code: 1 },
      { ok: false, code: 1 },
    ]);
    await expect(resolveMainline("/tmp/x")).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });
});

// ================================================================
// setupBranch — clean tree guard, branch creation
// ================================================================

describe("setupBranch", () => {
  it("creates the branch off the mainline and reports it", async () => {
    queueGitResponses([
      { ok: true, stdout: "refs/remotes/origin/main\n" }, // resolveMainline
      { ok: true, stdout: "" }, // git status --porcelain (clean)
      { ok: false, code: 1 }, // rev-parse --verify refs/heads/loop/01-feature (absent)
      { ok: true, stdout: "" }, // git checkout -b loop/01-feature main
    ]);
    const result = await setupBranch("/tmp/x", "internal/01-feature.md");
    expect(result).toEqual({
      kind: "ok",
      branch: { name: "loop/01-feature", base: "main", merged: false }});
  });

  it("uses the explicit name when given", async () => {
    queueGitResponses([
      { ok: true, stdout: "refs/remotes/origin/main\n" },
      { ok: true, stdout: "" },
      { ok: false, code: 1 },
      { ok: true, stdout: "" },
    ]);
    const result = await setupBranch("/tmp/x", "internal/01-feature.md", "my-branch");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.branch.name).toBe("my-branch");
    }
  });

  it("refuses on a dirty working tree", async () => {
    queueGitResponses([
      { ok: true, stdout: "refs/remotes/origin/main\n" },
      { ok: true, stdout: " M dirty.go\n" },
    ]);
    const result = await setupBranch("/tmp/x", "internal/01-feature.md");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("dirty");
    }
    // No checkout attempted: exactly 2 git calls.
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("refuses when the branch already exists", async () => {
    queueGitResponses([
      { ok: true, stdout: "refs/remotes/origin/main\n" },
      { ok: true, stdout: "" },
      { ok: true, stdout: "abc123\n" }, // branch exists
    ]);
    const result = await setupBranch("/tmp/x", "internal/01-feature.md");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("already exists");
    }
  });

  it("errors when the project is not a git repo", async () => {
    queueGitResponses([
      { ok: false, code: 1 },
      { ok: false, code: 1 },
      { ok: false, code: 1 },
    ]);
    const result = await setupBranch("/tmp/x", "internal/01-feature.md");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("not a git repository");
    }
  });

  it("errors when checkout -b fails", async () => {
    queueGitResponses([
      { ok: true, stdout: "refs/remotes/origin/main\n" },
      { ok: true, stdout: "" },
      { ok: false, code: 1 },
      { ok: false, code: 128, stderr: "fatal: not a git repository" },
    ]);
    const result = await setupBranch("/tmp/x", "internal/01-feature.md");
    expect(result.kind).toBe("error");
  });
});

// ================================================================
// commitAndMerge — commit, checkout base, merge
// ================================================================

describe("commitAndMerge", () => {
  const branch = { name: "loop/feat", base: "main", merged: false };

  it("commits uncommitted work, checks out base, merges cleanly", async () => {
    queueGitResponses([
      { ok: true, stdout: " M feat.go\n" }, // status: dirty
      { ok: true, stdout: "" }, // git add -A
      { ok: true, stdout: "[loop/feat abc123] 1 file" }, // git commit
      { ok: true, stdout: "" }, // git checkout main
      { ok: true, stdout: "Merge made by ..." }, // git merge --no-ff loop/feat
    ]);
    const result = await commitAndMerge("/tmp/x", branch, "go");
    expect(result).toEqual({ kind: "merged" });
    expect(execFileMock).toHaveBeenCalledTimes(5);
  });

  it("skips the commit step when the tree is clean", async () => {
    queueGitResponses([
      { ok: true, stdout: "" }, // status: clean
      { ok: true, stdout: "" }, // git checkout main
      { ok: true, stdout: "Merge made by ..." }, // git merge
    ]);
    const result = await commitAndMerge("/tmp/x", branch, "go");
    expect(result).toEqual({ kind: "merged" });
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("reports conflicted files when the merge conflicts", async () => {
    queueGitResponses([
      { ok: true, stdout: "" }, // status: clean
      { ok: true, stdout: "" }, // git checkout main
      { ok: false, code: 1, stderr: "CONFLICT (content)" }, // git merge
      { ok: true, stdout: "a.go\nb.go\n" }, // git diff --name-only --diff-filter=U
    ]);
    const result = await commitAndMerge("/tmp/x", branch, "go");
    expect(result).toEqual({ kind: "conflict", files: ["a.go", "b.go"] });
  });

  it("errors when checkout of the base fails", async () => {
    queueGitResponses([
      { ok: true, stdout: "" },
      { ok: false, code: 1, stderr: "pathspec 'main' did not match" },
    ]);
    const result = await commitAndMerge("/tmp/x", branch, "go");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("git checkout main failed");
    }
  });

  it("errors when the commit fails", async () => {
    queueGitResponses([
      { ok: true, stdout: " M feat.go\n" },
      { ok: true, stdout: "" }, // git add -A
      { ok: false, code: 1, stderr: "nothing to commit" },
    ]);
    const result = await commitAndMerge("/tmp/x", branch, "go");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("git commit failed");
    }
  });
});

// ================================================================
// verifyMergeComplete — after the Writer's single attempt
// ================================================================

describe("verifyMergeComplete", () => {
  it("merged: MERGE_HEAD gone and tree clean", async () => {
    queueGitResponses([
      { ok: false, code: 1 }, // rev-parse --verify MERGE_HEAD (absent)
      { ok: true, stdout: "" }, // git status --porcelain (clean)
    ]);
    await expect(verifyMergeComplete("/tmp/x")).resolves.toEqual({ kind: "merged" });
  });

  it("conflict: MERGE_HEAD still present", async () => {
    queueGitResponses([
      { ok: true, stdout: "abc123\n" }, // MERGE_HEAD present
      { ok: true, stdout: "a.go\n" }, // conflicted files
    ]);
    await expect(verifyMergeComplete("/tmp/x")).resolves.toEqual({ kind: "conflict", files: ["a.go"] });
  });

  it("error: MERGE_HEAD gone but tree dirty", async () => {
    queueGitResponses([
      { ok: false, code: 1 },
      { ok: true, stdout: "?? stray.go\n" },
    ]);
    const result = await verifyMergeComplete("/tmp/x");
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error).toContain("dirty");
    }
  });
});

// ================================================================
// mergeBranchBack — the done-effect wiring
// ================================================================

describe("mergeBranchBack", () => {
  it("no-op (returns 'merged') when there is no branch", async () => {
    const state = { current: makeState() }; // no branch field
    const pi = createMockExtensionAPI() as any;
    const ctx = makeMockCtx();
    const result = await mergeBranchBack(state, pi as any, ctx, vi.fn());
    expect(result).toBe("merged");
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("no-op when the branch is already merged", async () => {
    const state = { current: makeState({ branch: { name: "loop/f", base: "main", merged: true } }) };
    const pi = createMockExtensionAPI() as any;
    const ctx = makeMockCtx();
    const result = await mergeBranchBack(state, pi as any, ctx, vi.fn());
    expect(result).toBe("merged");
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("clean merge: sets merged=true, notifies, no Writer prompt", async () => {
    queueGitResponses([
      { ok: true, stdout: "" }, // status clean
      { ok: true, stdout: "" }, // checkout main
      { ok: true, stdout: "Merge made by" }, // merge ok
    ]);
    const state = { current: makeState({ branch: { name: "loop/f", base: "main", merged: false } }) };
    const pi = createMockExtensionAPI() as any;
    const ctx = makeMockCtx();
    const result = await mergeBranchBack(state, pi as any, ctx, vi.fn());
    expect(result).toBe("merged");
    expect(state.current.branch?.merged).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Merged 'loop/f' into 'main'"),
      "info");
    // No Writer prompt on a clean merge.
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("conflict: prompts the Writer (single attempt), merged stays false", async () => {
    queueGitResponses([
      { ok: true, stdout: "" },
      { ok: true, stdout: "" },
      { ok: false, code: 1, stderr: "CONFLICT" },
      { ok: true, stdout: "a.go\n" },
    ]);
    const state = { current: makeState({ branch: { name: "loop/f", base: "main", merged: false } }) };
    const pi = createMockExtensionAPI() as any;
    const ctx = makeMockCtx();
    const result = await mergeBranchBack(state, pi as any, ctx, vi.fn());
    expect(result).toBe("conflict");
    expect(state.current.branch?.merged).toBe(false);
    // The Writer prompt was sent with deliverAs.
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].content).toContain("exactly ONE turn");
    expect(pi.sentMessages[0].options.deliverAs).toBe("followUp");
    // A warning was raised.
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Merge conflict"),
      "warning");
  });

  it("error: warns, merged stays false, no Writer prompt", async () => {
    queueGitResponses([
      { ok: true, stdout: "" },
      { ok: false, code: 1, stderr: "pathspec 'main' did not match" },
    ]);
    const state = { current: makeState({ branch: { name: "loop/f", base: "main", merged: false } }) };
    const pi = createMockExtensionAPI() as any;
    const ctx = makeMockCtx();
    const result = await mergeBranchBack(state, pi as any, ctx, vi.fn());
    expect(result).toBe("error");
    expect(state.current.branch?.merged).toBe(false);
    expect(pi.sentMessages).toHaveLength(0);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Merge back failed"),
      "warning");
  });
});

// ================================================================
// verifyBranchMerge — the settle-time verification (single attempt spent)
// ================================================================

describe("verifyBranchMerge", () => {
  it("returns true immediately when already merged", async () => {
    const state = { current: makeState({ branch: { name: "loop/f", base: "main", merged: true } }) };
    const ctx = makeMockCtx();
    await expect(verifyBranchMerge(state, ctx, vi.fn())).resolves.toBe(true);
  });

  it("no branch → true (nothing to verify)", async () => {
    const state = { current: makeState() };
    const ctx = makeMockCtx();
    await expect(verifyBranchMerge(state, ctx, vi.fn())).resolves.toBe(true);
  });

  it("merge complete: sets merged=true, notifies success", async () => {
    queueGitResponses([
      { ok: false, code: 1 }, // MERGE_HEAD absent
      { ok: true, stdout: "" }, // clean
    ]);
    const state = { current: makeState({ branch: { name: "loop/f", base: "main", merged: false } }) };
    const ctx = makeMockCtx();
    const ok = await verifyBranchMerge(state, ctx, vi.fn());
    expect(ok).toBe(true);
    expect(state.current.branch?.merged).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Merge complete"),
      "info");
  });

  it("still conflicted: escalates (single attempt spent), merged stays false", async () => {
    queueGitResponses([
      { ok: true, stdout: "abc\n" }, // MERGE_HEAD present
      { ok: true, stdout: "a.go\n" },
    ]);
    const state = { current: makeState({ branch: { name: "loop/f", base: "main", merged: false } }) };
    const ctx = makeMockCtx();
    const ok = await verifyBranchMerge(state, ctx, vi.fn());
    expect(ok).toBe(false);
    expect(state.current.branch?.merged).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("single attempt is spent"),
      "warning");
  });
});

// ================================================================
// parseLoopArgs — --branch flag
// ================================================================

describe("parseLoopArgs --branch", () => {
  it("parses --branch <name>", () => {
    expect(parseLoopArgs("--branch my-branch spec.md")).toEqual({
      specPath: "spec.md",
      coverage: undefined,
      language: undefined,
      branch: "my-branch"});
  });

  it("parses --branch=<name> (equals form)", () => {
    expect(parseLoopArgs("--branch=feat/x spec.md")).toEqual({
      specPath: "spec.md",
      coverage: undefined,
      language: undefined,
      branch: "feat/x"});
  });

  it("absent → branch undefined", () => {
    expect(parseLoopArgs("spec.md").branch).toBeUndefined();
  });

  it("coexists with --coverage and --language", () => {
    expect(parseLoopArgs("--language go --coverage 90 --branch b spec.md")).toEqual({
      specPath: "spec.md",
      coverage: 90,
      language: "go",
      branch: "b"});
  });
});

// ================================================================
// formatStatus — branch line
// ================================================================

describe("formatStatus branch line", () => {
  it("shows the branch when present (unmerged)", () => {
    const s = makeState({ phase: "B", round: 2, branch: { name: "loop/f", base: "main", merged: false } });
    const out = formatStatus(s);
    expect(out).toContain("Branch: loop/f (off main) — unmerged");
  });

  it("shows merged when set", () => {
    const s = makeState({ phase: "done", branch: { name: "loop/f", base: "main", merged: true } });
    expect(formatStatus(s)).toContain("Branch: loop/f (off main) — merged");
  });

  it("omits the branch line when absent", () => {
    const s = makeState({ phase: "B", round: 2 });
    expect(formatStatus(s)).not.toContain("Branch:");
  });
});
