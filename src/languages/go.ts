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

const config: LanguageConfig = {
  key: "go",
  sourceFilePattern: "*.go (non-test files)",
  testFilePattern: "*_test.go",
  isTestFile: (path: string) => /\b\w+_test\.go$/.test(path),
  isPhaseAAllowed: (path: string) => /\b\w+_test\.go$/.test(path) || /\b\w+\.go$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string, _buildTool: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. Design the test contract that defines correct behavior.
Write both *_test.go and *.go (tests) and Stubs (.go files with empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Be comprehensive enough to catch real bugs

When done, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, _buildTool: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. Design the test contract that defines correct behavior.
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

    promptNegotiateApproved: () =>
`Phase B approved. Write Go source files to pass all tests.

Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.
Do not modify *_test.go. Dispute wrong tests via negotiate_propose.

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: () =>
`Advancing to Phase B without explicit approval. Write Go source files.

Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseB: () =>
`Phase B (Writer). Write Go source files to pass all tests.

Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.
Dispute wrong tests via negotiate_propose.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number) =>
`Phase B (Writer). Tests failed.

${failureSummary}

Do not modify *_test.go. Dispute wrong tests via negotiate_propose.
When done, stop producing tool calls.`,

    promptCleanerPhaseC: () =>
`Phase C (Cleaner). Refactor Go source files for readability:

- Return early. Extract helpers. Clear names.
- No method over 200 lines
- You may only write *.go (non-test files). Do not modify *_test.go.
- All tests must pass.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number) =>
`Phase C (Cleaner). Refactoring broke ${failureCount} test. Fix the broken code:

${failureSummary}

Do not modify *_test.go. All tests must pass.
When done, stop producing tool calls.`,

    promptCleanerRestart: () =>
`Phase C (Cleaner). Refactor Go source files for readability:

- Return early. Extract helpers. Clear names.
- No method over 200 lines
- You may only write *.go (non-test files). Do not modify *_test.go.
- All tests must pass.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptTesterDisputeFix: () =>
`Conceded dispute. Fix the test in *_test.go to match the spec.
Do not modify non-test Go files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "Phase A only: write test files and stubs. Cannot write other files.",
    negotiate: "Negotiation is discussion-only. No file writes allowed.",
    phaseC: "Phase B/C: you may only write source files (*.go). Cannot modify *_test.go.",
  },
};

export default config;
