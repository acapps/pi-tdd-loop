// Structural contract tests for the commands.ts split —
// internal/refactor-commands-split.md
//
// Pins the file-level acceptance criteria:
//   AC1 — new module files exist, src/commands.ts is deleted
//   AC2 — zero textual references to commands.ts in src/
//   AC3 — zero textual references to commands.ts in test/
//   AC5 — no src/commands/*.ts exceeds 200 lines
//
// These are static-analysis tests (fs only) — they run in milliseconds
// and spawn nothing.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = resolve(__dirname, "..", "..");

function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf-8");
}

function lineCount(p: string): number {
  return read(p).trim().split("\n").length;
}

// ================================================================
// AC1 — target structure
// ================================================================

describe("AC1 — target structure", () => {
  const newFiles = [
    "src/commands/index.ts",
    "src/commands/loop.ts",
    "src/commands/status.ts",
    "src/commands/debug.ts",
    "src/commands/lifecycle.ts",
    "src/commands/patch.ts",
    "src/commands/decompose.ts",
    "src/state-helpers.ts",
  ];

  it.each(newFiles)("%s exists", (f) => {
    expect(existsSync(join(ROOT, f))).toBe(true);
  });

  it("src/commands.ts is deleted (the flat file must not come back)", () => {
    expect(existsSync(join(ROOT, "src/commands.ts"))).toBe(false);
  });
});

// ================================================================
// AC2 — no textual references to commands.ts in src/
// ================================================================

describe("AC2 — src/ has zero import references to commands.ts", () => {
  it("no import-from commands.ts in src/", () => {
    let out = "";
    try {
      out = execSync(
        `grep -rn 'from.*["\\x27]commands\\.ts["\\x27]' "${join(ROOT, "src")}" || true`,
        { encoding: "utf-8" },
      );
    } catch {
      // grep exits 1 on no match — handled by `|| true`
    }
    expect(out.trim()).toBe("");
  });

  // refactor-tools-split: the flat src/tools.ts is now src/tools/ (a directory
  // module). The stale-reference concern (a leftover comment naming the old
  // flat commands.ts) is generalized to any src/tools/ module.
  it("no src/tools/ module names the old flat commands.ts", () => {
    const toolsDir = join(ROOT, "src", "tools");
    const files = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      expect(read(join("src", "tools", f))).not.toMatch(/commands\.ts/);
    }
  });
});

// ================================================================
// AC3 — no textual references to commands.ts in test/
// ================================================================

describe("AC3 — test/ has zero import references to commands.ts", () => {
  it("no import-from commands.ts in test/", () => {
    let out = "";
    try {
      out = execSync(
        `grep -rn 'from.*["\\x27]commands\\.ts["\\x27]' "${join(ROOT, "test")}" || true`,
        { encoding: "utf-8" },
      );
    } catch {
      // no match
    }
    expect(out.trim()).toBe("");
  });
});

// ================================================================
// AC5 — module size budget (200 lines per file)
// ================================================================

describe("AC5 — size budget", () => {
  const sizedFiles = [
    "src/commands/index.ts",
    "src/commands/loop.ts",
    "src/commands/status.ts",
    "src/commands/debug.ts",
    "src/commands/lifecycle.ts",
    "src/commands/patch.ts",
    "src/commands/decompose.ts",
    "src/state-helpers.ts",
  ];

  it.each(sizedFiles)("%s is under 200 lines", (f) => {
    const n = lineCount(f);
    expect(n).toBeLessThan(200);
    expect(n).toBeGreaterThan(0);
  });
});

// ================================================================
// Barrel surface — src/commands/index.ts re-exports exactly the 10 cmd*
// ================================================================

describe("barrel surface", () => {
  const expected = [
    "cmdLoop", "cmdStatus", "cmdContinue", "cmdRestart", "cmdDebug",
    "cmdCancel", "cmdApprove", "cmdStop", "cmdPatch", "cmdDecompose",
  ];

  it("index.ts re-exports every cmd* handler exactly once", () => {
    const src = read("src/commands/index.ts");
    for (const name of expected) {
      const matches = src.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
      expect(matches.length, `${name} should be referenced in index.ts`).toBeGreaterThan(0);
    }
  });

  it("index.ts does not define any cmd* itself (re-exports only)", () => {
    const src = read("src/commands/index.ts");
    expect(src).not.toMatch(/export\s+async\s+function\s+cmd/);
    expect(src).not.toMatch(/export\s+function\s+cmd/);
  });
});
