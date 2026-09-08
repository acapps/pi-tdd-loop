// --- TypeScript language config ---

import type { LanguageConfig } from "./index";

const CONVENTIONS = `
TypeScript conventions:
- Use ${""}npx vitest run${""} for test output
- Use ${""}npx tsc --noEmit${""} for type checking
- Package exports use export keyword
- Function names use camelCase
- Prefer strict types (no any), use const declarations
- Keep functions under 30 lines
`;

function ws(workspaceRoot?: string): string {
  if (!workspaceRoot || workspaceRoot === ".") return "";
  return `Write all files under ${workspaceRoot}/. `;
}

const config: LanguageConfig = {
  key: "typescript",
  sourceFilePattern: "*.ts (non-test files)",
  testFilePattern: "*.test.ts",
  isTestFile: (path: string) => /\.test\.ts$/.test(path) || /\.spec\.ts$/.test(path),
  isPhaseAAllowed: (path: string) => /\.test\.ts$/.test(path) || /\.spec\.ts$/.test(path) || /\.ts$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. ${ws(workspaceRoot)}Design the test contract that defines correct behavior.
Write both *.test.ts and *.ts (tests) and stub .ts files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, undefined, null, single element
- Use describe/it blocks from Vitest
- Import assert functions and test utilities
- Check package.json for dependencies

When done, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. ${ws(workspaceRoot)}Design the test contract that defines correct behavior.
Write both *.test.ts and *.ts (tests) and stub .ts files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, undefined, null, single element
- Use describe/it blocks from Vitest
- Import assert functions and test utilities
- Check package.json for dependencies

When done, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${compileError}

When done, stop producing tool calls.`,

    promptNegotiateApproved: (workspaceRoot?: string) =>
`Phase B approved. Write TypeScript source files to pass all tests.

${ws(workspaceRoot)}Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Do not modify *.test.ts. Dispute wrong tests via negotiate_propose.

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: (workspaceRoot?: string) =>
`Advancing to Phase B without explicit approval. Write TypeScript source files.

${ws(workspaceRoot)}Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Use Strict types (no any).

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseB: (workspaceRoot?: string) =>
`Phase B (Writer). Write TypeScript source files to pass all tests.

${ws(workspaceRoot)}Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase B (Writer). Tests failed.

${ws(workspaceRoot)}${failureSummary}

Do not modify *.test.ts. Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
When done, stop producing tool calls.`,

    promptCleanerPhaseC: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor TypeScript source files for readability:

- Return early. Extract helpers. Clear names.
- Keep functions under 30 lines, prefer const declarations
- You may only write *.ts (non-test files). Do not modify *.test.ts.
- All tests must pass.
${ws(workspaceRoot)}${CONVENTIONS}

When done, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase C (Cleaner). Tests failed after refactoring:

${ws(workspaceRoot)}${failureSummary}

Fix the broken tests by restoring working code. Do not modify *.test.ts.
When done, stop producing tool calls.`,

    promptCleanerRestart: (workspaceRoot?: string) =>
`Phase C (Cleaner). Restart. Refactor TypeScript source files.

${ws(workspaceRoot)}Do not modify *.test.ts. All tests must pass.
When done, stop producing tool calls.`,

    promptTesterDisputeFix: (workspaceRoot?: string) =>
`Conceded dispute. Fix the test in *.test.ts to match the spec.
${ws(workspaceRoot)}Do not modify non-test TypeScript files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "Phase A only: write test files and stubs. Cannot write other files.",
    negotiate: "Negotiation is discussion-only. No file writes allowed.",
    phaseC: "Phase B/C: you may only write source files (non-test). Cannot modify test files.",
  },
};

export default config;
