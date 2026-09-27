/**
 * Behavioral prompt test harness v2 — extended.
 * Tests 8 prompts: the original 3 + 5 high-value prompts.
 *
 * Usage: npx tsx prompt-forge/behavior-test.ts
 */

import { execSync } from "node:child_process";

const BASE_URL = "http://192.168.71.245:8000/v1";
const API_KEY = "asdf-asdf-asdf-asdf";
const MODEL = "Qwen3.8-27B-oQ4e-mtp";

function callLLM(prompt: string): string {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 512,
    temperature: 0,
  });
  try {
    const result = execSync(
      `curl -s ${BASE_URL}/chat/completions -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`,
      { timeout: 60000, encoding: "utf-8" }
    );
    const parsed = JSON.parse(result);
    if (parsed.error) return `[ERROR: ${parsed.error.message}]`;
    return parsed.choices?.[0]?.message?.content ?? "[NO RESPONSE]";
  } catch (e: any) {
    return `[ERROR: ${e.message}]`;
  }
}

// --- Shared prompt fragments ---

const CONVENTIONS = `Conventions:
- Use const/let, not var
- Prefer async/await over .then()
- No default exports
- Named exports only
- No method over 200 lines
- No files over 500 lines`;

const RESOLUTION = `Move the 5 new describe blocks from test/events/b-phase-role-context.test.ts into test/events/before-agent.test.ts. Delete test/events/b-phase-role-context.test.ts. Add two module-private helpers to src/events/before-agent.ts.`;

const FAILURE_SUMMARY = `3 tests failed:
- src/events/before-agent.test.ts: expected 'Phase B' but got 'Phase A'
- src/events/before-agent.test.ts: mockReset() cleared runGates return value
- src/events/agent-settled/index.test.ts: undefined is not a function`;

// --- OLD prompts (from git HEAD) ---

function oldWriterPhaseB(): string {
  return `Phase B (Writer). Write TypeScript source files to pass all tests.

Workspace: /workspace
Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

${CONVENTIONS}

When done, stop producing tool calls.`;
}

function oldCleanerPhaseC(): string {
  return `Phase C (Cleaner). Refactor source files for clarity. Tests must stay green.

Workspace: /workspace
Read the source files. Refactor for clarity: extract helpers, rename for clarity, remove dead code.
You may NOT edit test files. If a test is wrong, dispute it via negotiate_propose.

${CONVENTIONS}

When done, stop producing tool calls.`;
}

function oldTesterPhaseA(): string {
  return `You are the TESTER. Write contract tests.

Read /workspace/spec.md. Workspace: /workspace
Design the test contract that defines correct behavior.
Write both *.test.ts and *.ts (tests) and stub .ts files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, undefined, null, single element
- Use describe/it blocks from Vitest
- Import assert functions and test utilities
- Check package.json for dependencies

When done, stop producing tool calls.`;
}

function oldWriterPhaseBContinue(): string {
  return `Phase B (Writer). Tests failed.

Workspace: /workspace
${FAILURE_SUMMARY}

Do not modify *.test.ts. Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
When done, stop producing tool calls.`;
}

function oldCleanerRetry(): string {
  return `Phase C (Cleaner). Tests failed after refactoring:

Workspace: /workspace
${FAILURE_SUMMARY}

Fix the broken tests by restoring working code. Do not modify *.test.ts.
When done, stop producing tool calls.`;
}

function oldWriterNegotiate(): string {
  return `WRITER (negotiation).

Read /workspace/spec.md. Then review /workspace/*.test.ts — understand all test cases.
Find contradictions or ambiguities: conflicting rules, undifferentiated errors, weak assertions.
Surface these in your proposal — do not silently pick an interpretation.

Use negotiate_propose: 'agree' if tests match spec, or describe your approach (types, functions, behavior).
Do NOT write files. Tester reviews via negotiate_review.`;
}

// --- NEW prompts (current working tree) ---

function newWriterPhaseB(): string {
  return `Phase B (Writer). Write TypeScript source files to pass all tests.

Workspace: /workspace
Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
You may NOT edit test files (*.test.ts). If a test is wrong, dispute it via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.

When done, stop producing tool calls.`;
}

