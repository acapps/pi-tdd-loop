// Contract tests for src/commands/index.ts — internal/refactor-commands-split.md
//
// Acceptance Criteria 1: every cmd* is re-exported from src/commands/index.ts
// so `import { cmdLoop } from "./src/commands"` keeps working unchanged
// (directory import resolves to src/commands/index.ts).
//
// Fast + hermetic: the barrel's leaf dependencies (commit, prompt, ...
// node:child_process via gates/baseline) are mocked at file level so
// importing the barrel spawns nothing.

import { describe, it, expect, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, "", "");
  }),
  spawn: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, "", "");
    return { on: () => {}, kill: () => {} };
  }),
}));
vi.mock("../../src/commit", () => ({ commit: vi.fn() }));
vi.mock("../../src/prompt", () => ({ sendPrompt: vi.fn() }));
vi.mock("../../src/phase-a", () => ({ startPhaseA: vi.fn() }));
vi.mock("../../src/baseline", () => ({ runBaseline: vi.fn(), formatBaselineFailure: vi.fn() }));
vi.mock("../../src/reviewer", () => ({
  readSpec: vi.fn(), analyzeSpec: vi.fn(), buildSummaryTable: vi.fn(), formatFinding: vi.fn(),
}));
vi.mock("../../src/git-workflow", () => ({ setupBranch: vi.fn() }));
vi.mock("../../src/languages", () => ({ getLanguageConfig: vi.fn(), detectProject: vi.fn() }));
vi.mock("../../src/generic-prompts", () => ({
  promptWriterNegotiate: vi.fn(), promptNegotiateRepromptTester: vi.fn(),
}));
vi.mock("../../src/bug-spec", () => ({
  slugBugName: vi.fn(), extractLoopLogs: vi.fn(), renderBugSpec: vi.fn(), writeBugSpec: vi.fn(),
}));
vi.mock("../../src/spec-path", () => ({ resolveExistingSpec: vi.fn() }));
vi.mock("../../src/selectors", () => ({
  parseLoopArgs: vi.fn(), loadLoopConfig: vi.fn(), mergeLoopArgs: vi.fn(),
  normalizeSpecPath: vi.fn((p: string) => p), formatStatus: vi.fn(),
}));
vi.mock("../../src/state-helpers", () => ({
  resetPhaseState: vi.fn(), isIdleOrDone: vi.fn(), resolvePhaseArg: vi.fn(),
}));

// The barrel MUST be importable as "../../src/commands" (directory import) —
// this is exactly what src/index.ts does.
import * as Commands from "../../src/commands";

// The 10 command handlers — the public API surface of the old src/commands.ts
// (Inventory, internal/refactor-commands-split.md).
const CMD_EXPORTS = [
  "cmdLoop",
  "cmdStatus",
  "cmdContinue",
  "cmdRestart",
  "cmdDebug",
  "cmdCancel",
  "cmdApprove",
  "cmdStop",
  "cmdPatch",
  "cmdDecompose",
] as const;

describe("src/commands/index.ts — barrel contract", () => {
  it("re-exports all 10 cmd* handlers as functions", () => {
    for (const name of CMD_EXPORTS) {
      expect(Commands, `missing re-export: ${name}`).toHaveProperty(name);
      expect(typeof (Commands as Record<string, unknown>)[name], `${name} is not a function`).toBe("function");
    }
  });

  it("exports exactly the 10 cmd* handlers (no leftover, no extras)", () => {
    const exported = Object.keys(Commands).sort();
    expect(exported).toEqual([...CMD_EXPORTS].sort());
  });
});
