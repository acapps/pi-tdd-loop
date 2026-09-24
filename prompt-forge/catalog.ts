// The prompt catalog — the single source of truth for the prompt-forge harness.
//
// This is what makes the harness GENERAL instead of overfit: it maps every
// prompt the extension uses to (a) its phase/role, (b) its declared INPUTS (the
// data it receives at runtime), and (c) the STRUCTURAL guarantees a good version
// must have. The rubric scores against these guarantees — never against a
// specific session's files/symbols. A prompt passes if it has the right SHAPE
// (carries a resolution slot, states the role boundary, routes to the right
// actor, has a termination contract), not if it names one session's data.
//
// Adding a new prompt = adding a catalog entry. That's the whole extension model.

import type { LanguageConfig } from "../src/languages";
import * as GP from "../src/generic-prompts";
import { buildPhaseZeroPrompt } from "../src/commands/loop";

export type Phase = "phase0" | "phaseA" | "phaseB" | "phaseC" | "negotiate";
export type Role = "reviewer" | "tester" | "writer" | "cleaner" | "any";

// A structural guarantee: a named check the rubric can evaluate. The `check`
// is a function on the rendered prompt string. It must be STRUCTURAL — it may
// reference the catalog entry's declared inputs (so it can verify the input
// slot is present) but must NOT hardcode a specific session's file/symbol.
export interface Guarantee {
  id: string;
  /** Human-readable: what this guarantee is and why it matters. */
  why: string;
  /** Weight, 0..1 (normalized across the entry's guarantees at score time). */
  weight: number;
  /** Evaluate the rendered prompt. `inputs` are the declared runtime inputs. */
  check: (prompt: string, entry: PromptEntry) => boolean;
}

export interface PromptEntry {
  /** Stable id, e.g. "phaseB.writer.autoAdvance". */
  id: string;
  phase: Phase;
  role: Role;
  /** The prompt's display name (the builder or config key). */
  name: string;
  /** The declared runtime inputs this prompt receives. The rubric uses these
   *  to verify the prompt *carries its inputs* (slot present) without
   *  hardcoding a specific value. */
  inputs: string[];
  /** Structural guarantees a good version must satisfy. */
  guarantees: Guarantee[];
  /** Render the prompt with a given input binding (test data). */
  render: (bind: Record<string, string>) => string;
  /** Where it lives (for humans). */
  source: string;
}

// --- Shared structural checks (reused across entries) ---

// The prompt states a role boundary: what the role CANNOT do. Structural —
// looks for a prohibition verb + a file-kind token, not a specific file.
// NOTE (anti-overfit lesson, applied to the rubric itself): this must be
// structural but NOT brittle. "Do not modify *.test.ts", "You may only write
// *.ts (non-test)", and "Do not modify non-test files" must ALL pass. So we
// check for a prohibition verb AND a test/non-test token, in either order,
// with a generous window, and we treat "non-test" as a boundary marker.
export const statesRoleBoundary = (forbiddenKind: string): Guarantee => ({
  id: "states-role-boundary",
  why: `The prompt must state what the role cannot do (${forbiddenKind}), so the agent ` +
    `does not silently commit to work it is structurally barred from.`,
  weight: 1,
  check: (p) => {
    const hasProhibition = /(cannot|can't|must not|do not|don't|may not|never|only write|only modify|do not modify)/i.test(p);
    // The forbidden kind appears as a token (test / non-test / *.test.ts etc.)
    const kindRe = new RegExp(`non-${forbiddenKind}|${forbiddenKind}`, "i");
    const hasKind = kindRe.test(p);
    // "non-test" alone is a boundary (it names what's forbidden).
    const nonTestMarker = /non-test/i.test(p);
    return hasProhibition && (hasKind || nonTestMarker);
  },
});

// The prompt carries one of its declared inputs (a slot, not a hardcoded value).
// `input` is the declared input name; the check verifies the rendered prompt
// is non-trivial and (when the input is bound to a sentinel) contains the
// sentinel — proving the input flows through, not that it equals one value.
export const carriesInput = (input: string): Guarantee => ({
  id: `carries-${input}`,
  why: `The prompt must carry its declared input "${input}" (a slot filled at runtime), ` +
    `not hardcode a specific value.`,
  weight: 1,
  check: (p) => p.trim().length > 0, // refined at score time with the sentinel bind
});

