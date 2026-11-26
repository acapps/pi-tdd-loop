// --- spec-inventory ---
// Inventory tag validation for the two-tier contract.
//
// Spec: internal/wire-holdback-test-contract.md. Every Inventory row is tagged
// [visible] or [holdback]; the fold decides promote vs. drop from the tag, so an
// untagged Inventory row is rejected/flagged.
//
// parseInventory (src/scope-check.ts) extracts backtick-quoted Inventory paths
// but does NOT validate the [visible]/[holdback] tag — this module owns that
// check.

// Shared with src/fold.ts (imported there): an Inventory row is a backtick-
// quoted path with an optional [visible]/[holdback] tag, e.g.
//   - `test/a.test.ts` [visible]
//   - `test/b.test.ts`
export const INVENTORY_ROW = /^-\s*`([^`]+)`\s*(?:\[([^\]]+)\])?/;

/**
 * Validate that every Inventory row is tagged [visible] or [holdback].
 * Returns null when all rows are tagged, or an error message naming the first
 * untagged row's path otherwise.
 */
export function validateInventoryTags(specText: string): string | null {
  for (const line of specText.split("\n")) {
    const m = line.match(INVENTORY_ROW);
    if (!m) continue;
    const path = m[1];
    const tag = m[2];
    if (tag !== "visible" && tag !== "holdback") {
      return `Inventory row for ${path} is not tagged [visible] or [holdback].`;
    }
  }
  return null;
}
