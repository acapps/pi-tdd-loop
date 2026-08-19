// Unit contract tests for src/bug-spec.ts
// Contract: internal/log-bug-spec.md (Phase 0 approved) — 26 cases:
//   slugBugName (6) / extractLoopLogs (12) / renderBugSpec (5) / writeBugSpec (3)

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  slugBugName,
  extractLoopLogs,
  renderBugSpec,
  writeBugSpec,
  type BugSpecInput,
} from "../src/bug-spec";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const T = 1700000000000; // fixed epoch ms — ISO expected values derive from it
const ISO = new Date(T).toISOString();

function custom(customType: string, data: unknown): Record<string, unknown> {
  return { type: "custom", customType, data };
}

function makeInput(overrides: Partial<BugSpecInput> = {}): BugSpecInput {
  return {
    name: "test-bug",
    slug: "test-bug",
    phase: "A",
    round: 1,
    specPath: "spec.md",
    language: "go",
    lines: [],
    now: new Date("2024-01-15T10:00:00.000Z"),
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// slugBugName — 6 cases
// ---------------------------------------------------------------------------

describe("slugBugName", () => {
  it("slugifies multi-word names to kebab-case", () => {
    expect(slugBugName("Frozen at Phase B Step 5")).toBe(
      "frozen-at-phase-b-step-5"
    );
  });

  it("leaves an already-slugged name unchanged", () => {
    expect(slugBugName("already-slug")).toBe("already-slug");
  });

  it("returns empty string for empty and whitespace-only input", () => {
    expect(slugBugName("")).toBe("");
    expect(slugBugName("   ")).toBe("");
  });

  it("collapses runs of non-[a-z0-9] chars to a single dash", () => {
    expect(slugBugName("a--b")).toBe("a-b");
  });

  it("treats non-ASCII letters as dash-runs and trims them", () => {
    expect(slugBugName("über")).toBe("ber");
  });

  it("trims leading and trailing punctuation", () => {
    expect(slugBugName("__weird__name__")).toBe("weird-name");
  });
});

// ---------------------------------------------------------------------------
// extractLoopLogs — 12 cases
// ---------------------------------------------------------------------------

describe("extractLoopLogs", () => {
  it("formats loop-debug entries as [iso] [debug] msg", () => {
    const lines = extractLoopLogs([
      custom("loop-debug", { ts: T, msg: "hello" }),
    ]);
    expect(lines).toEqual([`[${ISO}] [debug] hello`]);
  });

  it("formats loop-state entries as [ts] [state] phase=<p> round=<r>", () => {
    const lines = extractLoopLogs([
      custom("loop-state", { phase: "B", round: 3, ts: T }),
    ]);
    expect(lines).toEqual([`[${ISO}] [state] phase=B round=3`]);
  });

  it("formats loop-refusal with path as 'blocked write to <path>'", () => {
    const lines = extractLoopLogs([
      custom("loop-refusal", {
        phase: "B",
        path: "src/x.go",
        tool: "write",
        ts: T,
      }),
    ]);
    expect(lines).toEqual([
      `[${ISO}] [refusal] B: blocked write to src/x.go`,
    ]);
  });

  it("formats loop-refusal without path (tool-call.ts:90 shape) as 'blocked <tool>'", () => {
    const lines = extractLoopLogs([
      custom("loop-refusal", { phase: "B", tool: "write", ts: T }),
    ]);
    expect(lines).toEqual([`[${ISO}] [refusal] B: blocked write`]);
  });

  it("formats loop-negotiate as '[negotiate] <action>: <text>' with 80-char text truncation", () => {
    const lines = extractLoopLogs([
      custom("loop-negotiate", {
        phase: "A",
        round: 1,
        action: "propose",
        text: "t".repeat(100),
        ts: T,
      }),
    ]);
    expect(lines).toEqual([
      `[${ISO}] [negotiate] propose: ${"t".repeat(80)}`,
    ]);
  });

  it("formats filed loop-dispute as '#<disputeCount>: <claim>' with 80-char claim truncation", () => {
    const lines = extractLoopLogs([
      custom("loop-dispute", {
        phase: "C",
        round: 2,
        disputeCount: 1,
        claim: "c".repeat(100),
        text: "t",
        ts: T,
      }),
    ]);
    expect(lines).toEqual([`[${ISO}] [dispute] #1: ${"c".repeat(80)}`]);
  });

  it("formats concede loop-dispute (tools.ts:362 shape, no disputeCount/claim) as '<action>'", () => {
    const lines = extractLoopLogs([
      custom("loop-dispute", {
        phase: "C",
        round: 2,
        action: "concede",
        ts: T,
      }),
    ]);
    expect(lines).toEqual([`[${ISO}] [dispute] concede`]);
  });

  it("resolves ts from data.ts (epoch ms → ISO) and top-level timestamp (used as-is)", () => {
    const lines = extractLoopLogs([
      custom("loop-debug", { ts: T, msg: "a" }),
      {
        type: "custom",
        customType: "loop-state",
        timestamp: "2024-06-01T00:00:00Z",
        phase: "A",
        round: 1,
      },
    ]);
    expect(lines).toEqual([
      `[${ISO}] [debug] a`,
      `[2024-06-01T00:00:00Z] [state] phase=A round=1`,
    ]);
  });

  it("falls back to top-level payload when data is absent and renders '-' when no ts exists", () => {
    const lines = extractLoopLogs([
      { type: "custom", customType: "loop-state", phase: "B", round: 2 },
    ]);
    expect(lines).toEqual(["[-] [state] phase=B round=2"]);
  });

  it("excludes non-custom entries and unknown customTypes; returns [] for empty input", () => {
    expect(extractLoopLogs([])).toEqual([]);
    const lines = extractLoopLogs([
      { type: "message", text: "not a custom entry" },
      { type: "custom", customType: "loop-unknown", data: { phase: "A" } },
    ]);
    expect(lines).toEqual([]);
  });

  it("excludes the dead loop-gate type (no producer emits it)", () => {
    const lines = extractLoopLogs([
      custom("loop-gate", { phase: "A", round: 1, result: "pass" }),
    ]);
    expect(lines).toEqual([]);
  });

  it("preserves input order across interleaved types (incl. dispute JSON-fallback branch with 100-char truncation)", () => {
    const elseData = { phase: 1, round: 1, padding: "x".repeat(120) };
    const lines = extractLoopLogs([
      custom("loop-state", { phase: "A", round: 1, ts: T }),
      custom("loop-dispute", elseData), // no claim, no action → JSON fallback
      custom("loop-debug", { ts: T + 1000, msg: "end" }),
    ]);
    expect(lines).toEqual([
      `[${ISO}] [state] phase=A round=1`,
      `[-] [dispute] ${JSON.stringify(elseData).slice(0, 100)}`,
      `[${new Date(T + 1000).toISOString()}] [debug] end`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// renderBugSpec — 5 cases
// ---------------------------------------------------------------------------

describe("renderBugSpec", () => {
  it("renders all section headings in the pinned order, joins log lines, and stamps the fixed now", () => {
    const md = renderBugSpec(makeInput({ lines: ["l1", "l2"] }));
    const order = [
      "## Context",
      "## Observed problem",
      "## Proposed fix",
      "## Log excerpt",
      "## Acceptance",
    ];
    expect(md.startsWith("# Bug: ")).toBe(true);
    let prev = -1;
    for (const heading of order) {
      const idx = md.indexOf(heading);
      expect(idx, `missing heading: ${heading}`).toBeGreaterThan(prev);
      prev = idx;
    }
    // Log excerpt: lines joined by "\n", in order
    expect(md).toContain("l1\nl2");
    // Generated line: now.toISOString() interpolated
    expect(md).toContain(
      "> Generated by /loop-debug --log-bug on 2024-01-15T10:00:00.000Z"
    );
  });

  it("keeps the name verbatim in the title", () => {
    const md = renderBugSpec(makeInput({ name: "Frozen at Phase B Step 5" }));
    expect(md).toContain("# Bug: Frozen at Phase B Step 5");
  });

  it("renders 'no active loop' Context for idle phase, and the state bullet otherwise", () => {
    const idle = renderBugSpec(makeInput({ phase: "idle" }));
    expect(idle).toContain("- Loop state at logging time: no active loop");

    const active = renderBugSpec(
      makeInput({ phase: "B", round: 3, specPath: "x.md", language: "java" }),
    );
    expect(active).toContain(
      "- Loop state at logging time: phase=B, round=3, spec=x.md, language=java",
    );
  });

  it("renders the no-events placeholder when lines is empty", () => {
    const md = renderBugSpec(makeInput({ lines: [] }));
    expect(md).toContain("(no loop events found in this session)");
  });

  it("contains the placeholder prompt strings verbatim", () => {
    const md = renderBugSpec(makeInput({ lines: ["l1"] }));
    expect(md).toContain(
      "Describe the misbehavior: what you expected, what happened, where. (Fill in before running the loop.)",
    );
    expect(md).toContain(
      "Describe the fix approach the Writer should take. (Fill in before running the loop.)",
    );
    expect(md).toContain("- The observed problem no longer reproduces.");
    expect(md).toContain("- <fill in: specific check>");
  });
});

// ---------------------------------------------------------------------------
// writeBugSpec — 3 cases
// ---------------------------------------------------------------------------

describe("writeBugSpec", () => {
  it("writes the markdown to <cwd>/bug-fix-<slug>.md and returns {ok:true, path}", () => {
    const tmp = makeTmp("bugspec-write-");
    const md = "# Bug: my-bug\nbody\n";
    const res = writeBugSpec(tmp, "my-bug", md);
    expect(res).toEqual({
      ok: true,
      path: path.join(tmp, "bug-fix-my-bug.md"),
    });
    if (!res.ok) throw new Error(`unexpected failure: ${res.reason}`);
    expect(fs.readFileSync(res.path, "utf8")).toBe(md);
  });

  it("returns {ok:false, reason:'exists'} without touching a pre-existing file", () => {
    const tmp = makeTmp("bugspec-exists-");
    const file = path.join(tmp, "bug-fix-dup.md");
    fs.writeFileSync(file, "original", "utf8");
    const res = writeBugSpec(tmp, "dup", "replacement");
    expect(res).toEqual({ ok: false, reason: "exists", message: "" });
    expect(fs.readFileSync(file, "utf8")).toBe("original");
  });

  it("returns {ok:false, reason:'write-failed'} for a non-existent cwd without throwing", () => {
    const tmp = makeTmp("bugspec-fail-");
    const res = writeBugSpec(path.join(tmp, "no-such-dir"), "x", "md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("write-failed");
      expect(res.message).toBeTypeOf("string");
    }
    expect(
      fs.existsSync(path.join(tmp, "no-such-dir", "bug-fix-x.md")),
    ).toBe(false);
  });
});
