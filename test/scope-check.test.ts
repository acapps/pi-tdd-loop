// Unit tests for the scope check (cross-spec contamination guard).
// The git boundary is mocked (vi.mock on node:child_process) — no real git
// spawns. parseInventory is pure string parsing, tested directly.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { parseInventory, checkScope, getGitUntrackedFiles } from "../src/scope-check";

const mockExecSync = vi.mocked(execSync);

// A minimal spec with an Inventory table.
const SPEC_WITH_INVENTORY = `# fix-foo

## Problem

Something.

## Inventory

| File | Action |
|------|--------|
| \`src/foo.ts\` | Modify |
| \`test/foo.test.ts\` | Create |

## Interface

Something else.
`;

const SPEC_NO_INVENTORY = `# fix-foo

## Problem

No inventory here.
`;

describe("parseInventory", () => {
  it("extracts backtick-quoted first-column paths from the Inventory table", () => {
    expect(parseInventory(SPEC_WITH_INVENTORY)).toEqual(["src/foo.ts", "test/foo.test.ts"]);
  });

  // The template's ACTUAL Inventory format is a bullet list, not a table.
  // The old table-only parser returned null here → the scope check silently
  // skipped on every real spec (session 01a0d128).
  it("extracts file paths from the template's bullet-list Inventory", () => {
    const spec = [
      "# fix-foo",
      "",
      "## Inventory",
      "",
      "- **Files:**",
      "  - `src/events/before-agent.ts` — modify `buildWriterPrompt` (add two",
      "    branches); add two small pure helpers",
      "    `buildDisputeReviewPrompt` and `buildWriterConcedeFixPrompt`.",
      "  - `test/events/before-agent.test.ts` — extend the `Phase B` block.",
      "- **Imports:** none added.",
      "",
      "## Interface",
      "",
      "See `src/events/before-agent.ts`.",
    ].join("\n");
    // Only the two file paths; the helper function names (no `/`, no ext)
    // and the Interface-section path are excluded.
    expect(parseInventory(spec)).toEqual(["src/events/before-agent.ts", "test/events/before-agent.test.ts"]);
  });

  it("deduplicates a path that appears in both Files and another subsection", () => {
    const spec = "# f\n\n## Inventory\n\n- `src/a.ts` — modify\n- **Imports:** `src/a.ts` again\n\n## Interface\n";
    expect(parseInventory(spec)).toEqual(["src/a.ts"]);
  });

  it("strips a line qualifier (path:125 → path) so it dedupes against the bare path", () => {
    const spec = "# f\n\n## Inventory\n\n- `src/a.ts` — modify\n- Effect: `src/a.ts:125` returns X\n\n## Interface\n";
    expect(parseInventory(spec)).toEqual(["src/a.ts"]);
  });

  it("returns null when no Inventory section exists", () => {
    expect(parseInventory(SPEC_NO_INVENTORY)).toBeNull();
  });

  it("returns null when the Inventory section lists no file paths", () => {
    expect(parseInventory("# fix\n\n## Inventory\n\n(no files)\n\n## Interface\n")).toBeNull();
  });

  it("stops at the next ## section", () => {
    const spec = "# fix\n\n## Inventory\n\n| `a.ts` | Modify |\n\n## Interface\n\n| `b.ts` | not-inventoried |\n";
    expect(parseInventory(spec)).toEqual(["a.ts"]);
  });

  it("parses the real archived spec (bug-role-context-mismatch) from session 01a0d128", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const p = resolve(__dirname, "../internal/done-bug-role-context-mismatch.md");
    if (!readFileSync) return;
    const text = readFileSync(p, "utf-8");
    const inv = parseInventory(text);
    expect(inv).not.toBeNull();
    expect(inv).toContain("src/events/before-agent.ts");
    expect(inv).toContain("test/events/before-agent.test.ts");
  });
});

