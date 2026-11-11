// --- Go language config ---

import type { LanguageConfig } from "./index";
import { delimitUntrusted, UNTRUSTED_DATA_GUARD } from "../generic-prompts";

// Toolchain commands only — style policy (naming, line limits) is not a role
// contract and must not be injected into prompts (no-style-policy-bloat).
const CONVENTIONS = `Toolchain:
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
  return `Write all files under ${workspaceRoot}/.\n`;
}

const config: LanguageConfig = {
  key: "go",
  sourceFilePattern: "*.go (non-test files)",
  testFilePattern: "*_test.go",
  isTestFile: (path: string) => /\b\w+_test\.go$/.test(path),
  isPhaseAAllowed: (path: string) => /\b\w+_test\.go$/.test(path) || /\b\w+\.go$/.test(path) || /go\.(mod|sum)$/.test(path),

  prompts: {
    promptTesterPhaseA: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests; the spec is your contract.

If the spec has no Test Strategy section, read the codebase, identify the test contract (which files to test, which behaviors to cover, which edge cases matter), and write a "## Test Strategy" section into the spec file. Then write the tests that section defines.

Write *_test.go files and empty stub .go files for the implementation.

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Fail against the stubs until the Writer implements them

Run the tests once to confirm they fail because of missing behavior, not because of compile errors. When all tests are written, stop producing tool calls.`,

    promptTesterPhaseARestart: (specPath: string, _buildTool: string, workspaceRoot?: string) =>
`You are the TESTER. Write contract tests.

Spec: ${specPath}
${ws(workspaceRoot)}Read the spec's Test Strategy section first. It defines exactly which tests to write. Start with those tests; the spec is your contract.

If the spec has no Test Strategy section, read the codebase, identify the test contract (which files to test, which behaviors to cover, which edge cases matter), and write a "## Test Strategy" section into the spec file. Then write the tests that section defines.

Write *_test.go files and empty stub .go files for the implementation.

Tests must:
- Cover all spec requirements
- Include edge cases: empty, single-char, UTF-8, whitespace, case
- Use table-driven tests where applicable
- Fail against the stubs until the Writer implements them

Run the tests once to confirm they fail because of missing behavior, not because of compile errors. When all tests are written, stop producing tool calls.`,

    promptTesterCompileRetry: (compileError: string) =>
`Compilation failed. Fix the compilation errors.

${delimitUntrusted("COMPILE ERROR", compileError)}
${UNTRUSTED_DATA_GUARD}

When done, stop producing tool calls.`,

    promptTesterZeroTestRetry: () =>
`Phase A gate: no new or modified test files detected.

You are the TESTER. Write contract tests (*_test.go) — the gate cannot advance until at least one new or modified test file exists.
Read the spec's Test Strategy section. It defines exactly which tests to write; write those.

If the spec genuinely requires no new tests (e.g. a refactor pinned by existing tests), do not stop — raise it via negotiate_propose so the test contract is agreed before the loop burns its retry budget.

When the test files are written, stop producing tool calls.`,

    promptNegotiateAutoAdvance: (negotiateResolution: string, workspaceRoot?: string) =>
`Advancing to Phase B without explicit approval. Write Go source files.

${ws(workspaceRoot)}Negotiated resolution:
${delimitUntrusted("NEGOTIATED RESOLUTION", negotiateResolution)}
${UNTRUSTED_DATA_GUARD}

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

Stop producing tool calls when all tests pass, or when every remaining failure is a test you have disputed via negotiate_propose.`,

    promptWriterPhaseBContinue: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase B (Writer). Tests failed.

${ws(workspaceRoot)}Failure summary:
${delimitUntrusted("TEST OUTPUT", failureSummary)}
${UNTRUSTED_DATA_GUARD}

Do not modify *_test.go — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
Stop producing tool calls when all tests pass, or when every remaining failure is a test you have disputed via negotiate_propose.`,

    promptCleanerPhaseC: (workspaceRoot?: string) =>
`Phase C (Cleaner). Refactor the Go source files for readability without changing behavior.

${ws(workspaceRoot)}Do not modify *_test.go; test files are owned by the Tester.
All tests must still pass.

${CONVENTIONS}

When the refactor is complete and all tests pass, stop producing tool calls.`,

    promptCleanerRetry: (failureSummary: string, failureCount: number, workspaceRoot?: string) =>
`Phase C (Cleaner). Tests failed after refactoring:

${ws(workspaceRoot)}Failure summary:
${delimitUntrusted("TEST OUTPUT", failureSummary)}
${UNTRUSTED_DATA_GUARD}

Fix the broken code by restoring working behavior. Do not modify *_test.go — test files are owned by the Tester.
When all tests pass, stop producing tool calls.`,

    promptCleanerRestart: (workspaceRoot?: string) =>
`Phase C (Cleaner). Restart. Refactor Go source files.

${ws(workspaceRoot)}Do not modify *_test.go. All tests must pass.
When done, stop producing tool calls.`,

    promptTesterDisputeFix: (workspaceRoot?: string, claim?: string, specPath?: string) =>
`Conceded dispute. Fix the test in *_test.go to match the spec.
${specPath ? `Spec: ${specPath}\n` : ""}${claim ? delimitUntrusted(claim, "DISPUTE CLAIM") + "\n" : ""}${ws(workspaceRoot)}Do not modify non-test Go files. When done, stop producing tool calls.`,
  },

  refusalMessage: {
    phaseA: "You are the TESTER. Write contract tests (*_test.go) and stub .go files — not source files. Read the spec's Test Strategy section for your contract. This file is outside Phase A scope.",
    negotiate: "Negotiation is discussion-only. No file writes allowed. Use negotiate_propose to propose a resolution.",
    phaseC: "You are the WRITER (Phase B) or CLEANER (Phase C). Write source files (*.go, non-test) — not test files. Test files (*_test.go) are owned by the Tester. Dispute wrong tests via negotiate_propose.",
  },
};

export default config;
