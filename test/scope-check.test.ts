// Unit tests for the scope check (cross-spec contamination guard).
// The git boundary is mocked (vi.mock on node:child_process) — no real git
// spawns. parseInventory is pure string parsing, tested directly.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { parseInventory, checkScope } from "../src/scope-check";

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
});
