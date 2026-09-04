// /spec — one-shot Author command (no loop state, no gates, no phases).
// Contract: internal/spec-command.md (Phase 0 approved)
// Tests: test/spec-command.test.ts (unit) + test/extension.test.ts (command level)

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { slugBugName } from "./bug-spec";
import { readSpec } from "./reviewer";
import type { LoopState } from "./types";

// --- Types ---

export interface AuthorPromptInput {
  goal: string;
  slug: string;
  outDir: string;
  rubric: string | null;
  now: Date;
}

interface CommandContext {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  sessionManager: {
    getEntries: () => unknown[];
  };
  cwd: string;
}

// --- Pure helpers ---

/** Delegates to slugBugName (src/bug-spec.ts). Pinned: "   " → "". */
export function slugSpecName(name: string): string {
  return slugBugName(name);
}

/**
 * Normalize the output directory for display and prompt paths.
 * Pinned: "internal/" → "internal"; "internal" → "internal";
 * "backlog/" → "backlog"; "" → "".
 * (The default outDir "internal/" would otherwise render as "internal//slug.md".)
 */
export function normalizeOutDir(dir: string): string {
  return dir.replace(/\/+$/, "");
}

/**
 * Resolve the goal argument to text.
 * "" → "" (verbatim, pinned). Goal starting with "@" (strip one leading @)
 * or an existing path (same resolution order as readSpec: absolute as-is,
 * relative against cwd, then process cwd) is read as a file. Otherwise the
 * goal is returned verbatim. Returns null when a referenced file is missing.
 */
export function resolveGoal(goalArg: string, cwd: string): string | null {
  if (goalArg === "") return "";

  const file = findGoalFile(goalArg, cwd);
  if (file === null) return goalArg;
  return readSpec(file);
}

/**
 * Locate the file a goal references, or null when the goal is plain text.
 * "@x" → "x" (referenced unconditionally); otherwise an existing path —
 * raw first, then resolved against cwd (readSpec re-probes the process
 * cwd as a final fallback).
 */
function findGoalFile(goalArg: string, cwd: string): string | null {
  if (goalArg.startsWith("@")) return goalArg.slice(1);
  if (existsSync(goalArg)) return goalArg;
  const underCwd = resolve(cwd, goalArg);
  if (existsSync(underCwd)) return underCwd;
  return null;
}

/** readSpec("docs/spec-authoring.md", cwd); null when the file is missing. */
export function readRubric(cwd: string): string | null {
  return readSpec("docs/spec-authoring.md", cwd);
}

// --- Prompt rendering (pure) ---

const RUBRIC_PRESENT =
  "The template, failure classes, and filling rules live in docs/spec-authoring.md — read it first and follow it.";

const RUBRIC_ABSENT =
  "No template file is available in this repo. Follow the rules below and the standard spec\nsections: Problem, Target, Interface, Behavior, Inventory, Test Strategy, Scope lines,\nAcceptance Criteria, Dependencies, Findings log.";

const TEMPLATE_OUTLINE = [
  "# <slug>",
  "## Problem",
  "## Target",
  "## Interface",
  "## Behavior",
  "## Inventory",
  "## Test Strategy",
  "## Scope lines",
  "## Acceptance Criteria",
  "## Dependencies",
  "## Findings log",
].join("\n");

const RULES: string[] = [
  "Rules — each closes an observed spec failure class; violating one costs a review round later:",
  "1. VERIFY, don't remember. Before writing, check every file, line, function, and caller",
  "   claim against the repo NOW; re-verify after drafting. Mark line references \"as of",
  "   writing\". (class A)",
  "2. PIN VERBATIM. Every user-visible string and every order-sensitive branch goes in the",
  "   spec exactly as written in code. (classes B, F)",
  "3. CLOSE EVERY LIST. Count items, name the last, or state the grep that proves",
  "   completeness — including dead code. (class C)",
  "4. OWN EVERY BEHAVIOR. Name the module that performs each behavior and the test file",
  "   that asserts it. (classes D, E)",
  "5. PLAN THE TESTS. Per-test dispositions (kept / rewritten old→new / removed + why) and",
  "   one new test per newly pinned behavior. (class D)",
  "6. UNIT SIZING. One verb, one object, one unit. If the goal is bigger, the spec is the",
  "   first unit plus a \"Backlog\" section listing the remaining units in dependency order —",
  "   do not merge units into one spec.",
  "7. PRESERVE QUIRKS. Odd-but-current behavior goes in the quirks list marked \"current",
  "   behavior, do not fix\". (class G)",
  "8. TYPE FACTS. Pin signatures, non-exported types, union exhaustiveness; if persisted",
  "   state is touched, name the saved shape, restore path, and compatibility strategy.",
  "   (classes J, L)",
  "9. LIVE-TOOLCHAIN TESTS. Any test that spawns a real tool must state fixture",
  "   buildability, tool-absence skip, sized timeout, and verdict field — and dry-run the",
  "   fixture's commands before submitting. (class M)",
];

