# Golden Project Workspace Fix

## Overview

The gates and tool enforcement operate against `ctx.cwd` (the extension directory). The golden project is at `test/golden/golden-project/`. The Writer creates files in the extension directory because prompts never specify where to write, and tool enforcement allows any path within cwd.

**Root cause:** The extension doesn't distinguish between "extension files" and "project files." Everything is within `cwd`.

**Fix:** Derive workspace root from `specPath` and enforce it everywhere.

## Changes

### 1. Add `getWorkspaceRoot` helper

```typescript
// src/types.ts
export function getWorkspaceRoot(specPath: string): string {
  // specPath is typically "test/golden/golden-project/spec.md"
  // workspace root is "test/golden/golden-project"
  const parts = specPath.split("/");
  parts.pop(); // remove "spec.md"
  return parts.join("/");
}
```

### 2. Inject workspace root into all prompts

Every language prompt function gets `workspaceRoot` as a parameter:

```typescript
// src/languages/go.ts
promptTesterPhaseA: (specPath: string, buildTool: string, workspaceRoot: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. Design the test contract that defines correct behavior.
Write all files under ${workspaceRoot}/:
  - ${workspaceRoot}/stringutil.go (stubs)
  - ${workspaceRoot}/stringutil_test.go (tests)
  - ${workspaceRoot}/go.mod (module declaration)

Tests must: ...
`,

promptNegotiateApproved: (workspaceRoot: string) =>
`Phase B approved. Write Go source files to pass all tests.

Read ${workspaceRoot}/*_test.go and ${workspaceRoot}/*.go stubs.
Implement the logic in ${workspaceRoot}/stringutil.go.
Do not modify *_test.go.
`,
```

### 3. Constrain tool enforcement to workspace root

```typescript
// src/events.ts — new function
function isWorkspacePath(path: string, workspaceRoot: string): boolean {
  const full = path.startsWith("/") ? path : path;
  return full.startsWith(workspaceRoot + "/") || full === workspaceRoot;
}

// In eventToolCall handler — before existing checks:
if (!isWorkspacePath(path, getWorkspaceRoot(state.current.specPath))) {
  debug(`Blocked: ${evt.toolName} ${path} (outside workspace ${workspaceRoot})`);
  return { block: true, reason: `Write blocked: outside project workspace (${workspaceRoot})` };
}
```

### 4. Run gates against workspace root

```typescript
// src/events.ts — handleGateTransition
const workspaceRoot = getWorkspaceRoot(state.current.specPath);
const gateResult = runGates(
  workspaceRoot,  // was ctx.cwd
  state.current.coverageThreshold,
  state.current.language,
  state.current.buildTool,
  state.current.phase,
);
```

## Acceptance Criteria

- [ ] `getWorkspaceRoot(specPath)` derives correct directory for `test/golden/golden-project/spec.md` → `test/golden/golden-project`
- [ ] All language prompts include explicit workspace path
- [ ] Tool enforcement blocks writes outside workspace root
- [ ] Gates run in workspace root, not extension directory
- [ ] All existing tests pass

## Test Strategy

```typescript
describe("getWorkspaceRoot", () => {
  it("derives directory from spec path", () => {
    expect(getWorkspaceRoot("test/golden/golden-project/spec.md")).toBe("test/golden/golden-project");
  });

  it("handles relative path", () => {
    expect(getWorkspaceRoot("./spec.md")).toBe(".");
  });
});

describe("tool call enforcement — workspace constraint", () => {
  it("allows writes inside workspace", () => {
    expect(isWorkspacePath("test/golden/golden-project/stringutil.go", "test/golden/golden-project")).toBe(true);
  });

  it("blocks writes outside workspace", () => {
    expect(isWorkspacePath("src/gates.ts", "test/golden/golden-project")).toBe(false);
  });

  it("blocks writes to extension test directory", () => {
    expect(isWorkspacePath("test/make-state-helper.test.ts", "test/golden/golden-project")).toBe(false);
  });
});
```

## Risks

- **Breaking existing golden runs**: Current golden project files (if any) are in the extension directory. They'd need to be moved to the workspace root.
- **Spec paths**: All spec paths must be relative to cwd. Absolute paths would need special handling.
- **Prompts**: Existing prompts don't pass workspace root. Need to update all language configs (Go, Java, TypeScript).

## Migration

1. Add `getWorkspaceRoot` helper
2. Update tool enforcement to block writes outside workspace
3. Update all language prompts to include workspace path
4. Update gate execution to use workspace root
5. Move any existing golden project files from extension root to workspace root
