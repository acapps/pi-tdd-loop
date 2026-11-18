// --- Write-loop detector (src/events/tool-call/index.ts split) ---
//
// The repeated-call breaker catches 5x identical calls. The recon breaker
// catches 15x read-only calls. But neither catches the WRITE-LOOP: the
// agent makes 187+ slightly-different write calls (node -e string-replace,
// edit with different oldText/newText) to the same file, each one
// "succeeding" (exit 0) but the test still failing. The agent is
// hammering the same approach without changing strategy.
//
// Fix: track per-turn writes per file. When the same file is written
// WRITE_LOOP_LIMIT times in a turn, block and tell the agent to stop
// hammering the same file and try a different approach.

// The named threshold constant.
export const WRITE_LOOP_LIMIT = 10;

// Verbatim user-visible notice (pinned).
export const WRITE_LOOP_NOTICE =
  "Write-loop breaker: you have written to the same file 10+ times this turn. You are hammering the same approach. Stop. Re-read the failing test output. Identify WHY the fix is not working (not just WHAT to change). If the approach is fundamentally wrong, try a different strategy. If you are stuck, say so explicitly.";

// Per-turn per-file write counter.
const writeLoopCounters = new Map<string, number>();

/** Extract the target file path from a write-like tool call.
 * Returns null if the call is not a write or the path cannot be determined. */
function extractWritePath(toolName: string, input: unknown): string | null {
  if (toolName === "write" || toolName === "edit") {
    const record =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const path = typeof record.path === "string" ? record.path : null;
    return path;
  }
  if (toolName === "bash") {
    const record =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const cmd = typeof record.command === "string" ? record.command : "";
    // node -e "...fs.writeFileSync('path'..." or node -e "...fs.readFileSync('path'..."
    // or sed -i 's/.../.../g' path
    // or echo ... > path
    // Extract the first plausible file path argument.
    // Pattern: a string that looks like a relative file path (has / or ends with a known extension).
    const pathPatterns = [
      /(?:writeFileSync|readFileSync|appendFileSync|createWriteStream|createReadStream)\s*\(\s*['"]([^'"]+\.[a-z]+)['"]/i,
      /sed\s+(?:-i\s+)?(?:'[^']*'\s+|"[^"]*"\s+)?([^\s;|&]+)/,
      /(?:>>?\s*)([\w./-]+\.[a-z]+)\s*(?:$|[;|&])/,
    ];
    for (const pattern of pathPatterns) {
      const match = cmd.match(pattern);
      if (match && match[1]) {
        const p = match[1].trim();
        // Filter out obviously non-file strings (URLs, flags, etc.)
        if (p.startsWith("-") || p.startsWith("http") || p.includes(" ")) continue;
        if (p.includes(".ts") || p.includes(".js") || p.includes(".go") || p.includes(".java") || p.includes(".json") || p.includes(".md")) {
          return p;
        }
      }
    }
    return null;
  }
  return null;
}

/** Increment the write-loop counter for a file. Returns the current count. */
export function bumpWriteLoopCounter(toolName: string, input: unknown): number | null {
  const path = extractWritePath(toolName, input);
  if (!path) return null;
  const count = (writeLoopCounters.get(path) ?? 0) + 1;
  writeLoopCounters.set(path, count);
  return count;
}

/** Clear the per-turn write-loop counters. */
export function clearWriteLoopCounters(): void {
  writeLoopCounters.clear();
}
