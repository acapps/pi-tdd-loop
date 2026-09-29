// --- Java language config ---

import type { LanguageConfig } from "./index";
import { delimitUntrusted, UNTRUSTED_DATA_GUARD } from "../generic-prompts";

// Toolchain commands only — style policy (naming, line limits) is not a role
// contract and must not be injected into prompts (no-style-policy-bloat).
const CONVENTIONS = `
Toolchain:
- Use \`mvn test\` for test output
- Use \`mvn compile\` for compilation check
`;

function ws(workspaceRoot?: string): string {
  if (!workspaceRoot || workspaceRoot === ".") return "";
  return `Write all files under ${workspaceRoot}/.\n`;
}

const config: LanguageConfig = {
  key: "java",
  sourceFilePattern: "*.java (non-test files)",
  testFilePattern: "*Test.java",
  isTestFile: (path: string) => /\b\w+Test\.java$/.test(path),
  isPhaseAAllowed: (path: string) => /\b\w+Test\.java$/.test(path) || /\b\w+\.java$/.test(path) || /pom\.xml$/.test(path) || /build\.(gradle|gradle\.kts)$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string, buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests; the spec is your contract.

If the spec has no Test Strategy section, read the codebase, identify the test contract (which files to test, which behaviors to cover, which edge cases matter), and write a "## Test Strategy" section into the spec file. Then write the tests that section defines.

Write *Test.java files and empty stub .java files for the implementation.

Tests must:
- Cover all spec requirements
- Include edge cases: null, empty, single element, whitespace
- Use JUnit @ParameterizedTest or table-driven tests where applicable
- Use AssertJ assertions ( assertThat() )
- Fail against the stubs until the Writer implements them

Build tool: ${buildTool}. Config file: ${buildTool === "gradle" ? "build.gradle" : "pom.xml"}.
Run the tests once to confirm they fail because of missing behavior, not because of compile errors. When all tests are written, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests; the spec is your contract.

If the spec has no Test Strategy section, read the codebase, identify the test contract (which files to test, which behaviors to cover, which edge cases matter), and write a "## Test Strategy" section into the spec file. Then write the tests that section defines.

Write *Test.java files and empty stub .java files for the implementation.

Tests must:
- Cover all spec requirements
- Include edge cases: null, empty, single element, whitespace
- Use JUnit @ParameterizedTest or table-driven tests where applicable
- Use AssertJ assertions ( assertThat() )
- Fail against the stubs until the Writer implements them

Build tool: ${buildTool}. Config file: ${buildTool === "gradle" ? "build.gradle" : "pom.xml"}.
Run the tests once to confirm they fail because of missing behavior, not because of compile errors. When all tests are written, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${delimitUntrusted("COMPILE ERROR", compileError)}
${UNTRUSTED_DATA_GUARD}

When done, stop producing tool calls.`,

    promptNegotiateAutoAdvance: (negotiateResolution: string, workspaceRoot?: string) =>
`Advancing to Phase B without explicit approval. Write Java source files.

${ws(workspaceRoot)}Negotiated resolution:
${delimitUntrusted("NEGOTIATED RESOLUTION", negotiateResolution)}
${UNTRUSTED_DATA_GUARD}

Read *Test.java and *.java stubs. Implement the source half of the resolution. Preserve stub signatures.
Do not modify *Test.java — test files are owned by the Tester. If the resolution requires test changes, implement the source half and report the test half as pending the Tester.
Do not claim the resolution is complete if the test half is outstanding.

${CONVENTIONS}

When the source half is done, stop producing tool calls.`,

    promptWriterPhaseB: (workspaceRoot?: string) =>
`Phase B (Writer). Write Java source files to pass all tests.

${ws(workspaceRoot)}Read *Test.java and *.java stubs. Implement the logic. Preserve stub signatures.
Do not modify *Test.java — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

${CONVENTIONS}

Stop producing tool calls when all tests pass, or when every remaining failure is a test you have disputed via negotiate_propose.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase B (Writer). Tests failed.

${ws(workspaceRoot)}Failure summary:
${delimitUntrusted("TEST OUTPUT", failureSummary)}
${UNTRUSTED_DATA_GUARD}

Do not modify *Test.java — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
Stop producing tool calls when all tests pass, or when every remaining failure is a test you have disputed via negotiate_propose.`,

    promptCleanerPhaseC: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor the Java source files for readability without changing behavior.

${ws(workspaceRoot)}Do not modify *Test.java; test files are owned by the Tester.
All tests must still pass.

${CONVENTIONS}

When the refactor is complete and all tests pass, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase C (Cleaner). Tests failed after refactoring:

${ws(workspaceRoot)}Failure summary:
${delimitUntrusted("TEST OUTPUT", failureSummary)}
${UNTRUSTED_DATA_GUARD}

Fix the broken code by restoring working behavior. Do not modify *Test.java — test files are owned by the Tester.
When all tests pass, stop producing tool calls.`,

    promptCleanerRestart: (workspaceRoot?: string) =>
`Phase C (Cleaner). Restart. Refactor Java source files.

${ws(workspaceRoot)}Do not modify *Test.java. All tests must pass.
When done, stop producing tool calls.`,

    promptTesterDisputeFix: (workspaceRoot?: string, claim?: string, specPath?: string) =>
`Conceded dispute. Fix the test in *Test.java to match the spec.
${specPath ? `Spec: ${specPath}\n` : ""}${claim ? delimitUntrusted(claim, "DISPUTE CLAIM") + "\n" : ""}${ws(workspaceRoot)}Do not modify non-test Java files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "Phase A only: write test files, stubs, and project config (pom.xml, build.gradle). Cannot write source files.",
    negotiate: "Negotiation is discussion-only. No file writes allowed.",
    phaseC: "Phase B/C: you may only write source files (non-test). Cannot modify test files.",
  },
};

export default config;
