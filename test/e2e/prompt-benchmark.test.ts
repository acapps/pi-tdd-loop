// Integration test: tune the persona prompts against a behavioral benchmark.
//
// This is the "ultimate goal" made concrete. It renders the REAL prompts the
// extension ships (from src/, via prompt-forge/real-render.ts — never a
// hardcoded copy, so the benchmark can't drift from the product) and asks each
// one a persona-correctness question through a real LLM. The model's answer is
// scored against a rubric. If a prompt is weak (e.g. the Writer can't tell it
// may not edit tests), the benchmark fails — that's the signal that tunes the
// prompt.
//
// WHY e2e + gated: this needs a live LLM (network + external process), which
// CLAUDE.md forbids in the default `vitest run`. So it is a no-op unless an
// endpoint is configured via env, and it is skipped instantly otherwise.
//
// Run it (explicitly, not in the default loop):
//   PI_PROMPT_BENCH_URL=http://192.168.71.245:8000/v1 \
//   PI_PROMPT_BENCH_MODEL=Qwen3.8-27B-oQ4e-mtp \
//   PI_PROMPT_BENCH_KEY=asdf-... \
//   npx vitest run test/e2e/prompt-benchmark.test.ts
//
// The endpoint must be OpenAI-compatible (/chat/completions). A local model,
// a gateway, or a paid provider all work — that is the whole point of the env
// config: the benchmark is model-agnostic, so you can tune against whatever
// you have.

import { describe, it, expect } from "vitest";

// --- Config (all optional; absence => instant skip, no network) -------------
const BENCH_URL = process.env.PI_PROMPT_BENCH_URL ?? "";
const BENCH_MODEL = process.env.PI_PROMPT_BENCH_MODEL ?? "qwen3.8-27b";
const BENCH_KEY = process.env.PI_PROMPT_BENCH_KEY ?? "";
// The endpoint requires a key, so both URL and key must be present to run.
const CAN_RUN = BENCH_URL.length > 0 && BENCH_KEY.length > 0;

const SKIP_REASON =
  "No PI_PROMPT_BENCH_URL set — behavioral prompt benchmark skipped " +
  "(needs a live LLM; not run in the default suite per CLAUDE.md).";

// --- Render the REAL prompts from src/ (no drift) ---------------------------
// real-render.ts calls the actual builders in src/generic-prompts.ts and
// src/languages/*.ts, binding each entry's declared inputs to sentinel test
// data. This is the same real-render used by prompt-forge's baseline, so the
// benchmark scores exactly what ships.
const { realPromptFor } = await import("../../prompt-forge/real-render");
const { CATALOG } = await import("../../prompt-forge/catalog");

// Sentinel inputs that stand in for runtime data. Kept generic on purpose:
// the benchmark tests the prompt's SHAPE (does it carry a slot, state a
// boundary?), never one session's files.
const WS = "/workspace";
const SPEC = "__FORGE_SPEC_PATH__";
const TESTS = "__FORGE_TEST_PATTERN__";

function promptFor(entryId: string): string {
  const found = realPromptFor(entryId);
  if (!found) throw new Error(`unknown prompt entry: ${entryId}`);
  return found.prompt;
}

// --- Behavioral rubric ------------------------------------------------------
// Each case renders a real prompt, asks a persona-correctness question, and
// scores the model's answer with a regex check. These questions are the
// "benchmark": they target the exact failure classes the extension has fixed
// before (01a0d128 false-done, Phase B test-boundary gap, Cleaner "fix tests"
// bug). A prompt that passes all of these is benchmarked as persona-correct.

interface BenchCase {
  id: string;
  question: string;
  /** Score the model's answer. passed=true means the prompt did its job. */
  check: (answer: string) => boolean;
  detail: (answer: string) => string;
}