export function renderAuthorPrompt(input: AuthorPromptInput): string {
  return [
    "You are the AUTHOR. Write one tight, /loop-ready spec file for the goal below.",
    "",
    "Goal:",
    "---",
    input.goal,
    "---",
    "",
    `Output file: ${input.outDir}/${input.slug}.md   (create parent directories if needed)`,
    "",
    rubricSectionFor(input.rubric),
    "",
    ...RULES,
    "",
    "Write the file with exactly this shape (omit sections the template marks optional for",
    "this unit; keep the Findings log even when empty):",
    "",
    TEMPLATE_OUTLINE,
    "",
    "Self-check before finishing: every factual claim has a line number or a named observed",
    "artifact; every list is closed; every user-visible string is verbatim; every acceptance",
    "criterion names a checker that can see it.",
    "",
    `> Generated by /spec on ${input.now.toISOString()} — goal: ${stampGoalFor(input.goal)}`,
    "",
    "When the file is written, stop producing tool calls. Do not write any other file.",
  ].join("\n");
}

/** The rubric section: the pinned read-it-first line, or the fallback block. */
function rubricSectionFor(rubric: string | null): string {
  return rubric !== null ? RUBRIC_PRESENT : RUBRIC_ABSENT;
}

/** Stamp form of the goal: newlines collapsed to spaces, first 120 chars. */
function stampGoalFor(goal: string): string {
  return goal.replace(/\s*\n\s*/g, " ").slice(0, 120);
}

// --- Command ---

const USAGE = "Usage: /spec [--slug <name>] [--out <dir>] <goal...>";
const DEFAULT_OUT_DIR = "internal";

interface ParsedSpecArgs {
  slugArg: string | null;
  outDir: string;
  goalTokens: string[];
}

/**
 * Whitespace-split, mirroring parseLoopArgs style: leftmost --slug/--out
 * (space or equals form) wins; remaining non-flag tokens are the goal.
 */
function parseSpecArgs(args: string): ParsedSpecArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let slugArg: string | null = null;
  let outDir = DEFAULT_OUT_DIR;
  const goalTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--slug" && i + 1 < tokens.length) {
      slugArg = tokens[++i];
    } else if (t.startsWith("--slug=")) {
      slugArg = t.slice("--slug=".length);
    } else if (t === "--out" && i + 1 < tokens.length) {
      outDir = normalizeOutDir(tokens[++i]);
    } else if (t.startsWith("--out=")) {
      outDir = normalizeOutDir(t.slice("--out=".length));
    } else if (!t.startsWith("--")) {
      goalTokens.push(t);
    }
  }
  return { slugArg, outDir, goalTokens };
}

export function cmdSpec(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
) {
  return {
    description:
      "One-shot Author: [--slug <name>] [--out <dir>] <goal...> — writes a /loop-ready spec into the backlog (no loop state)",
    handler: async (args: string, ctx: CommandContext) => {
      const { slugArg, outDir, goalTokens } = parseSpecArgs(args);
      const goalArg = goalTokens.join(" ");

      // Row 1: no goal tokens
      if (goalTokens.length === 0) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }

      // Row 2: --slug slugifies to "" (fires before the rubric is read)
      if (slugArg !== null && slugSpecName(slugArg) === "") {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      const slug =
        slugArg !== null ? slugSpecName(slugArg) : slugSpecName(goalTokens[0]);

      // Row 3: goal references a missing file
      const goal = resolveGoal(goalArg, ctx.cwd);
      if (goal === null) {
        ctx.ui.notify(`Goal file not found: ${goalArg}`, "error");
        return;
      }

      // Row 4: rubric missing → warn (before the turn), proceed without it
      const rubric = readRubric(ctx.cwd);
      if (rubric === null) {
        ctx.ui.notify(
          "docs/spec-authoring.md not found — Author runs without the template.",
          "warning",
        );
      }

      // Row 5: happy path — one Author turn; stateless by contract
      debug(
        "spec: author turn for slug " +
          slug +
          " (loop phase: " +
          state.current.phase +
          ")",
      );
      pi.sendUserMessage(
        renderAuthorPrompt({ goal, slug, outDir, rubric, now: new Date() }),
        { triggerTurn: true },
      );
      ctx.ui.notify(
        `Author: writing ${outDir}/${slug}.md. Review it, then run /loop ${outDir}/${slug}.md`,
        "info",
      );
      ctx.ui.setStatus("loop", "spec author (one-shot — no loop state)");
    },
  };
}