// The prompt has a termination contract ("stop producing tool calls" or equiv).
// Round 1 refinement (frontier): the stop instruction alone is not enough — it
// must be paired with a COMPLETION CONDITION (what "done" means), or the loop
// can settle early or never settle.
// Round 2 refinement (frontier): the completion condition must be REACHABLE
// given the entry's permitted actions. A no-write entry (negotiate, reviewer)
// cannot have "when all tests pass" — it must reference the tool call
// ("after calling negotiate_propose").
export const hasTermination = (): Guarantee => ({
  id: "termination-contract",
  why: "The prompt must tell the agent WHEN to stop (a reachable completion " +
    "condition) and HOW (stop producing tool calls), so the loop settles at " +
    "the right time. The condition must be reachable given the role's " +
    "permitted actions (no-write roles reference the tool call, not test " +
    "results).",
  weight: 1,
  check: (p, entry) => {
    const hasStop = /stop producing tool calls|when done|call \w+ now|use \w+/i.test(p);
    if (!hasStop) return false;

    // For no-write entries (negotiate, reviewer), the condition must reference
    // the tool call, not test results (which are unreachable).
    const isNoWrite = entry.phase === "negotiate" || entry.role === "reviewer";
    if (isNoWrite) {
      // Must reference "after calling X" or "after the X call".
      const referencesToolCall =
        /after (the\s+)?(calling\s+)?(negotiate_\w+|\w+\s+call)/i.test(p) ||
        /after\s+that\s+call/i.test(p);
      // Must NOT reference test results (unreachable in no-write).
      const referencesTests =
        /all\s+tests\s+pass|tests\s+are\s+written|contract\s+tests/i.test(p);
      return referencesToolCall && !referencesTests;
    }

    // For write entries (writer, cleaner, tester), the condition must reference
    // a reachable completion state (tests pass, refactor complete, etc.).
    const hasCondition =
      /when (all|the|your|no|every)\S{0,40}|when done|once (all|the|your)|after (all|the|your)|only remaining work|no more work|all\s+tests\s+pass|refactor\s+is\s+complete/i.test(
        p,
      );
    return hasCondition;
  },
});

// The prompt routes blocked work to a named actor (structural: names an actor
// + a work token in the same sentence).
export const routesToActor = (actor: string, work: string): Guarantee => ({
  id: `routes-${actor}-${work}`,
  why: `Blocked work (${work}) must be routed to the actor who can do it (${actor}).`,
  weight: 1,
  check: (p) => {
    const sents = p.split(/\n|(?<=[.!?;])\s+/);
    return sents.some(
      (s) => new RegExp(actor, "i").test(s) && new RegExp(work, "i").test(s),
    );
  },
});

