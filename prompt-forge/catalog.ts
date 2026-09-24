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
export const hasTermination = (): Guarantee => ({
  id: "termination-contract",
  why: "The prompt must tell the agent when to stop, so the loop can settle.",
  weight: 1,
  check: (p) => /stop producing tool calls|when done|call \w+ now|use \w+/i.test(p),
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
export const SENTINEL = "__FORGE_INPUT__";

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
        check: (p, e) => p.includes(SENTINEL) || p.length > 50, // spec slot
      },
      {
        id: "instructs-verify-heuristics",
        why: "Auto-generated findings are heuristic; the reviewer must verify, not trust.",
        weight: 2,
        check: (p) => /verify|false positive|reject/i.test(p),
      },
      {
        id: "names-mechanism",
        why: "The reviewer must know HOW to approve/reject (negotiate_propose).",
        weight: 1,
        check: (p) => /negotiate_propose|approve|feedback/i.test(p),
      },
      {
        id: "does-not-assert-findings-real",
        why: "The prompt must not present heuristic findings as verified defects.",
        weight: 1,
        check: (p) => !/confirmed defect|verified bug/i.test(p) || /candidate|heuristic|potential/i.test(p),
      },
      noHardcodedData(["specText", "findings"]),
    ],
    render: (b) =>
      `Phase 0: Spec Review\n\nReview the spec below.\n\n${b.specText ?? ""}\n\n` +
      (b.findings ? `Findings (heuristic candidates): ${b.findings}\n` : ""),
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
        check: (p) => p.includes(SENTINEL) || /read \S+/i.test(p),
      },
      {
        id: "covers-edge-cases",
        why: "Contract tests must cover edge cases (empty, null, single).",
        weight: 1,
        check: (p) => /edge|empty|null|undefined/i.test(p),
      },
      hasTermination(),
      noHardcodedData(["specPath"]),
    ],
    render: (b) =>
      `You are the TESTER. Write contract tests.\n\nRead ${b.specPath ?? ""}.\n` +
      `Write *.test.ts and stub .ts files.\n\nWhen done, stop producing tool calls.`,
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
        check: (p) => p.includes(SENTINEL),
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
        why: "The Writer must know how to dispute a wrong test (negotiate_propose).",
        weight: 1,
        check: (p) => /negotiate_propose|dispute/i.test(p),
      },
      hasTermination(),
      noHardcodedData([]),
    ],
    render: (b) =>
      `Phase B (Writer). Write source files to pass all tests.\n\n` +
      `Read *.test.ts and *.ts stubs. Implement the logic.\n` +
      `When done, stop producing tool calls.`,
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
        check: (p) => p.includes(SENTINEL),
      },
      statesRoleBoundary("test"),
      hasTermination(),
      noHardcodedData(["failureSummary"]),
    ],
    render: (b) =>
      `Phase B (Writer). Tests failed.\n\n${b.failureSummary ?? ""}\n\n` +
      `Do not modify *.test.ts. When done, stop producing tool calls.`,
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
          "state.negotiateResolution), so it isn't silently dropped (01a0d128).",
        weight: 2,
        check: (p) => p.includes(SENTINEL) || /agreed resolution/i.test(p),
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
      noHardcodedData(["negotiateResolution"]),
    ],
    render: (b) =>
      `Advancing to Phase B. Write source files.\n\n` +
      (b.negotiateResolution
        ? `Agreed resolution: ${b.negotiateResolution}\n`
        : "") +
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
        check: (p) => p.includes(SENTINEL),
      },
      statesRoleBoundary("test"),
      hasTermination(),
      noHardcodedData(["failureSummary"]),
    ],
    render: (b) =>
      `Phase C (Cleaner). Tests failed after refactoring:\n\n${b.failureSummary ?? ""}\n\n` +
      `Do not modify *.test.ts. When done, stop producing tool calls.`,
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
      noHardcodedData(["specPath", "testFilePattern"]),
    ],
    render: (b) =>
      `WRITER (negotiation).\n\nRead ${b.specPath ?? ""}. Review ${b.testFilePattern ?? ""}.\n` +
      `Surface contradictions. Use negotiate_propose. Do NOT write files.`,
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
        check: (p) => p.includes(SENTINEL),
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
        check: (p) => p.includes(SENTINEL),
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
