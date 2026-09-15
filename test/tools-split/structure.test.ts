// Structural contract tests for the tools.ts split —
// internal/refactor-tools-split.md
//
// Pins the file-level acceptance criteria:
//   AC1 — src/tools.ts is deleted, the six src/tools/ modules exist
//   AC2 — src/tools/index.ts re-exports the public API (negotiatePropose,
//         negotiateReview, isAgreeProposal)
//   AC3 — each src/tools/*.ts module is under 200 lines
//   AC4 — root index.ts still imports * as Tool from "./src/tools" (unchanged)
//   AC5 — no new dependencies in package.json (only the 4 pinned devDeps)
//   AC6 — zero functional references to the flat file src/tools.ts in src/,
//         test/, and index.ts (imports, call sites, disk reads).
//         Needle built at runtime so this file stays clean.
//   AC7 — no circular imports inside src/tools/ (static import-graph scan)
//
// These are static-analysis tests (fs only) — they run in milliseconds
// and spawn nothing.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");

function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf-8");
}

function lineCount(p: string): number {
  return read(p).trim().split("\n").length;
}

function grepNeedle(needle: string): string[] {
  const out: string[] = [];
  const stack = ["src", "test", "index.ts"];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const full = join(ROOT, rel);
    let isFile = true;
    try {
      isFile = readFileSync(full).length >= 0;
    } catch {
      isFile = false;
    }
    if (isFile) {
      if (read(rel).includes(needle)) out.push(rel);
    } else {
      for (const entry of readdirSync(full, { withFileTypes: true })) {
        if (entry.name === "e2e") continue; // real-toolchain dir, excluded from default sweep
        if (entry.isDirectory()) stack.push(join(rel, entry.name));
        else if (entry.name.endsWith(".ts")) stack.push(join(rel, entry.name));
      }
    }
  }
  return out;
}

// ================================================================
// AC1 — target structure: flat file deleted, six modules exist
// ================================================================

describe("AC1 — target structure", () => {
  const newFiles = [
    "src/tools/index.ts",
    "src/tools/types.ts",
    "src/tools/negotiate.ts",
    "src/tools/dispute.ts",
    "src/tools/phase0.ts",
    "src/tools/state-io.ts",
  ];

  it.each(newFiles)("%s exists", (f) => {
    expect(existsSync(join(ROOT, f))).toBe(true);
  });

  it("src/tools.ts is deleted (the flat file must not come back)", () => {
    expect(existsSync(join(ROOT, "src/tools.ts"))).toBe(false);
  });

  it("src/tools/ contains exactly the six pinned modules (no stray files)", () => {
    const entries = readdirSync(join(ROOT, "src/tools")).sort();
    expect(entries).toEqual([
      "dispute.ts",
      "index.ts",
      "negotiate.ts",
      "phase0.ts",
      "state-io.ts",
      "types.ts",
    ]);
  });
});

// ================================================================
// AC2 — public API re-exported from the barrel
// ================================================================

