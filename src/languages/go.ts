// --- Go language config ---

import type { LanguageConfig } from "./index";

const CONVENTIONS = `
Go conventions:
- Use go test -json ./... for test output
- Use go build ./... for compilation check
- Use go test -cover ./... for coverage
- Package name matches directory
- Exported names use PascalCase
`;

const config: LanguageConfig = {
  sourceFilePattern: "*.go (non-test files)",
  testFilePattern: "*_test.go",
  isTestFile: (path: string) => /\b\w+_test\.go$/.test(path),
  isPhaseAAllowed: (path: string) => /\b\w+_test\.go$/.test(path) || /\b\w+\.go$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string, _buildTool: string) =>
`Phase A (Tester). Write contract tests.

Read ${specPath}. Design the test contract that defines correct behavior.
Write both ${""}*_${"test.go"} (tests) and stub .go files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Be comprehensive enough to catch real bugs

When done, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, _buildTool: string) =>
`Phase A (Tester). Rewrite contract tests.

Read ${specPath}. The tests are inadequate. Rewrite them from scratch.
Write both *_test.go and stub .go files.

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
`Advancing to Phase B. Write Go source files to pass all tests.

Read *_test.go and *.go stubs. Implement the logic. Preserve stub signatures.
Do not modify *_test.go. Dispute wrong tests via negotiate_propose.

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
- You may only write *.go (non-test files). Do not modify *_test.go.
- All tests must pass.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number) =>
`Phase C (Cleaner). Tests failed after refactoring:

${failureSummary}

Fix the broken tests by restoring working code. Do not modify *_test.go.
When done, stop producing tool calls.`,

    promptCleanerRestart: () =>
`Phase C (Cleaner). Restart. Refactor Go source files for readability.

Do not modify *_test.go. All tests must pass.
When done, stop producing tool calls.`,

    promptTesterDisputeFix: () =>
`Conceded dispute. Fix the test in *_test.go to match the spec.
Do not modify non-test Go files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "Phase A only: write test files and stubs. Cannot write other files.",
    negotiate: "Negotiation phase: discussion only. No file writes allowed.",
    phaseC: "Phase B/C: you may only write source files (non-test). Cannot modify test files.",
  },
};

export default config;
