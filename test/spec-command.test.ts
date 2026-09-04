// spec-command tests — /spec one-shot Author command
// Contract: internal/spec-command.md (Phase 0 approved)
// Pure-function level: no process spawning, no npx, no temp-dir scaffolding.

import { describe, it, expect, vi } from "vitest";

// Per the repo's ESM-mock rule: vi.mock on node builtins (vi.spyOn does not
// work on ESM node builtins). Only the fs surface spec-command.ts uses.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { readFileSync, existsSync } from "node:fs";
import {
  slugSpecName,
  normalizeOutDir,
  resolveGoal,
  readRubric,
  renderAuthorPrompt,
  type AuthorPromptInput,
} from "../src/spec-command";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

// ================================================================
// slugSpecName — delegates to slugBugName
// ================================================================

describe("slugSpecName", () => {
  it("whitespace-only slugifies to empty string", () => {
    expect(slugSpecName("   ")).toBe("");
  });

  it("empty string slugifies to empty string", () => {
    expect(slugSpecName("")).toBe("");
  });

  it("slugifies multi-word names", () => {
    expect(slugSpecName("Fix the Gate Runner")).toBe("fix-the-gate-runner");
  });

  it("collapses mixed separator runs", () => {
    expect(slugSpecName("a--b__c")).toBe("a-b-c");
  });
});

// ================================================================
// normalizeOutDir — strips trailing slashes so paths render as <dir>/<slug>.md
// ================================================================

describe("normalizeOutDir", () => {
  it("strips a trailing slash", () => {
    expect(normalizeOutDir("internal/")).toBe("internal");
  });

  it("keeps a bare dir", () => {
    expect(normalizeOutDir("internal")).toBe("internal");
  });

  it("strips trailing slashes from a custom dir", () => {
    expect(normalizeOutDir("backlog/")).toBe("backlog");
  });

  it("empty string stays empty", () => {
    expect(normalizeOutDir("")).toBe("");
  });
});

// ================================================================
// resolveGoal — verbatim goal, @file form, path resolution, missing file
// ================================================================

describe("resolveGoal", () => {
  it("empty goal returns empty string verbatim", () => {
    expect(resolveGoal("", "/tmp/proj")).toBe("");
  });

  it("plain goal text is returned verbatim", () => {
    expect(resolveGoal("add a retry policy to the gate runner", "/tmp/proj")).toBe(
      "add a retry policy to the gate runner",
    );
  });

  it("@file form reads the file and returns its text", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("goal text from file");
    expect(resolveGoal("@notes.md", "/tmp/proj")).toBe("goal text from file");
  });

  it("existing relative path resolves against cwd first", () => {
    mockExistsSync.mockImplementation((p: unknown) => p === "/tmp/proj/notes.md");
    mockReadFileSync.mockReturnValue("cwd goal");
    expect(resolveGoal("notes.md", "/tmp/proj")).toBe("cwd goal");
    // resolveGoal probes raw, then cwd-resolved; readSpec then re-probes the
    // resolved file. The cwd-resolved probe must precede the read.
    const calls = mockExistsSync.mock.calls.map((c) => c[0]);
    const rawIdx = calls.indexOf("notes.md");
    const cwdIdx = calls.indexOf("/tmp/proj/notes.md");
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(cwdIdx).toBeGreaterThan(rawIdx);
  });

  it("relative path falls back to process cwd when not under cwd", () => {
    mockExistsSync.mockImplementation((p: unknown) => p === "notes.md");
    mockReadFileSync.mockReturnValue("process-cwd goal");
    expect(resolveGoal("notes.md", "/tmp/proj")).toBe("process-cwd goal");
  });

  it("missing referenced file returns null", () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveGoal("@nope.md", "/tmp/proj")).toBeNull();
  });

  it("returns the goal verbatim when it is not an existing path anywhere", () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveGoal("add a retry policy", "/tmp/proj")).toBe("add a retry policy");
  });
});

