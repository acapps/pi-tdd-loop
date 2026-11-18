// /spec — one-shot Author command (no loop state, no gates, no phases).
// Contract: internal/spec-command.md (Phase 0 approved)
// Tests: test/spec-command.test.ts (unit) + test/extension.test.ts (command level)
//
// Split (refactor step 3): prompt rendering → src/spec-author.ts (pure);
// file I/O → src/spec-io.ts. This module keeps the command factory +
// arg parsing and re-exports every original name so importers (and
// vi.mock intercepts on "src/spec-command") are unchanged.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { slugBugName } from "./bug-spec";
import { sendPrompt } from "./prompt";
import type { LoopState } from "./types";
import { normalizeOutDir, resolveGoal, readRubric } from "./spec-io";
import { renderAuthorPrompt, type AuthorPromptInput } from "./spec-author";

export { normalizeOutDir, resolveGoal, readRubric } from "./spec-io";
export { renderAuthorPrompt, type AuthorPromptInput } from "./spec-author";

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

/** Row 4: rubric missing → warn (before the turn), proceed without it. */
function startAuthorTurn(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: (msg: string) => void,
  ctx: CommandContext,
  input: { goal: string; slug: string; outDir: string; rubric: string | null },
): void {
  if (input.rubric === null) {
    ctx.ui.notify(
      "docs/spec-authoring.md not found — Author runs without the template.",
      "warning",
    );
  }

  // Row 5: happy path — one Author turn; stateless by contract
  debug(
    "spec: author turn for slug " +
      input.slug +
      " (loop phase: " +
      state.current.phase +
      ")",
  );
  sendPrompt(
    pi,
    renderAuthorPrompt({ ...input, now: new Date() }),
    state.current,
    debug,
  );
  ctx.ui.notify(
    `Author: writing ${input.outDir}/${input.slug}.md. Review it, then run /loop ${input.outDir}/${input.slug}.md`,
    "info",
  );
  ctx.ui.setStatus("loop", "spec author (one-shot — no loop state)");
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

      const rubric = readRubric(ctx.cwd);
      startAuthorTurn(state, pi, debug, ctx, { goal, slug, outDir, rubric });
    },
  };
}
