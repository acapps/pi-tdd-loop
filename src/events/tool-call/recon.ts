// --- Reconnaissance detector (src/events/tool-call/index.ts split) ---
//
// The exact-match breaker above catches 5x identical calls. But the agent
// can vary its commands slightly (different sed ranges, different grep
// patterns) to evade it. The reconnaissance detector tracks the *category*
// of calls: if the agent makes RECON_READ_LIMIT read-only calls (read,
// grep, bash commands that are pure reads) without any write/edit calls,
// it blocks further read-only calls and tells the agent to act.

// The named threshold constant.
export const RECON_READ_LIMIT = 15;

// Verbatim user-visible notice (pinned).
export const RECON_NOTICE =
  "Reconnaissance breaker: you have made 15+ read-only calls without writing anything. Stop reading. Act on what you have: call negotiate_propose (negotiate phase), write your tests (Phase A), or write your implementation (Phase B). If you are stuck, say why in your next message.";

// Per-turn reconnaissance state.
let reconReadCount = 0;

/**
 * Classify a tool call as read-only (reconnaissance) or write (action).
 * Read-only: read, grep, find, ls, and bash commands that are pure reads.
 * Write: write, edit, and bash commands with write actions.
 */
function isReadOnlyCall(toolName: string, input: unknown): boolean {
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
    return true;
  }
  if (toolName === "write" || toolName === "edit") return false;
  if (toolName === "bash") {
    const record =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const cmd = typeof record.command === "string" ? record.command : "";
    // Write actions in bash: git commit/push/add, file writes, test runs
    const writePatterns =
      /^(git\s+(commit|push|add|checkout|reset|merge|rebase)|npx\s|node\s|npm\s|yarn\s|pnpm\s|make\s|go\s|mvn\s|cargo\s|echo\s)/;
    if (writePatterns.test(cmd)) return false;
    // Multi-command: if any part is a write, it's not read-only
    const parts = cmd.split(";").map((p) => p.trim());
    if (parts.some((p) => writePatterns.test(p))) return false;
    // Pure read: sed, grep, rg, cat, ls, wc, head, tail, git status/log/diff/show, find
    const readPatterns =
      /^(sed\s|grep\s|rg\s|cat\s|ls\s|wc\s|head\s|tail\s|git\s+(status|log|diff|show|branch|stash|remote)|find\s)/;
    if (parts.every((p) => readPatterns.test(p) || p === "")) return true;
    return false;
  }
  // Unknown tools: not read-only (conservative)
  return false;
}

/**
 * Increment the reconnaissance read counter. Any non-read-only call resets
 * the counter (the agent acted, so it's no longer in a read loop). Returns
 * the current count.
 */
export function bumpReconCounter(toolName: string, input: unknown): number {
  if (isReadOnlyCall(toolName, input)) {
    reconReadCount++;
  } else {
    reconReadCount = 0;
  }
  return reconReadCount;
}

/** Clear the per-turn reconnaissance counter. */
export function resetReconCounters(): void {
  reconReadCount = 0;
}
