// Contract tests for the fold's PURE core (src/fold.ts).
//
// Spec: internal/wire-holdback-test-contract.md. The fold is the mechanical
// settle step: promote every non-conceded [holdback] Inventory row to
// [visible], drop every conceded one (matched by test+subtest → file), and
// (U3) merge the promoted files out of the holdback subdir. This module is the
// pure, I/O-free core so it is hermetic to test. STUB bodies — these fail until
// the Writer implements the fold.

import { describe, it, expect } from "vitest";
import {
  promoteHoldback,
  dropConceded,
  consolidate,
  consolidateStatus,
  canonicalHoldbackTarget,
  moveHoldbackFile,
} from "../src/fold";

// A spec Inventory with two holdback rows.
const SPEC_WITH_HOLDBACK = [
  "## Inventory",
  "- `test/holdback/math.test.ts` [holdback]",
  "- `test/holdback/string.test.ts` [holdback]",
  "",
].join("\n");

// Holdback file contents, keyed by path. The mapping from a conceded test to
// its defining file is derived from these contents.
const HOLDBACK_FILES = {
  "test/holdback/math.test.ts": 'describe("math", () => { it("adds", () => {}); });',
  "test/holdback/string.test.ts": 'describe("strings", () => { it("reverses", () => {}); });',
};

describe("promoteHoldback", () => {
  it("flips every [holdback] row to [visible] and counts them", () => {
    const { specText, promoted } = promoteHoldback(SPEC_WITH_HOLDBACK);
    expect(promoted).toBe(2);
    expect(specText).not.toContain("[holdback]");
    expect(specText).toContain("`test/holdback/math.test.ts` [visible]");
    expect(specText).toContain("`test/holdback/string.test.ts` [visible]");
  });

  it("is a no-op when there are no holdback rows", () => {
    const { specText, promoted } = promoteHoldback("## Inventory\n- `a.test.ts` [visible]");
    expect(promoted).toBe(0);
    expect(specText).toBe("## Inventory\n- `a.test.ts` [visible]");
  });

  it("is a no-op on an empty spec", () => {
    const { specText, promoted } = promoteHoldback("");
    expect(promoted).toBe(0);
    expect(specText).toBe("");
  });
});

describe("dropConceded", () => {
  it("removes the conceded files' rows and counts them", () => {
    const { specText, promoted } = dropConceded(
      SPEC_WITH_HOLDBACK,
      ["test/holdback/string.test.ts"],
    );
    expect(promoted).toBe(1);
    expect(specText).not.toContain("string.test.ts");
    expect(specText).toContain("`test/holdback/math.test.ts` [holdback]");
  });
});

describe("consolidate (promote + drop + test→file mapping)", () => {
  it("promotes the non-conceded file and drops the conceded one", () => {
    const result = consolidate({
      specText: SPEC_WITH_HOLDBACK,
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
      resolvedFailures: [{ test: "strings", subtest: "reverses", output: "expected 1" }],
    });
    // The conceded test "strings/reverses" lives in string.test.ts → dropped.
    expect(result.droppedFiles).toEqual(["test/holdback/string.test.ts"]);
    // The other file is promoted.
    expect(result.promotedFiles).toEqual(["test/holdback/math.test.ts"]);
    expect(result.promoted).toBe(1);
    expect(result.dropped).toBe(1);
    // Folded spec: promoted row is [visible], conceded row is gone.
    expect(result.specText).toContain("`test/holdback/math.test.ts` [visible]");
    expect(result.specText).not.toContain("string.test.ts");
  });

  it("maps the conceded test to its file by test+subtest, not by guess", () => {
    // Two files both contain "it"; the subtest disambiguates which file.
    const files = {
      "test/holdback/a.test.ts": 'describe("suite", () => { it("edge", () => {}); });',
      "test/holdback/b.test.ts": 'describe("suite", () => { it("other", () => {}); });',
    };
    const result = consolidate({
      specText: [
        "## Inventory",
        "- `test/holdback/a.test.ts` [holdback]",
        "- `test/holdback/b.test.ts` [holdback]",
        "",
      ].join("\n"),
      holdbackSubdir: "test/holdback",
      holdbackFiles: files,
      resolvedFailures: [{ test: "suite", subtest: "edge", output: "boom" }],
    });
    expect(result.droppedFiles).toEqual(["test/holdback/a.test.ts"]);
    expect(result.promotedFiles).toEqual(["test/holdback/b.test.ts"]);
  });

  it("is idempotent: a second run over the folded spec folds nothing", () => {
    const first = consolidate({
      specText: SPEC_WITH_HOLDBACK,
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
      resolvedFailures: [{ test: "strings", subtest: "reverses", output: "x" }],
    });
    expect(first.promoted).toBeGreaterThan(0);
    const second = consolidate({
      specText: first.specText,
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
      resolvedFailures: [],
    });
    expect(second.promoted).toBe(0);
    expect(second.dropped).toBe(0);
  });

  it("promotes a single holdback file when nothing is conceded", () => {
    const result = consolidate({
      specText: "## Inventory\n- `test/holdback/only.test.ts` [holdback]\n",
      holdbackSubdir: "test/holdback",
      holdbackFiles: { "test/holdback/only.test.ts": 'describe("x", () => { it("y", () => {}); });' },
      resolvedFailures: [],
    });
    expect(result.promoted).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.promotedFiles).toEqual(["test/holdback/only.test.ts"]);
    expect(result.specText).toContain("`test/holdback/only.test.ts` [visible]");
  });

  it("is a no-op on empty inputs", () => {
    const result = consolidate({
      specText: "",
      holdbackSubdir: "test/holdback",
      holdbackFiles: {},
      resolvedFailures: [],
    });
    expect(result.promoted).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.promotedFiles).toEqual([]);
    expect(result.droppedFiles).toEqual([]);
  });
});

describe("consolidateStatus", () => {
  it("renders what folded", () => {
    const s = consolidateStatus(1, 1, false);
    expect(s).toContain("1");
    expect(s).toContain("fold");
  });
});

describe("U3 — canonicalHoldbackTarget", () => {
  it("derives a canonical test-tree location, not the holdback path", () => {
    const target = canonicalHoldbackTarget("test/holdback/string.test.ts", "test/holdback");
    expect(target).not.toBe("test/holdback/string.test.ts");
    expect(target).not.toContain("holdback");
    expect(target).not.toBe("");
  });
});

describe("U3 — moveHoldbackFile", () => {
  it("moves the file out and reports the move", () => {
    const res = moveHoldbackFile({
      cwd: "/repo",
      file: "test/holdback/string.test.ts",
      subdir: "test/holdback",
      target: "test/string.test.ts",
    });
    expect(res.moved).toBe(true);
    expect(res.to).toBe("test/string.test.ts");
  });

  it("leaves a non-empty subdir intact", () => {
    // A non-empty subdir must not be deleted; the move of one file still reports.
    const res = moveHoldbackFile({
      cwd: "/repo",
      file: "test/holdback/a.test.ts",
      subdir: "test/holdback",
      target: "test/a.test.ts",
    });
    expect(res.moved).toBe(true);
  });
});