function newCleanerPhaseC(): string {
  return `Phase C (Cleaner). Refactor source files for clarity. Tests must stay green.

Workspace: /workspace
Read the source files. Refactor for clarity: extract helpers, rename for clarity, remove dead code.
You may NOT edit test files (*.test.ts). If a test is wrong, dispute it via negotiate_propose.

When done, stop producing tool calls.`;
}

function newTesterPhaseA(): string {
  return `You are the TESTER. Write contract tests.

Spec: /workspace/spec.md
Workspace: /workspace
Design the test contract that defines correct behavior.
Write both *.test.ts and *.ts (tests) and stub .ts files (empty implementations).

Tests must:
- Cover all spec requirements
- Include edge cases: empty, undefined, null, single element
- Use describe/it blocks from Vitest
- Import assert functions and test utilities
- Check package.json for dependencies
- Fail against the stubs until the Writer implements them

When all tests are written, stop producing tool calls.`;
}

function newWriterPhaseBContinue(): string {
  return `Phase B (Writer). Tests failed.

Workspace: /workspace
Failure summary:
${FAILURE_SUMMARY}

Do not modify *.test.ts — test files are owned by the Tester.
Dispute wrong tests via negotiate_propose.
Concede with negotiate_propose("agree") if the test is correct and your code is wrong.
When all tests pass, stop producing tool calls.`;
}

function newCleanerRetry(): string {
  return `Phase C (Cleaner). Tests failed after refactoring:

Workspace: /workspace
Failure summary:
${FAILURE_SUMMARY}

Fix the broken code by restoring working behavior. Do not modify *.test.ts — test files are owned by the Tester.
When all tests pass, stop producing tool calls.`;
}

function newWriterNegotiate(): string {
  return `WRITER (negotiation).

Spec: /workspace/spec.md
Test files: /workspace/*.test.ts

Read the spec, then review the test files — understand all test cases.
Find contradictions or ambiguities: conflicting rules, undifferentiated errors, weak assertions.
Surface these in your proposal — do not silently pick an interpretation.

Use negotiate_propose: 'agree' if tests match spec, or describe your approach (types, functions, behavior).
Do NOT write files. Tester reviews via negotiate_review.
After the negotiate_propose call, stop producing tool calls.`;
}

function newNegotiateAutoAdvance(): string {
  return `Phase B (Writer). Write TypeScript source files to pass all tests.

Workspace: /workspace
Read *.test.ts and *.ts stubs. Implement the logic. Preserve stub signatures.
You may NOT edit test files (*.test.ts).

Negotiated resolution:
${RESOLUTION}

If the resolution requires editing test files, that half is owned by the Tester.
Implement the source half now. Report the test half as pending the Tester.
Do NOT claim the resolution is complete if the test half is not done.

When done, stop producing tool calls.`;
}

// --- Q&A test framework ---

interface QATest {
  name: string;
  prompt: string;
  question: string;
  check: (content: string) => { passed: boolean; detail: string };
}

// --- Tests ---

