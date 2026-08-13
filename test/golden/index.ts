// --- Golden E2E Harness — Public API ---

// Types
export type {
  GateScenario,
  MetricThreshold,
  MetricThresholds,
  RoundsByPhaseThresholds,
  AssertionFailure,
  AssertionResult,
  Scorecard,
  RunComparisonResult,
  ComparisonDiff,
  ToleranceConfig,
  TestRunner,
  GateOutcome,
  GateResultSequence,
} from "./types";

// Scenarios
export { scenarios } from "./scenarios";

// Runner (implemented)
export {
  runScenario,
  assertMetrics,
  compareRuns,
  createRunner,
  run,
  buildScorecard,
  saveScorecard,
  loadBaseline,
  compareAgainstBaseline,
} from "./runner";

// Score computation
export {
  computeScore,
  formatScoreReport,
  compareScores,
} from "./score";
export type {
  SubScores,
  ScoreResult,
  ScoreDetail,
} from "./score";

// Fixtures
export {
  makeGatePass,
  makeGateCompileFail,
  makeGateTestFail,
  makeGateCoverageFail,
  makeMetrics,
  makeGateSequence,
  checkThreshold,
  makeAssertionResult,
  thresholdsHappyPath,
  thresholdsBRetry,
  thresholdsEscalation,
  thresholdsDispute,
} from "./fixtures";