describe("checkScope", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  const CWD = "/project";

  it("skips (ok) when the spec is unreadable", () => {
    const r = checkScope(CWD, "internal/fix-foo.md", null);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe("spec unreadable");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("skips (ok) when the spec has no Inventory", () => {
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_NO_INVENTORY);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe("no Inventory section");
  });

  it("skips (ok) when the cwd is not a git repository", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe("not a git repository");
  });

  it("passes when all dirty files are in the Inventory", () => {
    mockExecSync.mockReturnValue(" M src/foo.ts\n?? test/foo.test.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.outOfScope).toEqual([]);
  });

  it("fails and names files outside the Inventory", () => {
    // The 01a0bba2 case: loop.ts and reviewer.ts dirty, not in the spec's Inventory.
    mockExecSync.mockReturnValue(" M src/foo.ts\n M src/commands/loop.ts\n M src/reviewer.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["src/commands/loop.ts", "src/reviewer.ts"]);
  });

  it("allows the spec file itself", () => {
    mockExecSync.mockReturnValue(" M internal/fix-foo.md\n M src/foo.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(true);
    expect(r.outOfScope).toEqual([]);
  });

  it("allows the spec file's done- archive twin", () => {
    // Only the done- twin is dirty (spec file already archived).
    mockExecSync.mockReturnValue(" M internal/done-fix-foo.md\n M src/foo.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(true);
    expect(r.outOfScope).toEqual([]);
  });

  it("allows internal/index.md (the loop updates it on archive)", () => {
    mockExecSync.mockReturnValue(" M internal/index.md\n M src/foo.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(true);
  });

  it("counts untracked files (a half-written contract test in another spec's territory)", () => {
    mockExecSync.mockReturnValue(" M src/foo.ts\n?? test/contracts/other-spec.test.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["test/contracts/other-spec.test.ts"]);
  });

  it("handles rename entries (old -> new): the new path is what matters", () => {
    mockExecSync.mockReturnValue("R  old/foo.ts -> src/foo.ts\n M src/reviewer.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["src/reviewer.ts"]);
  });

  it("handles quoted paths (unicode filenames)", () => {
    mockExecSync.mockReturnValue(' M "src/ünïcode.ts"\n M src/foo.ts\n');
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["src/ünïcode.ts"]);
  });

  // --- fix-scope-check-baseline: pre-existing dirty files are filtered out ---

  it("filters out pre-existing untracked files (baseline)", () => {
    // Session 01a0d6aa: prompt-evolution/ and prompt-forge/behavior-test.ts
    // were untracked before the spec started. They should not block the gate.
    mockExecSync.mockReturnValue(
      " M src/foo.ts\n?? prompt-evolution/\n?? prompt-forge/behavior-test.ts\n",
    );
    const baseline = ["prompt-evolution/", "prompt-forge/behavior-test.ts"];
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY, baseline);
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.outOfScope).toEqual([]);
  });

  it("still flags NEW untracked files not in baseline", () => {
    // A new untracked file created during the spec is still contamination.
    mockExecSync.mockReturnValue(
      " M src/foo.ts\n?? prompt-evolution/\n?? test/contracts/other-spec.test.ts\n",
    );
    const baseline = ["prompt-evolution/"];
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY, baseline);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["test/contracts/other-spec.test.ts"]);
  });

  it("without baseline: all dirty files are checked (backward compat)", () => {
    // No baseline arg → pre-existing untracked files are still flagged.
    mockExecSync.mockReturnValue(
      " M src/foo.ts\n?? prompt-evolution/\n",
    );
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["prompt-evolution/"]);
  });

  it("empty baseline: same as no baseline", () => {
    mockExecSync.mockReturnValue(" M src/foo.ts\n?? prompt-evolution/\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY, []);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["prompt-evolution/"]);
  });

  it("regression: session 01a0d6aa scenario passes with baseline", () => {
    // The 5 modified files are in the Inventory. The 2 untracked files
    // (prompt-evolution/, prompt-forge/behavior-test.ts) are in the baseline.
    mockExecSync.mockReturnValue(
      " M src/events/agent-settled/effect-applicator.ts\n"
      + " M src/state-validation.ts\n"
      + " M src/tools/negotiate.ts\n"
      + " M src/tools/state-io.ts\n"
      + " M src/types.ts\n"
      + "?? prompt-evolution/\n"
      + "?? prompt-forge/behavior-test.ts\n",
    );
    const baseline = ["prompt-evolution/", "prompt-forge/behavior-test.ts"];
    const spec = "## Inventory\n- `src/types.ts`\n- `src/state-validation.ts`\n- `src/tools/negotiate.ts`\n- `src/tools/state-io.ts`\n- `src/events/agent-settled/effect-applicator.ts`\n";
    const r = checkScope(CWD, "internal/fix-negotiated-resolution-dropped.md", spec, baseline);
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.outOfScope).toEqual([]);
  });

  it("regression: session 01a0d6aa scenario fails without baseline", () => {
    // Same dirty set, no baseline → the 2 untracked files are flagged.
    mockExecSync.mockReturnValue(
      " M src/events/agent-settled/effect-applicator.ts\n"
      + " M src/state-validation.ts\n"
      + " M src/tools/negotiate.ts\n"
      + " M src/tools/state-io.ts\n"
      + " M src/types.ts\n"
      + "?? prompt-evolution/\n"
      + "?? prompt-forge/behavior-test.ts\n",
    );
    const spec = "## Inventory\n- `src/types.ts`\n- `src/state-validation.ts`\n- `src/tools/negotiate.ts`\n- `src/tools/state-io.ts`\n- `src/events/agent-settled/effect-applicator.ts`\n";
    const r = checkScope(CWD, "internal/fix-negotiated-resolution-dropped.md", spec);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["prompt-evolution/", "prompt-forge/behavior-test.ts"]);
  });

  it("modified file dirty at spec start AND outside Inventory is still flagged", () => {
    // The Writer modifies src/bar.ts (not in Inventory) during the spec.
    // src/bar.ts was also modified at spec start, but it's a tracked file (M),
    // so it's NOT in the untracked baseline. It must still be flagged.
    mockExecSync.mockReturnValue(" M src/foo.ts\n M src/bar.ts\n");
    const baseline: string[] = []; // no untracked files at spec start
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_WITH_INVENTORY, baseline);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toEqual(["src/bar.ts"]);
  });
});

describe("getGitUntrackedFiles", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  const CWD = "/project";

  it("returns only untracked (??) files", () => {
    mockExecSync.mockReturnValue(
      " M src/foo.ts\n?? prompt-evolution/\n M src/bar.ts\n?? test/new.test.ts\n",
    );
    const r = getGitUntrackedFiles(CWD);
    expect(r).toEqual(["prompt-evolution/", "test/new.test.ts"]);
  });

  it("returns empty array when no untracked files", () => {
    mockExecSync.mockReturnValue(" M src/foo.ts\n M src/bar.ts\n");
    const r = getGitUntrackedFiles(CWD);
    expect(r).toEqual([]);
  });

  it("returns null when not a git repository", () => {
    mockExecSync.mockImplementation(() => { throw new Error("not a git repo"); });
    const r = getGitUntrackedFiles(CWD);
    expect(r).toBeNull();
  });

  it("handles quoted paths", () => {
    mockExecSync.mockReturnValue('?? "prompt-ünïcode/"\n');
    const r = getGitUntrackedFiles(CWD);
    expect(r).toEqual(["prompt-ünïcode/"]);
  });
});
