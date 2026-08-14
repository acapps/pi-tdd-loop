# Golden Project Workspace Fix

## Overview

The gates and tool enforcement operate against `ctx.cwd` (the extension directory). The golden project is at `test/golden/golden-project/`. The Writer creates files in the extension directory because prompts never specify where to write, and tool enforcement allows any path within cwd.

**Root cause:** The extension doesn't distinguish between "extension files" and "project files." Everything is within `cwd`.

**Fix:** Derive workspace root from `specPath` and enforce it everywhere.

## Changes

### 1. Add `getWorkspaceRoot` and mode detection

```typescript
// src/types.ts

// Detects whether the loop is working on a golden project or a self-refactor.
// Golden project specs are under test/golden/. Self-refactor specs are under specs/.
export function isGoldenProject(specPath: string): boolean {
  return specPath.startsWith("test/golden/");
}

// For golden projects: returns the project directory (parent of spec.md).
// For self-refactors: returns "." (cwd, no constraint).
export function getWorkspaceRoot(specPath: string): string {
  if (!isGoldenProject(specPath)) return "."; // self-refactor: no constraint
  const parts = specPath.split("/");
  parts.pop(); // remove "spec.md"
  return parts.join("/");
}
```

### 2. Mode-aware tool enforcement

```typescript
// src/events.ts — eventToolCall handler
const workspaceRoot = getWorkspaceRoot(state.current.specPath);

// Golden project mode: constrain writes to workspace
// Self-refactor mode: allow writes anywhere
if (isGoldenProject(state.current.specPath)) {
  if (!isWorkspacePath(path, workspaceRoot)) {
    debug(`Blocked: ${evt.toolName} ${path} (outside workspace ${workspaceRoot})`);
    return { block: true, reason: `Write blocked: outside project workspace (${workspaceRoot})` };
  }
}

// Existing phase-specific checks continue...
```

### 3. Mode-aware gate execution

```typescript
// src/events.ts — handleGateTransition
const workspaceRoot = getWorkspaceRoot(state.current.specPath);
const gateCwd = workspaceRoot === "." ? ctx.cwd : path.join(ctx.cwd, workspaceRoot);
const gateResult = runGates(
  gateCwd,  // golden: workspace root; self-refactor: cwd
  state.current.coverageThreshold,
  state.current.language,
  state.current.buildTool,
  state.current.phase,
);
```

### 4. Mode-aware prompts

Golden project prompts inject the workspace path. Self-refactor prompts use existing behavior (cwd):
```typescript
promptTesterPhaseA: (specPath: string, buildTool: string, workspaceRoot: string) => {
  const workspaceHint = workspaceRoot === "."
    ? ""
    : `Write all files under ${workspaceRoot}/. `;
  return `You are the TESTER. Write contract tests.

Read ${specPath}. ${workspaceHint}...
`;
}

## Acceptance Criteria

- [ ] `isGoldenProject(specPath)` correctly detects `test/golden/` prefix
- [ ] `getWorkspaceRoot` returns correct directory for golden project, "." for self-refactor
- [ ] Tool enforcement blocks writes outside workspace ONLY in golden project mode
- [ ] Tool enforcement allows writes anywhere in self-refactor mode
- [ ] Gates run in workspace root for golden project, cwd for self-refactor
- [ ] Prompts include workspace hint for golden project, existing behavior for self-refactor
- [ ] All existing tests pass

## Test Strategy

```typescript
describe("isGoldenProject", () => {
  it("detects golden project spec", () => {
    expect(isGoldenProject("test/golden/golden-project/spec.md")).toBe(true);
  });

  it("rejects self-refactor spec", () => {
    expect(isGoldenProject("specs/events-architectural-cleanup.md")).toBe(false);
  });
});

describe("getWorkspaceRoot", () => {
  it("derives directory for golden project", () => {
    expect(getWorkspaceRoot("test/golden/golden-project/spec.md"))
      .toBe("test/golden/golden-project");
  });

  it("returns dot for self-refactor", () => {
    expect(getWorkspaceRoot("specs/events-architectural-cleanup.md")).toBe(".");
  });
});

describe("tool call enforcement", () => {
  it("golden mode: allows writes inside workspace", () => {
    expect(isWorkspacePath("test/golden/golden-project/stringutil.go", "test/golden/golden-project"))
      .toBe(true);
  });

  it("golden mode: blocks writes outside workspace", () => {
    expect(isWorkspacePath("src/gates.ts", "test/golden/golden-project")).toBe(false);
  });

  it("golden mode: blocks writes to extension test directory", () => {
    expect(isWorkspacePath("test/make-state-helper.test.ts", "test/golden/golden-project"))
      .toBe(false);
  });

  it("self-refactor mode: allows writes anywhere", () => {
    // No constraint when workspaceRoot is "."
    expect(true).toBe(true); // constraint is skipped
  });
});
```

## Migration

1. Add `isGoldenProject` and `getWorkspaceRoot` helpers to `src/types.ts`
2. Add `isWorkspacePath` helper to `src/events.ts`
3. Update `eventToolCall` handler to check mode before existing checks
4. Update `handleGateTransition` to compute gateCwd from mode
5. Update language prompts to accept optional workspaceRoot parameter
6. Add tests for mode detection and workspace constraints
