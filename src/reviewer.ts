// --- Phase 0: Spec Reviewer (barrel) ---
// Split (refactor step 1): implementation moved verbatim to src/reviewer/:
//   io.ts       — spec file reading + test-runner pre-flight (I/O)
//   analysis.ts — spec analysis + finding detectors (pure)
//   format.ts   — finding/addendum/summary formatting (pure)
// This barrel re-exports every original name so the module path
// "src/reviewer" (and every importer, incl. vi.mock intercepts) is unchanged.

export { readSpec, validateTestRunner } from "./reviewer/io";
export { analyzeSpec, validateSpecStructure } from "./reviewer/analysis";
export {
  formatFinding,
  buildClarificationAddendum,
  formatAddendum,
  buildSummaryTable,
} from "./reviewer/format";
