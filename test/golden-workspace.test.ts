// Regression: golden-workspace-fix
// Golden project: writes restricted to workspace root, gates run in workspace.
// Self-refactor: no constraint (workspace = cwd).

import { describe, it, expect } from "vitest";
import { isGoldenProject, getWorkspaceRoot, isWorkspacePath } from "../src/types";
import { handleToolCall } from "../src/events/tool-call";
import type { LoopState, Phase } from "../src/types";

// --- Unit tests: isGoldenProject / getWorkspaceRoot / isWorkspacePath ---

describe("isGoldenProject", () => {
  it("returns true for test/golden/ prefix", () => {
    expect(isGoldenProject("test/golden/golden-project/spec.md")).toBe(true);
    expect(isGoldenProject("test/golden/other/spec.md")).toBe(true);
  });

  it("returns false for internal/ prefix (self-refactor)", () => {
    expect(isGoldenProject("internal/bug-foo.md")).toBe(false);
  });

  it("returns false for bare spec paths", () => {
    expect(isGoldenProject("spec.md")).toBe(false);
    expect(isGoldenProject("docs/spec.md")).toBe(false);
  });
});

describe("getWorkspaceRoot", () => {
  it("returns project dir for golden project", () => {
    expect(getWorkspaceRoot("test/golden/golden-project/spec.md")).toBe("test/golden/golden-project");
  });

  it("returns '.' for self-refactor", () => {
    expect(getWorkspaceRoot("internal/bug-foo.md")).toBe(".");
    expect(getWorkspaceRoot("spec.md")).toBe(".");
  });
});

describe("isWorkspacePath", () => {
  it("returns true for self-refactor (workspace = '.')", () => {
    expect(isWorkspacePath("src/foo.ts", ".")).toBe(true);
    expect(isWorkspacePath("test/bar.ts", ".")).toBe(true);
  });

  it("returns true for paths within workspace", () => {
    const ws = "test/golden/golden-project";
    expect(isWorkspacePath(`${ws}/stringutil.go`, ws)).toBe(true);
    expect(isWorkspacePath(`${ws}/sub/dir/file.go`, ws)).toBe(true);
  });

  it("returns false for paths outside workspace", () => {
    const ws = "test/golden/golden-project";
    expect(isWorkspacePath("src/types.ts", ws)).toBe(false);
    expect(isWorkspacePath("test/golden/other/project.go", ws)).toBe(false);
    expect(isWorkspacePath("index.ts", ws)).toBe(false);
  });
});

// --- Integration tests: tool enforcement in golden mode ---

function makeGoldenState(overrides = {}): LoopState {
  return {
    phase: "A" as Phase,
    round: 1,
    turnsThisPhase: 1,
    specPath: "test/golden/golden-project/spec.md",
    language: "go",
    buildTool: "go",
    maxA: 5,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 10,
    coverageThreshold: 80,
    disputeCount: 0,
    dispute: { status: "none" },
    lastGateResult: undefined,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides,
  };
}

function makeCwd() {
  return "/home/user/project";
}

function makeWriteInput(state: LoopState, path: string) {
  return {
    state: { current: state },
    pi: {} as any,
    debug: () => {},
    toolName: "write",
    path,
    ctx: { cwd: makeCwd() } as any,
  };
}

describe("tool enforcement: golden project mode", () => {
  it("blocks write outside workspace (src/types.ts)", () => {
    const state = makeGoldenState();
    const result = handleToolCall(makeWriteInput(state, "src/types.ts"));
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("outside project workspace");
  });

  it("blocks write to another golden project", () => {
    const state = makeGoldenState();
    const result = handleToolCall(makeWriteInput(state, "test/golden/other-project/foo.go"));
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it("allows write within workspace", () => {
    const state = makeGoldenState({ phase: "B" });
    const result = handleToolCall(makeWriteInput(state, "test/golden/golden-project/stringutil.go"));
    expect(result).toBeUndefined();
  });

  it("allows write within workspace (test file in Phase A)", () => {
    const state = makeGoldenState({ phase: "A" });
    const result = handleToolCall(makeWriteInput(state, "test/golden/golden-project/stringutil_test.go"));
    expect(result).toBeUndefined();
  });

  it("blocks write to index.ts (extension root)", () => {
    const state = makeGoldenState();
    const result = handleToolCall(makeWriteInput(state, "index.ts"));
    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });
});

describe("tool enforcement: self-refactor mode (no constraint)", () => {
  function makeSelfRefactorState(overrides = {}): LoopState {
    return {
      phase: "A" as Phase,
      round: 1,
      turnsThisPhase: 1,
      specPath: "internal/bug-foo.md",
      language: "go",
      buildTool: "go",
      maxA: 5,
      maxNegotiate: 3,
      maxB: 5,
      maxC: 3,
      maxDispute: 3,
      maxTurnsPerPhase: 10,
      coverageThreshold: 80,
      disputeCount: 0,
      dispute: { status: "none" },
      lastGateResult: undefined,
      lastProposal: "",
      lastPhase: "A",
      justTransitioned: false,
      negotiateReprompted: false,
      ...overrides,
    };
  }

  it("does not block writes with workspace reason in any phase", () => {
    const state = makeSelfRefactorState({ phase: "B" });
    const result = handleToolCall(makeWriteInput(state, "random/path/file.ts"));
    if (result) {
      expect(result.reason).not.toContain("outside project workspace");
    }
  });
});
