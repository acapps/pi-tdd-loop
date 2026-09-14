// /loop-debug — internal/refactor-commands-split.md
//
// cmdDebug + the log-bug sub-command: parseLogBugArgs, showDebugLog,
// runLogBug, notifyBugSpecResult, SessionEntry, DEBUG_LOG_TYPES,
// isDebugLogEntry, entryTimestamp, extractDebugLogs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandContext, LoopState } from "../types";
import type { DebugFn } from "../events";
import {
  slugBugName, extractLoopLogs, renderBugSpec, writeBugSpec,
} from "../bug-spec";

export function cmdDebug(
  state: { current: LoopState },
  debug: DebugFn,
) {
  return {
    description: "Show loop debug log",
    handler: async (args: string, ctx: CommandContext) => {
      const parsed = parseLogBugArgs(args);
      if (parsed === null) {
        showDebugLog(ctx);
        return;
      }
      runLogBug(state, debug, ctx, parsed.name);
    },
  };
}

export function parseLogBugArgs(args: string): { name: string } | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--log-bug") {
      const nameTokens: string[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].startsWith("--")) break;
        nameTokens.push(tokens[j]);
      }
      return { name: nameTokens.join(" ") };
    }
    if (tokens[i].startsWith("--log-bug=")) {
      return { name: tokens[i].slice("--log-bug=".length) };
    }
  }
  return null;
}

export function showDebugLog(ctx: CommandContext): void {
  const logs = extractDebugLogs(ctx.sessionManager.getEntries());
  ctx.ui.notify(
    `Loop debug (${logs.length} entries):\n${logs.slice(-20).join("\n")}`,
    "info",
  );
}

export function runLogBug(
  state: { current: LoopState },
  debug: DebugFn,
  ctx: CommandContext,
  name: string,
): void {
  const slug = slugBugName(name);
  if (slug === "") {
    ctx.ui.notify("Usage: /loop-debug --log-bug <name>", "warning");
    return;
  }

  const markdown = renderBugSpec({
    name,
    slug,
    phase: state.current.phase,
    round: state.current.round,
    specPath: state.current.specPath,
    language: state.current.language,
    lines: extractLoopLogs(ctx.sessionManager.getEntries()),
    now: new Date(),
  });
  notifyBugSpecResult(ctx, debug, writeBugSpec(ctx.cwd, slug, markdown), slug);
}

export function notifyBugSpecResult(
  ctx: CommandContext,
  debug: DebugFn,
  result: ReturnType<typeof writeBugSpec>,
  slug: string,
): void {
  if (result.ok) {
    debug(`log-bug: wrote ${result.path}`);
    ctx.ui.notify(
      `Wrote bug-fix-${slug}.md\nNext: fill in Observed problem / Proposed fix, then /loop bug-fix-${slug}.md`,
      "info",
    );
    return;
  }
  if (result.reason === "exists") {
    ctx.ui.notify(`bug-fix-${slug}.md already exists. Pick a different name.`, "error");
    return;
  }
  ctx.ui.notify(`Failed to write bug-fix-${slug}.md: ${result.message}`, "error");
}

export interface SessionEntry {
  type?: unknown;
  customType?: unknown;
  timestamp?: unknown;
  data?: { ts?: unknown } | null;
}

export const DEBUG_LOG_TYPES = new Set([
  "loop-debug",
  "loop-gate",
  "loop-refusal",
  "loop-negotiate",
  "loop-dispute",
]);

export function isDebugLogEntry(entry: SessionEntry): entry is SessionEntry & { customType: string } {
  return entry.type === "custom" && typeof entry.customType === "string" && DEBUG_LOG_TYPES.has(entry.customType);
}

export function entryTimestamp(entry: SessionEntry): string {
  const dataTs = entry.data?.ts;
  if (typeof dataTs === "number") return new Date(dataTs).toISOString();
  if (typeof entry.timestamp === "string") return entry.timestamp;
  return "-";
}

export function extractDebugLogs(entries: unknown[]): string[] {
  return entries
    .map((e) => e as SessionEntry)
    .filter(isDebugLogEntry)
    .map((entry) => `[${entryTimestamp(entry)}] ${entry.customType}: ${JSON.stringify(entry).slice(0, 120)}`);
}
