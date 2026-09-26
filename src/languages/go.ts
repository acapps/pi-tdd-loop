// --- Go language config ---

import type { LanguageConfig } from "./index";

// Toolchain commands only — style policy (naming, line limits) is not a role
// contract and must not be injected into prompts (no-style-policy-bloat).
const CONVENTIONS = `
Toolchain:
- Use go test -json ./... for test output
- Use go build ./... for compilation check
- Use go test -cover ./... for coverage
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

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests. Do not explore the codebase — the spec is your contract.

Write both *_test.go and *.go (tests) and Stubs (.go files with empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Be comprehensive enough to catch real bugs
- Fail against the stubs until the Writer implements them

When all tests are written, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests. Do not explore the codebase — the spec is your contract.

Write both *_test.go and *.go (tests) and Stubs (.go files with empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Be comprehensive enough to catch real bugs
- Fail against the stubs until the Writer implements them

When all tests are written, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${compileError}

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: (negotiateResolution: string, workspaceRoot?: string) =>
`Advancing to Phase B without explicit approval. Write Go source files.

${ws(workspaceRoot)}Negotiated resolution:
${negotiateResolution}

Read *_test.go and *.go stubs. Implement the source half of the resolution. Preserve stub signatures.
Do not modify *_test.go — test files are owned by the Tester. If the resolution requires test changes, implement the source half and report the test half as pending the Tester.
Do not claim the resolution is complete if the test half is outstanding.

${CONVENTIONS}

When the source half is done, stop producing tool calls.`,

    promptWriterPhaseB: (workspaceRoot?: string) =>
`Phase B (Writer). Write Go source files to pass all tests.

${ws(workspaceRoot)}Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.
Do not modify *_test.go — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

${CONVENTIONS}

When all tests pass, stop producing tool calls.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase B (Writer). Tests failed.

${ws(workspaceRoot)}Failure summary:
${failureSummary}

Do not modify *_test.go — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
When all tests pass, stop producing tool calls.`,

    promptCleanerPhaseC: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor Go source files for readability:

- Return early. Extract helpers. Clear names.
- Do not modify *_test.go — test files are owned by the Tester.
- All tests must pass.
${ws(workspaceRoot)}${CONVENTIONS}

When the refactor is complete and all tests pass, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase C (Cleaner). Tests failed after refactoring:

${ws(workspaceRoot)}Failure summary:
${failureSummary}

Fix the broken code by restoring working behavior. Do not modify *_test.go — test files are owned by the Tester.
When all tests pass, stop producing tool calls.`,

    promptCleanerRestart: (workspaceRoot?: string) =>
`Phase C (Cleaner). Restart. Refactor Go source files.

${ws(workspaceRoot)}Do not modify *_test.go. All tests must pass.
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