describe("AC2 — src/tools/index.ts re-exports the public API", () => {
  const barrel = read("src/tools/index.ts");

  it.each(["negotiatePropose", "negotiateReview", "isAgreeProposal"])(
    "re-exports %s",
    (name) => {
      // `export { ... } from "./x"` or `export * from "./x"` or `export { x }`.
      const named = new RegExp(`export\\s*\\{[\\s\\S]*?\\b${name}\\b[\\s\\S]*?}\\s*from`);
      const star = /export\s+\*\s+from\s+["']\.\/(negotiate|dispute|phase0|state-io|types)["']/.test(barrel);
      expect(named.test(barrel) || star).toBe(true);
    },
  );

  it("re-exports come from the sibling modules, not from a revived flat file", () => {
    expect(barrel).not.toMatch(/from\s+["']\.\.\/tools["']/);
  });
});

// ================================================================
// AC3 — module size: each tool module under 200 lines
// ================================================================

describe("AC3 — each src/tools/*.ts module is under 200 lines", () => {
  const modules = [
    "src/tools/index.ts",
    "src/tools/types.ts",
    "src/tools/negotiate.ts",
    "src/tools/dispute.ts",
    "src/tools/phase0.ts",
    "src/tools/state-io.ts",
  ];

  it.each(modules)("%s is under 200 lines (now %d)", (f) => {
    expect(lineCount(f)).toBeLessThan(200);
  });
});

// ================================================================
// AC4 — root index.ts import unchanged (directory module resolves it)
// ================================================================

describe("AC4 — root index.ts import line is unchanged", () => {
  it('imports * as Tool from "./src/tools"', () => {
    const entry = read("index.ts");
    expect(entry).toMatch(/import\s+\*\s+as\s+Tool\s+from\s+["']\.\/src\/tools["']/);
  });

  it("has exactly one tools import", () => {
    const entry = read("index.ts");
    const matches = entry.match(/from\s+["']\.\/src\/tools(\/[^"']*)?["']/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});

// ================================================================
// AC5 — no new dependencies introduced
// ================================================================

describe("AC5 — package.json has no new dependencies", () => {
  const pkg = JSON.parse(read("package.json"));

  it("peerDependencies is exactly the two pinned entries", () => {
    expect(Object.keys(pkg.peerDependencies ?? {}).sort()).toEqual([
      "@earendil-works/pi-coding-agent",
      "typebox",
    ]);
  });

  it("devDependencies is exactly the four pinned entries", () => {
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([
      "@types/node",
      "typebox",
      "typescript",
      "vitest",
    ]);
  });

  it("has no runtime dependencies block", () => {
    expect(pkg.dependencies).toBeUndefined();
  });
});

// ================================================================
// AC6 — zero functional references to the deleted flat file
// ================================================================

describe("AC6 — no functional references to src/tools.ts remain", () => {
  // Built at runtime: this test file must not contain the literal needle.
  const NEEDLE = ["src", "tools", ".ts"].join("/");

  it(`no .ts file under src/ or test/ nor index.ts references "${NEEDLE}"`, () => {
    expect(grepNeedle(NEEDLE)).toEqual([]);
  });

  it("no import-from the flat file in src/ or test/ (import-statement sweep)", () => {
    // Needle built at runtime: this file must not contain the literal path.
    const flatFile = ["src", "tools", ".ts"].join("/");
    const importRe = new RegExp(
      `import[^\n]*from\\s+["'](?:\\.\\/)+(?:tools[\\/])?${flatFile}["']`,
    );
    const hits = grepNeedle(flatFile).filter((f) => importRe.test(read(f)));
    expect(hits).toEqual([]);
  });
});

// ================================================================
// AC7 — no circular imports inside src/tools/
// ================================================================

describe("AC7 — no circular imports inside src/tools/", () => {
  function importsOf(rel: string): string[] {
    // Returns the set of sibling src/tools/*.ts files that rel imports.
    const src = read(rel);
    const out: string[] = [];
    const re = /from\s+["']\.\/([a-z0-9-]+)(\.ts)?["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[1] !== "index") out.push(`src/tools/${m[1]}.ts`);
    }
    return out;
  }

  const modules = [
    "src/tools/types.ts",
    "src/tools/state-io.ts",
    "src/tools/dispute.ts",
    "src/tools/phase0.ts",
    "src/tools/negotiate.ts",
  ];

  it.each(modules)("%s does not import itself", (f) => {
    expect(importsOf(f)).not.toContain(f);
  });

  it("the intra-module import graph is acyclic (DFS with a white/gray/black coloring)", () => {
    const graph = new Map<string, string[]>();
    for (const f of modules) graph.set(f, importsOf(f).filter((t) => modules.includes(t)));

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(modules.map((f) => [f, WHITE]));
    let cycle: string[] | null = null;

    function visit(node: string, path: string[]): void {
      color.set(node, GRAY);
      path.push(node);
      for (const target of graph.get(node) ?? []) {
        const c = color.get(target) ?? WHITE;
        if (c === GRAY) {
          cycle = [...path.slice(path.indexOf(target)), target] as string[];
          return;
        }
        if (c === WHITE) visit(target, path);
      }
      path.pop();
      color.set(node, BLACK);
    }

    for (const f of modules) {
      if (color.get(f) === WHITE) visit(f, []);
      if (cycle) break;
    }

    expect(cycle).toBeNull();
  });

  it("types.ts is a leaf among the tool modules (imports no sibling)", () => {
    expect(importsOf("src/tools/types.ts")).toEqual([]);
  });
});
