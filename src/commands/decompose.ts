// /loop-decompose — internal/refactor-commands-split.md
//
// cmdDecompose + helpers: parseDecomposeArgs, derivePrefix,
// buildDecomposePrompt.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState } from "../types";
import type { DebugFn } from "../events";
import { sendPrompt } from "../prompt";
import { resolveExistingSpec } from "../spec-path";
import { normalizeSpecPath } from "../selectors";
import { parseTokens } from "../args";

interface DecomposeArgs {
  specPath: string;
  outDir: string;
  prefix: string;
}

export function parseDecomposeArgs(args: string): DecomposeArgs {
  const { flags, positional } = parseTokens(args);
  return {
    specPath: normalizeSpecPath(positional[0] ?? ""),
    outDir: flags.get("out") ?? "internal",
    prefix: flags.get("prefix") ?? "",
  };
}

export function derivePrefix(specPath: string): string {
  const basename = specPath.split("/").pop()?.replace(/\.md$/, "") ?? "spec";
  return basename.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

export function buildDecomposePrompt(specPath: string, outDir: string, prefix: string): string {
  return `Read the spec at ${specPath}. Break it into independently-testable units.
Each unit must:
1. Be implementable and testable in a single /loop run
2. Have a clear, self-contained scope (no "and other related things")
3. Reference the parent spec and its position in the sequence
4. Include all required sections: Target, Behavior, Inventory, Test Strategy, Scope lines, Acceptance Criteria, Dependencies, Findings log

Write each unit as ${outDir}/${prefix}-<N>.md.
Write a summary at ${outDir}/${prefix}-index.md with the table above.

Rules:
- Maximum 5 units. If the spec needs more, group related endpoints/features.
- Each unit's "Dependencies" section lists the units it depends on.
- The last unit may be an "integration" unit that tests the whole system.
- Do NOT modify the parent spec.`;
}

export function cmdDecompose(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return {
    description: "Decompose a spec into sub-specs: <spec-path> [--out <dir>] [--prefix <slug>]",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseDecomposeArgs(args);

      if (!parsed.specPath) {
        ctx.ui.notify("Usage: /loop-decompose <spec-path> [--out <dir>] [--prefix <slug>]", "warning");
        return;
      }

      if (resolveExistingSpec(parsed.specPath, ctx.cwd) === null) {
        ctx.ui.notify(`Spec not found: ${parsed.specPath}`, "error");
        return;
      }

      const prefix = parsed.prefix || derivePrefix(parsed.specPath);

      debug(`Command: /loop-decompose ${parsed.specPath} → ${parsed.outDir}/${prefix}-*`);
      ctx.ui.notify(`Decomposing ${parsed.specPath} into ${parsed.outDir}/${prefix}-* ...`, "info");
      ctx.ui.setStatus("loop", `decomposing: ${parsed.specPath}`);

      sendPrompt(pi, buildDecomposePrompt(parsed.specPath, parsed.outDir, prefix), state.current, debug);
    },
  };
}