const tests: QATest[] = [
  // ── Group 1: Writer Phase B (original 3) ──

  {
    name: "Writer B: test file boundary (old)",
    prompt: oldWriterPhaseB(),
    question: "Based on your instructions above, can you edit test files (*.test.ts)? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|won't/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 120) };
    },
  },
  {
    name: "Writer B: test file boundary (new)",
    prompt: newWriterPhaseB(),
    question: "Based on your instructions above, can you edit test files (*.test.ts)? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|won't/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 120) };
    },
  },

  // ── Group 2: Cleaner Phase C (original 3) ──

  {
    name: "Cleaner C: test file boundary (old)",
    prompt: oldCleanerPhaseC(),
    question: "Based on your instructions above, can you edit test files (*.test.ts)? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|won't/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 120) };
    },
  },
  {
    name: "Cleaner C: test file boundary (new)",
    prompt: newCleanerPhaseC(),
    question: "Based on your instructions above, can you edit test files (*.test.ts)? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|won't/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 120) };
    },
  },

  // ── Group 3: Negotiate Auto-Advance (original 3) ──

  {
    name: "Auto-advance: knows resolution (new)",
    prompt: newNegotiateAutoAdvance(),
    question: "What is the negotiated resolution you were given? Summarize it in one sentence.",
    check: (c) => {
      const knows = /b-phase-role-context|before-agent|describe blocks/i.test(c);
      return { passed: knows, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Auto-advance: routes to Tester (new)",
    prompt: newNegotiateAutoAdvance(),
    question: "The negotiated resolution requires editing test files. Who is responsible for that part — you or the Tester? Answer in one sentence.",
    check: (c) => {
      const routesTester = /tester/i.test(c);
      return { passed: routesTester, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Auto-advance: no false done (new)",
    prompt: newNegotiateAutoAdvance(),
    question: "You implemented the source half of the resolution (helpers in before-agent.ts) but did NOT edit the test files. Can you report the resolution as complete? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|won't|should not/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Old Writer: no resolution (EXPECTED: ignores question)",
    prompt: oldWriterPhaseB(),
    question: "What is the negotiated resolution you were given? Summarize it in one sentence.",
    check: (c) => {
      const ignores = /i'll start|let me|exploring|reading/i.test(c);
      return { passed: ignores, detail: ignores ? "Ignores question → resolution NOT in prompt (expected)" : "Answers question → unexpected" };
    },
  },

  // ── Group 4: Tester Phase A (NEW) ──
  // Key fix: old prompt had self-contradiction ("can't edit non-test files"
  // while required to write stub .ts files). New prompt removes the contradiction.

  {
    name: "Tester A: can write stub files? (old — self-contradiction)",
    prompt: oldTesterPhaseA(),
    question: "Your instructions say to write stub .ts files. Are you allowed to write .ts files that are NOT test files (i.e., stub source files)? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      // The old prompt says "Write both *.test.ts and *.ts (tests) and stub .ts files"
      // but the refusal message says "Phase A only: write test files and stubs"
      // The model should say YES — it's allowed to write stubs
      const saysYes = /\byes\b|allowed|can write|permitted/i.test(c);
      return { passed: saysYes, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Tester A: can write stub files? (new — no contradiction)",
    prompt: newTesterPhaseA(),
    question: "Your instructions say to write stub .ts files. Are you allowed to write .ts files that are NOT test files (i.e., stub source files)? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysYes = /\byes\b|allowed|can write|permitted/i.test(c);
      return { passed: saysYes, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Tester A: tests must fail against stubs (new)",
    prompt: newTesterPhaseA(),
    question: "Your instructions say tests must 'Fail against the stubs until the Writer implements them.' What does this mean — should the tests pass or fail when run against the empty stub files? Answer in one sentence.",
    check: (c) => {
      const saysFail = /fail|should fail|expected to fail|must fail|not pass/i.test(c);
      const ignores = /i'll start|let me|exploring/i.test(c);
      if (ignores) return { passed: false, detail: "Model ignored question and started executing" };
      return { passed: saysFail, detail: c.slice(0, 150) };
    },
  },

  // ── Group 5: Writer Phase B Continue (NEW) ──
  // Key fix: old prompt had no "Failure summary:" label, no "owned by the Tester" language

  {
    name: "Writer B-continue: knows failure summary (old)",
    prompt: oldWriterPhaseBContinue(),
    question: "What are the specific test failures you were given? List them briefly.",
    check: (c) => {
      const knows = /mockReset|Phase B.*Phase A|undefined is not a function/i.test(c);
      return { passed: knows, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Writer B-continue: knows failure summary (new)",
    prompt: newWriterPhaseBContinue(),
    question: "What are the specific test failures you were given? List them briefly.",
    check: (c) => {
      const knows = /mockReset|Phase B.*Phase A|undefined is not a function/i.test(c);
      return { passed: knows, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Writer B-continue: test boundary (new)",
    prompt: newWriterPhaseBContinue(),
    question: "Can you edit test files (*.test.ts) to fix the failures? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|won't|owned by/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 150) };
    },
  },

  // ── Group 6: Cleaner Retry (NEW) ──
  // Key fix: old prompt said "Fix the broken tests" (wrong — should fix code, not tests)
  // New prompt says "Fix the broken code by restoring working behavior"

  {
    name: "Cleaner retry: fix code or tests? (old — says 'fix broken tests')",
    prompt: oldCleanerRetry(),
    question: "The tests failed after your refactoring. What should you fix — the test files or the source code? Answer in one sentence.",
    check: (c) => {
      // We want the model to say "fix the code" not "fix the tests"
      const saysFixCode = /fix the source code|fix.*code|restore working code|fix the code|source code/i.test(c);
      // "not the test files" is a NEGATIVE context — the model is saying it should NOT fix tests
      const saysFixTests = /fix the tests\b|fix.*test files(?!.*not)/i.test(c) && !/not the test files|not.*test/i.test(c);
      return { passed: saysFixCode && !saysFixTests, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Cleaner retry: fix code or tests? (new — says 'fix broken code')",
    prompt: newCleanerRetry(),
    question: "The tests failed after your refactoring. What should you fix — the test files or the source code? Answer in one sentence.",
    check: (c) => {
      const saysFixCode = /fix the source code|fix.*code|restore working behavior|fix the code|source code/i.test(c);
      const saysFixTests = /fix the tests\b|fix.*test files(?!.*not)/i.test(c) && !/not the test files|not.*test/i.test(c);
      return { passed: saysFixCode && !saysFixTests, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Cleaner retry: test boundary (new)",
    prompt: newCleanerRetry(),
    question: "Can you edit test files (*.test.ts)? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|won't|owned by/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 150) };
    },
  },

  // ── Group 7: Writer Negotiate (NEW) ──
  // Key fix: old prompt had no separate Spec/Test files labels, no termination on negotiate_propose

  {
    name: "Writer negotiate: knows spec path (old)",
    prompt: oldWriterNegotiate(),
    question: "What spec file should you read? Answer with the file path only.",
    check: (c) => {
      const knows = /spec\.md|\/workspace/i.test(c);
      return { passed: knows, detail: c.slice(0, 100) };
    },
  },
  {
    name: "Writer negotiate: knows spec path (new)",
    prompt: newWriterNegotiate(),
    question: "What spec file should you read? Answer with the file path only.",
    check: (c) => {
      const knows = /spec\.md|\/workspace/i.test(c);
      return { passed: knows, detail: c.slice(0, 100) };
    },
  },
  {
    name: "Writer negotiate: knows test file pattern (new)",
    prompt: newWriterNegotiate(),
    question: "What test files should you review? Answer with the file pattern only.",
    check: (c) => {
      const knows = /\.test\.ts|\*\.test/i.test(c);
      return { passed: knows, detail: c.slice(0, 100) };
    },
  },
  {
    name: "Writer negotiate: no file writes (new)",
    prompt: newWriterNegotiate(),
    question: "Are you allowed to write or edit any files? Answer yes or no, then explain in one sentence.",
    check: (c) => {
      const saysNo = /\bno\b|cannot|may not|not allowed|do not write|do NOT write/i.test(c);
      return { passed: saysNo, detail: c.slice(0, 150) };
    },
  },
  {
    name: "Writer negotiate: terminates on negotiate_propose (new)",
    prompt: newWriterNegotiate(),
    question: "After making your proposal, what should you do? Answer in one sentence.",
    check: (c) => {
      const correct = /negotiate_propose|stop producing tool calls/i.test(c);
      return { passed: correct, detail: c.slice(0, 150) };
    },
  },
];

// --- Run ---

async function main() {
  console.log(`Prompt Behavioral Test (extended) — ${MODEL}`);
  console.log(`${tests.length} tests\n`);

  let passed = 0, failed = 0;
  const results: { name: string; passed: boolean; detail: string }[] = [];

  for (const t of tests) {
    const fullPrompt = `${t.prompt}\n\nQuestion: ${t.question}`;
    const resp = callLLM(fullPrompt);
    const result = t.check(resp);
    const mark = result.passed ? "✓" : "✗";
    console.log(`${mark} ${t.name}`);
    console.log(`  Q: ${t.question}`);
    console.log(`  A: ${resp.slice(0, 200)}${resp.length > 200 ? "..." : ""}`);
    console.log(`  → ${result.detail}`);
    console.log();

    if (result.passed) passed++;
    else failed++;
    results.push({ name: t.name, passed: result.passed, detail: result.detail });
  }

  // Summary
  console.log("═".repeat(70));
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log("═".repeat(70));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.detail}`);
    }
  }
}

main();
