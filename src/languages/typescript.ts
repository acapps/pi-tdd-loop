// --- TypeScript language config ---

import type { LanguageConfig } from "./index";

// Toolchain commands only — style policy (naming, line limits) is not a role
// contract and must not be injected into prompts (no-style-policy-bloat).
const CONVENTIONS = `
Toolchain:
- Use \`npx vitest run\` for test output
- Use \`npx tsc --noEmit\` for type checking
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

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests. Do not explore the codebase — the spec is your contract.

If the spec has no Test Strategy section: read the codebase, identify the test contract (which files to test, which behaviors to cover, which edge cases matter), and write a "## Test Strategy" section into the spec file. Then write the tests defined by that section.

Write both *.test.ts and *.ts (tests) and stub .ts files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, undefined, null, single element
- Use describe/it blocks from Vitest
- Import assert functions and test utilities
- Check package.json for dependencies
- Fail against the stubs until the Writer implements them

When all tests are written, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests. Do not explore the codebase — the spec is your contract.

If the spec has no Test Strategy section: read the codebase, identify the test contract (which files to test, which behaviors to cover, which edge cases matter), and write a "## Test Strategy" section into the spec file. Then write the tests defined by that section.

Write both *.test.ts and *.ts (tests) and stub .ts files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, undefined, null, single element
- Use describe/it blocks from Vitest
- Import assert functions and test utilities
- Check package.json for dependencies
- Fail against the stubs until the Writer implements them

When all tests are written, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${compileError}

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: (negotiateResolution: string, workspaceRoot?: string) =>
`Advancing to Phase B without explicit approval. Write TypeScript source files.

${ws(workspaceRoot)}Negotiated resolution:
${negotiateResolution}

Read *.test.ts and *.ts stubs. Implement the source half of the resolution. Preserve stub signatures.
Do not modify *.test.ts — test files are owned by the Tester. If the resolution requires test changes, implement the source half and report the test half as pending the Tester.
Do not claim the resolution is complete if the test half is outstanding.

${CONVENTIONS}

When the source half is done, stop producing tool calls.`,

    promptWriterPhaseB: (workspaceRoot?: string) =>
`Phase B (Writer). Write TypeScript source files to pass all tests.

${ws(workspaceRoot)}Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Do not modify *.test.ts — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

${CONVENTIONS}

When all tests pass, stop producing tool calls.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase B (Writer). Tests failed.

${ws(workspaceRoot)}Failure summary:
${failureSummary}

Do not modify *.test.ts — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
When all tests pass, stop producing tool calls.`,

    promptCleanerPhaseC: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor TypeScript source files for readability:

- Return early. Extract helpers. Clear names.
- Do not modify *.test.ts — test files are owned by the Tester.
- All tests must pass.
${ws(workspaceRoot)}${CONVENTIONS}

When the refactor is complete and all tests pass, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase C (Cleaner). Tests failed after refactoring:

${ws(workspaceRoot)}Failure summary:
${failureSummary}

Fix the broken code by restoring working behavior. Do not modify *.test.ts — test files are owned by the Tester.
When all tests pass, stop producing tool calls.`,

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
