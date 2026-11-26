// U2 contract tests: scope-check and the holdback tier.
//
// Spec: internal/wire-holdback-test-contract.md. scope-check is author-agnostic
// (no behavior change): parseInventory strips [visible]/[holdback] tags, so
// holdback paths enter the allowed set, and holdback files are baseline-captured.
// A holdback write — by the Tester (Phase A) or the Writer (Phase B) — is NOT
// flagged as contamination. This test-locks that stance: do NOT assert a Writer
// holdback write is flagged (that would contradict the author-agnostic design).
//
// The git boundary is mocked (vi.mock on node:child_process) — no real git.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { parseInventory, checkScope } from "../src/scope-check";

const mockExecSync = vi.mocked(execSync);

const CWD = "/repo";

// A spec whose Inventory carries the two-tier tags.
const SPEC_HOLDBACK = [
  "# fix-foo",
  "",
  "## Inventory",
  "",
  "- `src/foo.ts` [visible]",
  "- `test/holdback/x.test.ts` [holdback]",
  "",
].join("\n");

beforeEach(() => {
  mockExecSync.mockReset();
});

describe("parseInventory strips the two-tier tags", () => {
  it("includes the holdback path in the allowed set", () => {
    expect(parseInventory(SPEC_HOLDBACK)).toEqual(["src/foo.ts", "test/holdback/x.test.ts"]);
  });
});

describe("holdback writes are not flagged (author-agnostic)", () => {
  it("(a) a Tester-written holdback file captured in the baseline is not contamination", () => {
    // Tester wrote it in Phase A; it is baseline-captured at B-start.
    mockExecSync.mockReturnValue("?? test/holdback/x.test.ts\n");
    const baseline = ["test/holdback/x.test.ts"];
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_HOLDBACK, baseline);
    expect(r.ok).toBe(true);
    expect(r.outOfScope).toEqual([]);
  });

  it("(b) a Writer write into holdbackSubdir during B is not flagged", () => {
    // Author-agnostic: scope-check does not distinguish Tester from Writer. The
    // holdback path is in the allowed set (parseInventory), so it is not flagged.
    mockExecSync.mockReturnValue(" M test/holdback/x.test.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_HOLDBACK);
    expect(r.ok).toBe(true);
    expect(r.outOfScope).toEqual([]);
  });

  it("(c) a Writer write OUTSIDE holdback (cross-spec) is still flagged", () => {
    // The isolation boundary is prompt discipline, not scope-check: real
    // cross-spec contamination is still caught.
    mockExecSync.mockReturnValue(" M test/holdback/x.test.ts\n M src/foo.ts\n M other-spec.test.ts\n");
    const r = checkScope(CWD, "internal/fix-foo.md", SPEC_HOLDBACK);
    expect(r.ok).toBe(false);
    expect(r.outOfScope).toContain("other-spec.test.ts");
  });
});