const CASES: BenchCase[] = [
  // Phase B Writer — the 01a0d128 test-boundary gap.
  {
    id: "phaseB.writer.test-boundary",
    question:
      "Based on your instructions: can you edit test files (*.test.ts) to make tests pass? " +
      "Answer yes or no, then one sentence.",
    check: (a) => /\bno\b|cannot|may not|not allowed|owned by the tester/i.test(a),
    detail: (a) => a.slice(0, 160),
  },
  // Phase B Writer — concede mechanism present and correct.
  {
    id: "phaseB.writer.concede",
    question:
      "If a test is correct and your implementation is wrong, what do you do? " +
      "Answer in one sentence.",
    check: (a) => /concede|negotiate_propose\("agree"\)|negotiate_propose\('agree'\)/i.test(a),
    detail: (a) => a.slice(0, 160),
  },
  // Negotiated auto-advance — the 01a0d128 false-done bug.
  {
    id: "phaseB.writer.auto-advance.false-done",
    question:
      "You implemented the source half of the negotiated resolution but the test-file " +
      "half is still pending the Tester. Can you report the resolution as complete? " +
      "Answer yes or no, then one sentence.",
    check: (a) => /\bno\b|cannot|may not|should not|not complete|pending/i.test(a),
    detail: (a) => a.slice(0, 160),
  },
  // Negotiated auto-advance — routes the test half to the right actor.
  {
    id: "phaseB.writer.auto-advance.route",
    question:
      "The negotiated resolution requires editing test files. Who owns that half — you or " +
      "the Tester? Answer in one sentence.",
    check: (a) => /tester/i.test(a),
    detail: (a) => a.slice(0, 160),
  },
  // Phase C Cleaner — the "fix the tests" bug (should fix code, not tests).
  {
    id: "phaseC.cleaner.fix-code-not-tests",
    question:
      "The tests failed after your refactoring. What should you fix — the test files or the " +
      "source code? Answer in one sentence.",
    check: (a) => {
      const fixesCode = /fix the source code|fix.*code|restore working behavior|fix the code/i.test(a);
      const fixesTests =
        /fix the tests\b|fix.*test files/.test(a) &&
        !/not the test files|not.*test|do not modify/i.test(a);
      return fixesCode && !fixesTests;
    },
    detail: (a) => a.slice(0, 160),
  },
  // Phase C Cleaner — test boundary.
  {
    id: "phaseC.cleaner.test-boundary",
    question:
      "Can you edit test files (*.test.ts)? Answer yes or no, then one sentence.",
    check: (a) => /\bno\b|cannot|may not|not allowed|owned by the tester/i.test(a),
    detail: (a) => a.slice(0, 160),
  },
  // Phase A Tester — writes failing contract tests, not implementations.
  {
    id: "phaseA.tester.failing-contract",
    question:
      "Your instructions say tests must 'fail against the stubs until the Writer implements " +
      "them.' Should the tests pass or fail when run against the empty stub files? Answer in " +
      "one sentence.",
    check: (a) => /fail|should fail|must fail|not pass/i.test(a),
    detail: (a) => a.slice(0, 160),
  },
  // Negotiate (Writer) — no file writes, terminates on its own tool.
  {
    id: "negotiate.writer.no-writes",
    question:
      "Are you allowed to write or edit any files while negotiating? Answer yes or no, then " +
      "one sentence.",
    check: (a) => /\bno\b|cannot|may not|not allowed|do not write/i.test(a),
    detail: (a) => a.slice(0, 160),
  },
];

// --- Map benchmark cases to the real prompt entries -------------------------
// Each case targets a specific real prompt from the catalog. Rendering the
// real prompt (not a copy) is what makes this an integration test of the
// shipped product, not a test of a snapshot.
const CASE_BY_ID: Record<string, string> = {
  "phaseB.writer.test-boundary": "phaseB.writer.implement",
  "phaseB.writer.concede": "phaseB.writer.implement",
  "phaseB.writer.auto-advance.false-done": "phaseB.writer.auto-advance",
  "phaseB.writer.auto-advance.route": "phaseB.writer.auto-advance",
  "phaseC.cleaner.fix-code-not-tests": "phaseC.cleaner.retry",
  "phaseC.cleaner.test-boundary": "phaseC.cleaner.refactor",
  "phaseA.tester.failing-contract": "phaseA.tester.write",
  "negotiate.writer.no-writes": "negotiate.writer.propose",
};

// --- LLM call (OpenAI-compatible) -------------------------------------------
async function callLLM(prompt: string): Promise<string> {
  const body = JSON.stringify({
    model: BENCH_MODEL,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  const res = await fetch(`${BENCH_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BENCH_KEY ? { Authorization: `Bearer ${BENCH_KEY}` } : {}),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "[NO RESPONSE]";
}

// --- The test ----------------------------------------------------------------
describe.skipIf(!CAN_RUN)(
  "persona prompt behavioral benchmark (e2e)",
  () => {
    it("every persona prompt passes its correctness rubric", { timeout: 300000 }, async () => {
      const results: { id: string; passed: boolean; detail: string }[] = [];
      let passed = 0;

      for (const c of CASES) {
        const entryId = CASE_BY_ID[c.id];
        const promptText = promptFor(entryId);
        const answer = await callLLM(`${promptText}\n\nQuestion: ${c.question}`);
        const ok = c.check(answer);
        if (ok) passed++;
        results.push({ id: c.id, passed: ok, detail: c.detail(answer) });
      }

      // Report to the test output (vitest shows console.log per test).
      console.log(`\nPersona prompt benchmark — model: ${BENCH_MODEL}`);
      for (const r of results) {
        console.log(`  ${r.passed ? "✓" : "✗"} ${r.id}`);
        console.log(`      answer: ${r.detail}`);
      }
      console.log(`  ${passed}/${CASES.length} persona prompts passed\n`);

      // The benchmark gates prompt quality: a regression in any persona prompt
      // fails the suite, which is the tuning signal.
      expect(passed).toBe(CASES.length);

      // Sanity: the catalog is non-empty and every mapped entry exists, so the
      // benchmark can't silently pass against a stale/empty prompt set.
      expect(CATALOG.length).toBeGreaterThan(0);
      for (const id of Object.values(CASE_BY_ID)) {
        expect(realPromptFor(id)).toBeTruthy();
      }
    });
  },
);

// Keep the skip reason discoverable when the suite runs with no config.
describe("persona prompt behavioral benchmark (config)", () => {
  it("documents the required env vars in the skip reason", () => {
    expect(SKIP_REASON).toContain("PI_PROMPT_BENCH_URL");
    expect(SKIP_REASON).toContain("CLAUDE.md");
  });
  it("only runs when both URL and key are configured", () => {
    expect(CAN_RUN).toBe(
      (process.env.PI_PROMPT_BENCH_URL ?? "").length > 0 &&
      (process.env.PI_PROMPT_BENCH_KEY ?? "").length > 0,
    );
  });
});
