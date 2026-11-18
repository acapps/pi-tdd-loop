// --- State summary (src/types.ts split, step 5) ---
// Re-exported from src/types.ts so existing importers are unchanged.

import type { LoopState } from "./types";

export function stateSummary(s: LoopState): string {
  return `Phase ${s.phase} round ${s.round}`;
}
