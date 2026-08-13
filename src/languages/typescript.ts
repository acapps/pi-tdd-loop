// --- TypeScript language config ---

import type { LanguageConfig } from "./index";

const CONVENTIONS = `
TypeScript conventions:
- Use ${""}npx vitest run${""} for test output
- Use ${""}npx tsc --noEmit${""} for type checking
- Package exports use export keyword
- Function names use camelCase
`;

const config: LanguageConfig = {
  sourceFilePattern: "*.ts (non-test files)",
  testFilePattern: "*.test.ts",
  isTestFile: (path: string) => /\.test\.ts$/.test(path),
  isPhaseAAllowed: (path: string) => /\.test\.ts$/.test(path) || /\.ts$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string) =>
`Phase A (Tester). Write contract tests.

Read ${specPath}. Design the test contract that defines correct behavior.
Write both *.test.ts (tests) and stub .ts files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, undefined, null, single element
- Use describe/it blocks from Vitest
- Import assert functions and test utilities

When done, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string) =>
`Phase A (Tester). Rewrite contract tests.

Read ${specPath}. Rewrite from scratch.
When done, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${compileError}

When done, stop producing tool calls.`,

    promptNegotiateApproved: () =>
`Phase B approved. Write TypeScript source files to pass all tests.

Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Do not modify *.test.ts. Dispute wrong tests via negotiate_propose.

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: () =>
`Advancing to Phase B. Write TypeScript source files to pass all tests.

Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Do not modify *.test.ts. Dispute wrong tests via negotiate_propose.

When done, stop producing tool calls.`,

    promptWriterPhaseB: () =>
`Phase B (Writer). Write TypeScript source files to pass all tests.

Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Dispute wrong tests via negotiate_propose.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number) =>
`Phase B (Writer). Tests failed.

${failureSummary}

Do not modify *.test.ts. Dispute wrong tests via negotiate_propose.
When done, stop producing tool calls.`,

    promptCleanerPhaseC: () =>
`Phase C (Cleaner). Refactor TypeScript source files for readability:

- Return early. Extract helpers. Clear names.
- You may only write *.ts (non-test files). Do not modify *.test.ts.
- All tests must pass.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number) =>
`Phase C (Cleaner). Tests failed after refactoring:

${failureSummary}

Fix the broken tests by restoring working code. Do not modify *.test.ts.
When done, stop producing tool calls.`,

    promptCleanerRestart: () =>
`Phase C (Cleaner). Restart. Refactor TypeScript source files.

Do not modify *.test.ts. All tests must pass.
When done, stop producing tool calls.`,

    promptTesterDisputeFix: () =>
`Conceded dispute. Fix the test in *.test.ts to match the spec.
Do not modify non-test TypeScript files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "Phase A only: write test files and stubs. Cannot write other files.",
    negotiate: "Negotiation phase: discussion only. No file writes allowed.",
    phaseC: "Phase B/C: you may only write source files (non-test). Cannot modify test files.",
  },
};

export default config;
