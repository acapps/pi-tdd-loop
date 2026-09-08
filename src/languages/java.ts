// --- Java language config ---

import type { LanguageConfig } from "./index";

const CONVENTIONS = `
Java conventions:
- Use ${""}mvn test${""} for test output
- Use ${""}mvn compile${""} for compilation check
- Package names use lowercase with dots
- Class names use PascalCase
- Prefer AssertJ assertions over JUnit assert methods
- Use Records for data classes where applicable
- Keep methods under 50 lines
`;

function ws(workspaceRoot?: string): string {
  if (!workspaceRoot || workspaceRoot === ".") return "";
  return `Write all files under ${workspaceRoot}/. `;
}

const config: LanguageConfig = {
  key: "java",
  sourceFilePattern: "*.java (non-test files)",
  testFilePattern: "*Test.java",
  isTestFile: (path: string) => /\b\w+Test\.java$/.test(path),
  isPhaseAAllowed: (path: string) => /\b\w+Test\.java$/.test(path) || /\b\w+\.java$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string, buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. ${ws(workspaceRoot)}Design the test contract that defines correct behavior.
Write both *Test.java (tests) and stub .java files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: null, empty, single element, whitespace
- Use JUnit @ParameterizedTest or table-driven tests where applicable
- Use AssertJ assertions ( assertThat() )

Build tool: ${buildTool}. Config file: ${buildTool === "gradle" ? "build.gradle" : "pom.xml"}.
When done, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Read ${specPath}. ${ws(workspaceRoot)}Design the test contract that defines correct behavior.
Write both *Test.java (tests) and stub .java files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: null, empty, single element, whitespace
- Use JUnit @ParameterizedTest or table-driven tests where applicable
- Use AssertJ assertions ( assertThat() )

Build tool: ${buildTool}. Config file: ${buildTool === "gradle" ? "build.gradle" : "pom.xml"}.
When done, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${compileError}

When done, stop producing tool calls.`,

    promptNegotiateApproved: (workspaceRoot?: string) =>
`Phase B approved. Write Java source files to pass all tests.

${ws(workspaceRoot)}Read *Test.java and *.java stubs. Implement the logic. Preserve stub signatures.
Do not modify *Test.java. Dispute wrong tests via negotiate_propose.

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: (workspaceRoot?: string) =>
`Advancing to Phase B without explicit approval. Write Java source files.

${ws(workspaceRoot)}Read *Test.java and *.java stubs. Implement the logic. Preserve stub signatures.
Use AssertJ for any new assertions.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseB: (workspaceRoot?: string) =>
`Phase B (Writer). Write Java source files to pass all tests.

${ws(workspaceRoot)}Read *Test.java and *.java stubs. Implement the logic. Preserve stub signatures.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

${CONVENTIONS}

When done, stop producing tool calls.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase B (Writer). Tests failed.

${ws(workspaceRoot)}${failureSummary}

Do not modify *Test.java. Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
When done, stop producing tool calls.`,

    promptCleanerPhaseC: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor Java source files for readability:

- Return early. Extract helpers. Clear names.
- Keep methods under 50 lines
- Use Records for data classes where applicable
- You may only write *.java (non-test files). Do not modify *Test.java.
- All tests must pass.
${ws(workspaceRoot)}${CONVENTIONS}

When done, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase C (Cleaner). Tests failed after refactoring:

${ws(workspaceRoot)}${failureSummary}

Fix the broken tests by restoring working code. Do not modify *Test.java.
When done, stop producing tool calls.`,

    promptCleanerRestart: (workspaceRoot?: string) =>
`Phase C (Cleaner). Restart. Refactor Java source files.

${ws(workspaceRoot)}Do not modify *Test.java. All tests must pass.
When done, stop producing tool calls.`,

    promptTesterDisputeFix: (workspaceRoot?: string) =>
`Conceded dispute. Fix the test in *Test.java to match the spec.
${ws(workspaceRoot)}Do not modify non-test Java files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "Phase A only: write test files and stubs. Cannot write other files.",
    negotiate: "Negotiation is discussion-only. No file writes allowed.",
    phaseC: "Phase B/C: you may only write source files (non-test). Cannot modify test files.",
  },
};

export default config;