// ================================================================
// readRubric — docs/spec-authoring.md text or null
// ================================================================

describe("readRubric", () => {
  it("returns the rubric text when present", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("the rubric");
    expect(readRubric("/tmp/proj")).toBe("the rubric");
  });

  it("returns null when the rubric file is absent", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readRubric("/tmp/proj")).toBeNull();
  });
});

// ================================================================
// renderAuthorPrompt — verbatim pins from internal/spec-command.md
// ================================================================

describe("renderAuthorPrompt", () => {
  const baseInput: AuthorPromptInput = {
    goal: "add a retry policy",
    slug: "foo",
    outDir: "internal",
    rubric: "the rubric text",
    now: new Date("2026-09-04T01:00:00.000Z"),
  };

  it("starts with the role line", () => {
    const out = renderAuthorPrompt(baseInput);
    expect(out.startsWith("You are the AUTHOR.")).toBe(true);
  });

  it("fences the goal between --- markers", () => {
    const out = renderAuthorPrompt(baseInput);
    expect(out).toContain("---\nadd a retry policy\n---");
  });

  it("pins the output file line", () => {
    const out = renderAuthorPrompt(baseInput);
    expect(out).toContain("Output file: internal/foo.md");
  });

  it("contains all nine numbered rules in order", () => {
    const out = renderAuthorPrompt(baseInput);
    const ruleMarkers = [
      "1. VERIFY, don't remember.",
      "2. PIN VERBATIM.",
      "3. CLOSE EVERY LIST.",
      "4. OWN EVERY BEHAVIOR.",
      "5. PLAN THE TESTS.",
      "6. UNIT SIZING.",
      "7. PRESERVE QUIRKS.",
      "8. TYPE FACTS.",
      "9. LIVE-TOOLCHAIN TESTS.",
    ];
    let last = -1;
    for (const marker of ruleMarkers) {
      const idx = out.indexOf(marker);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("contains the closed template outline with all ten headings", () => {
    const out = renderAuthorPrompt(baseInput);
    const headings = [
      "# <slug>",
      "## Problem",
      "## Target",
      "## Interface",
      "## Behavior",
      "## Inventory",
      "## Test Strategy",
      "## Scope lines",
      "## Acceptance Criteria",
      "## Dependencies",
      "## Findings log",
    ];
    let last = -1;
    for (const h of headings) {
      const idx = out.indexOf(h);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("pins the generation stamp instruction", () => {
    const out = renderAuthorPrompt(baseInput);
    expect(out).toContain(
      "> Generated by /spec on 2026-09-04T01:00:00.000Z — goal: add a retry policy",
    );
  });

  it("ends by telling the Author to stop producing tool calls", () => {
    const out = renderAuthorPrompt(baseInput);
    expect(out).toContain("stop producing tool calls");
  });

  it("rubric-present variant pins the rubric section text", () => {
    const out = renderAuthorPrompt(baseInput);
    expect(out).toContain(
      "The template, failure classes, and filling rules live in docs/spec-authoring.md — read it first and follow it.",
    );
  });

  it("rubric-null variant pins the fallback block", () => {
    const out = renderAuthorPrompt({ ...baseInput, rubric: null });
    expect(out).toContain(
      "No template file is available in this repo. Follow the rules below and the standard spec",
    );
  });

  it("truncates the goal to 120 chars in the stamp with newlines collapsed", () => {
    const longGoal = "x".repeat(200);
    const out = renderAuthorPrompt({ ...baseInput, goal: longGoal });
    expect(out).toContain(`goal: ${"x".repeat(120)}`);
    expect(out).not.toContain(`goal: ${"x".repeat(121)}`);

    const nlGoal = "line one\nline two";
    const outNl = renderAuthorPrompt({ ...baseInput, goal: nlGoal });
    expect(outNl).toContain("goal: line one line two");
  });
});