// The prompt forbids a false "done" claim (structural: negation + completion
// word in one clause, outside a quoted string).
export const forbidsFalseDone = (): Guarantee => ({
  id: "forbids-false-done",
  why: "The agent must not claim work is complete when a blocked half is outstanding.",
  weight: 1,
  check: (p) => {
    const re =
      /(do not|don't|never|must not)[^\n.]{0,40}(report|claim|state|say|declare)[^\n.]{0,120}(complete|done|satisfied|resolved)/i;
    const m = p.match(re);
    if (!m) return false;
    const quotes = (p.slice(0, m.index!).match(/"/g) ?? []).length;
    return quotes % 2 === 0;
  },
});

// THE ANTI-OVERFIT GUARD: the prompt must not contain a specific file path or
// symbol that is NOT one of its declared inputs. This is the criterion that
// would have caught the 92/100 overfit prompt (it hardcoded 01a0d128's files).
// `declaredData` are the literal values the entry is allowed to embed (its
// declared inputs' test bindings). Anything else that looks like a specific
// path/symbol fails.
export const noHardcodedData = (declaredData: string[]): Guarantee => ({
  id: "no-hardcoded-data",
  why: "Anti-overfit: the prompt must not embed a specific file/symbol beyond its " +
    "declared inputs. A general prompt uses slots, not one session's data.",
  weight: 2, // weighted heavier — this is the load-bearing anti-overfit check
  check: (p) => {
    // Find backtick-quoted or path-like tokens.
    const tokens = new Set<string>();
    for (const m of p.matchAll(/`([^`]+)`/g)) tokens.add(m[1]);
    for (const m of p.matchAll(/\b[\w./-]+\.\w{1,5}(?:\.\w+)?\b/g)) tokens.add(m[0]);
    for (const t of tokens) {
      // Allow generic patterns (contain * or are a declared value).
      if (t.includes("*")) continue;
      if (declaredData.some((d) => t.includes(d) || d.includes(t))) continue;
      // Allow the prompt's own declared input names.
      if (declaredData.length === 0) continue;
      // A specific path (has / and an extension) that isn't declared → overfit.
      if (/^[\w.-]+\/[\w./-]+\.\w{1,5}$/.test(t)) return false;
    }
    return true;
  },
});

// --- The catalog ---

// A sentinel used to verify inputs flow through (carriesInput refinement).
// NOTE (round 2): the distinct-sentinel check in score.ts is the PRIMARY
// mechanism for carries-* guarantees. This shared SENTINEL is kept only for
// backward compatibility; the catalog's carries-* checks should NOT rely on
// it (that was the round-1 slot-conflation bug). They should be purely
// structural (regex on the prompt text).
export const SENTINEL = "__FORGE_INPUT__";

// Round 2 refinement (frontier): input-coverage guarantee. Fails if two
// declared inputs render to the same slot token, or a declared input has no
// slot. This catches phase0 `findings` and negotiate `specPath`/
// `testFilePattern` collapsing into one __FORGE_INPUT__.
export const inputCoverage = (): Guarantee => ({
  id: "input-coverage",
  why: "Each declared input must have its OWN slot. Two inputs rendering to the " +
    "same slot token is a conflation bug (round 2 frontier finding).",
  weight: 2, // weighted heavily — this is the anti-conflation guard
  check: (p, e) => {
    if (e.inputs.length <= 1) return true; // single input: no conflation possible
    // Count distinct slot tokens in the rendered prompt. A slot token is a
    // __FORGE_*__ or {{*}} placeholder. If there are fewer distinct slots than
    // declared inputs, at least two inputs share a slot.
    const slots = new Set<string>();
    for (const m of p.matchAll(/__FORGE_\w+__/g)) slots.add(m[0]);
    for (const m of p.matchAll(/\{\{\w+\}\}/g)) slots.add(m[0]);
    // If the prompt has fewer distinct slots than declared inputs, conflation.
    // (A prompt might legitimately omit an input if it's optional, but the
    // rubric treats all declared inputs as required.)
    return slots.size >= e.inputs.length;
  },
});

export const CATALOG: PromptEntry[] = [
  // ===== Phase 0 — Review =====
  {
    id: "phase0.reviewer.prompt",
    phase: "phase0",
    role: "reviewer",
    name: "buildPhaseZeroPrompt",
    inputs: ["specText", "findings"],
    source: "src/commands/loop.ts:105",
    guarantees: [
      {
        id: "carries-spec",
        why: "The reviewer must see the spec text to review it.",
        weight: 2,
        // Round 2: purely structural — the distinct-sentinel check in
        // score.ts is the primary mechanism. This checks for a 'Spec:' label
        // or the spec content being present.
        check: (p) => /spec/i.test(p) || p.length > 50,
      },
      {
        id: "instructs-verify-heuristics",
        why: "Auto-generated findings are heuristic; the reviewer must verify, not trust. " +
          "Round 1 refinement: require an explicit imperative to verify/check findings, " +
          "not just the word 'verify' in passing.",
        weight: 2,
        check: (p) =>
          // An imperative to verify/check findings against the spec.
          /(verify|check|confirm|validate)\s+(each\s+)?(finding|one|them|it|these|the)\b/i.test(
            p,
          ) ||
          /treat\s+(them|findings|these)\s+as\s+(heuristic|unverified|candidate)/i.test(p),
      },
      {
        id: "names-mechanism",
        why: "The reviewer must know HOW to approve/reject (negotiate_propose).",
        weight: 1,
        check: (p) => /negotiate_propose|approve|feedback/i.test(p),
      },
      {
        id: "does-not-assert-findings-real",
        why: "The prompt must not present heuristic findings as verified defects. " +
          "Round 1 refinement: fail if 'confirmed issues'/'the following defects' appear; " +
          "pass trivially if the prompt makes no claim about findings.",
        weight: 1,
        check: (p) => {
          // Hard fail: explicit assertion that findings are real/confirmed.
          if (/confirmed\s+(defect|issue|bug)|the\s+following\s+defects|verified\s+bug/i.test(p))
            return false;
          // Pass if framed as unverified, OR if the prompt makes no claim at all.
          return true;
        },
      },
      inputCoverage(),
      noHardcodedData(["specText", "findings"]),
    ],
    render: (b) =>
      `Phase 0: Spec Review\n\nReview the spec below for ambiguities, missing edge cases, and underspecified behavior.\n\n` +
      `Spec:\n${b.specText ?? ""}\n\n` +
      `Auto-generated heuristic findings (unconfirmed):\n${b.findings ?? ""}\n\n` +
      `The findings are heuristics, not confirmed defects. Check each one against the spec before relying on it, and add any you find yourself.\n\n` +
      `You CANNOT edit any files in this phase. Respond only with negotiate_propose: plan='approve' if the spec is sound, otherwise your feedback on the verified findings. After that call, stop producing tool calls.`,
  },

  // ===== Phase A — Tester =====
  {
    id: "phaseA.tester.write",
    phase: "phaseA",
    role: "tester",
    name: "promptTesterPhaseA",
    inputs: ["specPath", "workspaceRoot"],
    source: "src/languages/typescript.ts:28",
    guarantees: [
      {
        id: "writes-failing-tests",
        why: "Phase A writes the contract (failing) tests from the spec.",
        weight: 2,
        check: (p) => /test/i.test(p) && /spec|contract|behavior/i.test(p),
      },
      {
        id: "carries-spec-path",
        why: "The Tester must know which spec to read.",
        weight: 1,
        // Round 2: purely structural.
        check: (p) => /read \S+/i.test(p),
      },
      {
        id: "covers-edge-cases",
        why: "Contract tests must cover edge cases (empty, null, single).",
        weight: 1,
        check: (p) => /edge|empty|null|undefined/i.test(p),
      },
      hasTermination(),
      inputCoverage(),
      noHardcodedData(["specPath"]),
    ],
    render: (b) =>
      `You are the TESTER (Phase A). Write contract tests from the spec.\n\n` +
      `Spec: ${b.specPath ?? ""}\n` +
      `Workspace: ${b.workspaceRoot ?? ""}\n\n` +
      `Read the spec, then write Vitest tests (*.test.ts) and empty stub .ts files under the workspace. The tests define correct behavior and must fail against the stubs until the Writer implements them.\n\n` +
      `Tests must:\n- Cover every spec requirement\n- Cover edge cases: empty, undefined, null, single element\n- Use describe/it from Vitest\n\n` +
      `You CANNOT write real implementations; that is owned by the Writer. When done, stop producing tool calls.`,
  },
  {
    id: "phaseA.tester.compile-retry",
    phase: "phaseA",
    role: "tester",
    name: "promptTesterCompileRetry",
    inputs: ["compileError"],
    source: "src/languages/typescript.ts:58",
    guarantees: [
      {
        id: "carries-compile-error",
        why: "The retry must carry the SPECIFIC compile error to fix.",
        weight: 2,
        // Round 2: purely structural — the distinct-sentinel check in
        // score.ts is the primary mechanism.
        check: (p) => /compilation|error/i.test(p),
      },
      {
        id: "scoped-to-fix",
        why: "The retry fixes the error, not a rewrite.",
        weight: 1,
        check: (p) => /fix/i.test(p),
      },
      hasTermination(),
      noHardcodedData(["compileError"]),
    ],
    render: (b) =>
      `Compilation failed. Fix the compilation errors.\n\n${b.compileError ?? ""}\n\n` +
      `When done, stop producing tool calls.`,
  },
  {
    id: "phaseA.tester.dispute-fix",
    phase: "phaseA",
    role: "tester",
    name: "promptTesterDisputeFix",
    inputs: ["workspaceRoot"],
    source: "src/languages/typescript.ts:120",
    guarantees: [
      {
        id: "writes-test-only",
        why: "The Tester's dispute fix writes test files only.",
        weight: 2,
        check: (p) => /test/i.test(p) && /(only|do not modify non-test)/i.test(p),
      },
      statesRoleBoundary("non-test"),
      hasTermination(),
      noHardcodedData([]),
    ],
    render: (b) =>
      `Conceded dispute. Fix the test in *.test.ts to match the spec.\n` +
      `Do not modify non-test files. When done, stop producing tool calls.`,
  },

  // ===== Phase B — Writer =====
  {
    id: "phaseB.writer.implement",
    phase: "phaseB",
    role: "writer",
    name: "promptWriterPhaseB",
    inputs: ["workspaceRoot"],
    source: "src/languages/typescript.ts:75",
    guarantees: [
      {
        id: "implements-to-pass",
        why: "Phase B implements source to make the tests pass.",
        weight: 2,
        check: (p) => /implement|source/i.test(p) && /test/i.test(p),
      },
      {
        id: "states-test-boundary",
        why: "The Writer CANNOT edit test files. The prompt must say so (01a0d128 gap: " +
          "promptWriterPhaseB and promptNegotiateAutoAdvance currently omit this).",
        weight: 2,
        check: (p) =>
          /(cannot|can't|must not|do not|don't|may not|never|only write|only modify)[^\n.]{0,50}test/i.test(
            p,
          ),
      },
      {
        id: "names-dispute-mechanism",
        why: "The Writer must know how to dispute a wrong test (negotiate_propose). " +
          "Round 1 refinement: accept 'disagree' not just 'dispute'.",
        weight: 1,
        check: (p) => /negotiate_propose|dispute|disagree/i.test(p),
      },
      hasTermination(),
      noHardcodedData([]),
    ],
    render: (b) =>
      `Phase B (Writer). Implement the source so all tests pass.\n\n` +
      `Workspace: ${b.workspaceRoot ?? ""}\n\n` +
      `Read the *.test.ts files and the .ts stubs, then implement the logic. Preserve stub signatures. Use strict types (no any) and const declarations.\n` +
      `Run tests with \`npx vitest run\` and type-check with \`npx tsc --noEmit\`.\n\n` +
      `If a test is wrong, dispute it with negotiate_propose. If a test is correct and your code is wrong, concede with negotiate_propose(\"agree\").\n\n` +
      `You CANNOT edit test files in this phase; that is owned by the Tester. When done, stop producing tool calls.`,
  },
  {
    id: "phaseB.writer.continue",
    phase: "phaseB",
    role: "writer",
    name: "promptWriterPhaseBContinue",
    inputs: ["failureSummary", "workspaceRoot"],
    source: "src/languages/typescript.ts:86",
    guarantees: [
      {
        id: "carries-failure-summary",
        why: "The continue must carry the SPECIFIC failure summary.",
        weight: 2,
        // Round 2: purely structural.
        check: (p) => /fail/i.test(p),
      },
      statesRoleBoundary("test"),
      hasTermination(),
      inputCoverage(),
      noHardcodedData(["failureSummary"]),
    ],
    render: (b) =>
      `Phase B (Writer). Tests failed.\n\n` +
      `Workspace: ${b.workspaceRoot ?? ""}\n\n` +
      `Failure summary:\n${b.failureSummary ?? ""}\n\n` +
      `Fix the source files so the tests pass. If a test is wrong, dispute it with negotiate_propose. If a test is correct and your code is wrong, concede with negotiate_propose(\"agree\").\n\n` +
      `You CANNOT edit test files in this phase; that is owned by the Tester. When done, stop producing tool calls.`,
  },
  {
    id: "phaseB.writer.auto-advance",
    phase: "phaseB",
    role: "writer",
    name: "promptNegotiateAutoAdvance",
    inputs: ["negotiateResolution", "workspaceRoot"],
    source: "src/languages/typescript.ts:65",
    guarantees: [
      {
        id: "carries-resolution-slot",
        why: "The advance must carry the negotiated resolution (a slot filled from " +
          "state.negotiateResolution), so it isn't silently dropped (01a0d128). " +
          "Round 2: requires a label mentioning 'resolution', distinct from the " +
          "workspaceRoot slot.",
        weight: 2,
        // Round 2: require a 'resolution' label in the prompt. The
        // distinct-sentinel check in score.ts verifies the slot is present;
        // this checks it's LABELED as the resolution (not just any slot).
        check: (p) => /resolution/i.test(p),
      },
      {
        id: "states-test-boundary",
        why: "If the resolution touches tests, the Writer cannot do it — the prompt " +
          "must state the boundary (01a0d128 gap).",
        weight: 2,
        check: (p) =>
          /(cannot|can't|must not|do not|don't|may not|never|only write|only modify)[^\n.]{0,50}test/i.test(
            p,
          ),
      },
      {
        id: "routes-test-half-to-tester",
        why: "A test-file half must be routed to the Tester (the only actor who can " +
          "write tests), not left with the Writer.",
        weight: 2,
        check: (p) => /Tester/i.test(p) && /test/i.test(p),
      },
      forbidsFalseDone(),
      hasTermination(),
      inputCoverage(),
      noHardcodedData(["negotiateResolution"]),
    ],
    render: (b) =>
      `Advancing to Phase B without explicit approval. Implement the source.\n\n` +
      `Workspace: ${b.workspaceRoot ?? ""}\n\n` +
      `Negotiated resolution:\n${b.negotiateResolution ?? ""}\n\n` +
      `Read the *.test.ts files and .ts stubs, then implement the logic. Preserve stub signatures. Use strict types (no any).\n` +
      `Run tests with \`npx vitest run\` and type-check with \`npx tsc --noEmit\`.\n\n` +
      `You CANNOT edit test files in this phase; that is owned by the Tester. If the resolution requires a test-file change, do the source half and report the test half as pending the Tester. Do NOT report the work as complete while any part is pending another actor.\n\n` +
      `When done, stop producing tool calls.`,
  },

  // ===== Phase C — Cleaner =====
  {
    id: "phaseC.cleaner.refactor",
    phase: "phaseC",
    role: "cleaner",
    name: "promptCleanerPhaseC",
    inputs: ["workspaceRoot"],
    source: "src/languages/typescript.ts:95",
    guarantees: [
      {
        id: "refactors-no-behavior-change",
        why: "Phase C refactors for readability WITHOUT changing behavior.",
        weight: 2,
        check: (p) => /refactor|readab/i.test(p) && /test/i.test(p),
      },
      statesRoleBoundary("test"),
      hasTermination(),
      noHardcodedData([]),
    ],
    render: (b) =>
      `Phase C (Cleaner). Refactor source files for readability.\n` +
      `Do not modify *.test.ts. All tests must pass.\n` +
      `When done, stop producing tool calls.`,
  },
  {
    id: "phaseC.cleaner.retry",
    phase: "phaseC",
    role: "cleaner",
    name: "promptCleanerRetry",
    inputs: ["failureSummary", "workspaceRoot"],
    source: "src/languages/typescript.ts:106",
    guarantees: [
      {
        id: "carries-failure-summary",
        why: "The retry must carry the SPECIFIC failure.",
        weight: 2,
        // Round 2: purely structural.
        check: (p) => /fail/i.test(p),
      },
      statesRoleBoundary("test"),
      hasTermination(),
      inputCoverage(),
      noHardcodedData(["failureSummary"]),
    ],
    render: (b) =>
      `Phase C (Cleaner). Tests failed after your refactor.\n\n` +
      `Workspace: ${b.workspaceRoot ?? ""}\n\n` +
      `Failure summary:\n${b.failureSummary ?? ""}\n\n` +
      `Restore working behavior in the source files without changing behavior beyond what the tests expect. You CANNOT edit test files in this phase. When done, stop producing tool calls.`,
  },

  // ===== Negotiate / Dispute layer =====
  {
    id: "negotiate.writer.propose",
    phase: "negotiate",
    role: "writer",
    name: "promptWriterNegotiate",
    inputs: ["specPath", "testFilePattern"],
    source: "src/generic-prompts.ts:7",
    guarantees: [
      {
        id: "surfaces-contradictions",
        why: "The Writer must surface contradictions, not silently pick an interpretation.",
        weight: 2,
        check: (p) => /contradiction|ambigui|do not silently/i.test(p),
      },
      {
        id: "no-file-writes",
        why: "Negotiation is discussion-only — no file writes.",
        weight: 1,
        check: (p) => /do not write|no file|discussion/i.test(p),
      },
      hasTermination(),
      inputCoverage(),
      noHardcodedData(["specPath", "testFilePattern"]),
    ],
    render: (b) =>
      `WRITER (negotiation).\n\n` +
      `Spec: ${b.specPath ?? ""}\n` +
      `Test files: ${b.testFilePattern ?? ""}\n\n` +
      `Read the spec, then review the tests and understand every case. Find contradictions or ambiguities: conflicting rules, undifferentiated errors, weak assertions. Surface them in your proposal; do not silently pick an interpretation.\n\n` +
      `Call negotiate_propose: 'agree' if the tests match the spec, otherwise describe your approach (types, functions, behavior). Do NOT write files. The Tester will respond via negotiate_review.\n\n` +
      `After the negotiate_propose call, stop producing tool calls.`,
  },
  {
    id: "negotiate.tester.review-writer-dispute",
    phase: "negotiate",
    role: "tester",
    name: "promptTesterReviewWriterDispute",
    inputs: ["claim"],
    source: "src/generic-prompts.ts:85",
    guarantees: [
      {
        id: "carries-claim",
        why: "The review must carry the SPECIFIC claim being disputed.",
        weight: 2,
        // Round 2: purely structural.
        check: (p) => /disput|claim|test/i.test(p),
      },
      {
        id: "names-decisions",
        why: "The Tester must know the decision options (approve/rebut).",
        weight: 1,
        check: (p) => /approve|rebut|defend/i.test(p),
      },
      hasTermination(),
      noHardcodedData(["claim"]),
    ],
    render: (b) =>
      `TESTER (dispute review). The Writer disputed a test:\n\n${b.claim ?? ""}\n\n` +
      `Use negotiate_review: 'approve' or rebut. Do not write files.`,
  },
  {
    id: "negotiate.writer.concede-fix",
    phase: "negotiate",
    role: "writer",
    name: "promptWriterConcedeFix",
    inputs: ["claim"],
    source: "src/generic-prompts.ts:109",
    guarantees: [
      {
        id: "carries-claim",
        why: "The concede-fix must carry the SPECIFIC accepted report.",
        weight: 2,
        // Round 2: purely structural.
        check: (p) => /accept|report|claim/i.test(p),
      },
      {
        id: "source-only",
        why: "The Writer's concede fix writes source files only.",
        weight: 1,
        check: (p) => /source/i.test(p),
      },
      hasTermination(),
      noHardcodedData(["claim"]),
    ],
    render: (b) =>
      `WRITER (dispute fix). You accepted the Tester's report:\n\n${b.claim ?? ""}\n\n` +
      `Fix the flagged file(s). Write source files only. When done, stop producing tool calls.`,
  },
];

export function getEntry(id: string): PromptEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

export function entriesByPhase(phase: Phase): PromptEntry[] {
  return CATALOG.filter((e) => e.phase === phase);
}
