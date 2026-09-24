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

  it("returns null when no Inventory section exists", () => {
    expect(parseInventory(SPEC_NO_INVENTORY)).toBeNull();
  });

  it("returns null when the Inventory section has no table rows", () => {
    expect(parseInventory("# fix\n\n## Inventory\n\n(no files)\n\n## Interface\n")).toBeNull();
  });

  it("stops at the next ## section", () => {
    const spec = "# fix\n\n## Inventory\n\n| `a.ts` | Modify |\n\n## Interface\n\n| `b.ts` | not-inventoried |\n";
    expect(parseInventory(spec)).toEqual(["a.ts"]);
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
