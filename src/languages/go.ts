// --- Go language config ---

import type { LanguageConfig } from "./index";

const CONVENTIONS = `
Go conventions:
- Use go test -json ./... for test output
- Use go build ./... for compilation check
- Use go test -cover ./... for coverage
- Package name matches directory
- Exported names use PascalCase
- Error handling without explicit error types, prefer errors.Is and errors.As
`;

// Golden project workspace hint (spec: golden-workspace-fix.md).
// When workspaceRoot is provided (golden project mode), prompts include a
// hint telling the agent to write files under that directory.
// Self-refactor mode (workspaceRoot === "." or undefined) adds no hint.
function ws(workspaceRoot?: string): string {
  if (!workspaceRoot || workspaceRoot === ".") return "";
  return `Write all files under ${workspaceRoot}/. `;
}

const config: LanguageConfig = {
  key: "go",
  sourceFilePattern: "*.go (non-test files)",
  testFilePattern: "*_test.go",
  isTestFile: (path: string) => /\b\w+_test\.go$/.test(path),
  isPhaseAAllowed: (path: string) => /\b\w+_test\.go$/.test(path) || /\b\w+\.go$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. ${ws(workspaceRoot)}Design the test contract that defines correct behavior.
Write both *_test.go and *.go (tests) and Stubs (.go files with empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Be comprehensive enough to catch real bugs

When done, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. ${ws(workspaceRoot)}Design the test contract that defines correct behavior.
Write both *_test.go and *.go (tests) and Stubs (.go files with empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Be comprehensive enough to catch real bugs

When done, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${compileError}

When done, stop producing tool calls.`,

    promptNegotiateApproved: (workspaceRoot?: string) =>
`Phase B approved. Write Go source files to pass all tests.

${ws(workspaceRoot)}Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.
Do not modify *_test.go. Dispute wrong tests via negotiate_propose.

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: (workspaceRoot?: string) =>
`Advancing to Phase B without explicit approval. Write Go source files.

${ws(workspaceRoot)}Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseB: (workspaceRoot?: string) =>
`Phase B (Writer). Write Go source files to pass all tests.

${ws(workspaceRoot)}Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase B (Writer). Tests failed.

${ws(workspaceRoot)}${failureSummary}

Do not modify *_test.go. Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
When done, stop producing tool calls.`,

    promptCleanerPhaseC: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor Go source files for readability:

- Return early. Extract helpers. Clear names.
- No method over 200 lines
- You may only write *.go (non-test files). Do not modify *_test.go.
- All tests must pass.
${ws(workspaceRoot)}${CONVENTIONS}

When done, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase C (Cleaner). Refactoring broke ${failureCount} test. Fix the broken code:

${ws(workspaceRoot)}${failureSummary}

Do not modify *_test.go. All tests must pass.
When done, stop producing tool calls.`,

    promptCleanerRestart: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor Go source files for readability:

- Return early. Extract helpers. Clear names.
- No method over 200 lines
- You may only write *.go (non-test files). Do not modify *_test.go.
- All tests must pass.
${ws(workspaceRoot)}${CONVENTIONS}

When done, stop producing tool calls.`,

    promptTesterDisputeFix: (workspaceRoot?: string) =>
`Conceded dispute. Fix the test in *_test.go to match the spec.
${ws(workspaceRoot)}Do not modify non-test Go files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "Phase A only: write test files and stubs. Cannot write other files.",
    negotiate: "Negotiation is discussion-only. No file writes allowed.",
    phaseC: "Phase B/C: you may only write source files (*.go). Cannot modify *_test.go.",
  },
};

export default config;
