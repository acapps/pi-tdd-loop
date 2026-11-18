// --- Effect prompt builders (src/events/agent-settled/effect-applicator.ts split, step 4) ---
// Pure prompt construction for retry / advance effects. Exported (G5):
// the fallback defaults are only directly testable through an export.

import type { LoopState, GateResult } from "../../types";
import { getWorkspaceRoot } from "../../types";
import type { LanguageConfig } from "../../languages";
import * as GP from "../../generic-prompts";
import { RETRY_PROMPTS, ADVANCE_PROMPTS } from "../../constants";
import { formatFailures } from "../../gates";

export function buildRetryPrompt(
  promptType: string,
  lang: LanguageConfig,
  gateResult: GateResult,
  state?: LoopState,
): string {
  const failures = gateResult.failures;
  const summary = formatFailures(failures);
  const count = failures.length;
  const ws = state ? getWorkspaceRoot(state.specPath) : undefined;

  switch (promptType) {
    case RETRY_PROMPTS.TESTER_COMPILE_RETRY:
    case RETRY_PROMPTS.TESTER_DISPUTE_FIX_COMPILE_FAIL:
      return lang.prompts.promptTesterCompileRetry(gateResult.compileError);
    case RETRY_PROMPTS.TESTER_ZERO_TEST_RETRY:
      return lang.prompts.promptTesterZeroTestRetry();
    case RETRY_PROMPTS.WRITER_PHASE_B_RETRY:
    case RETRY_PROMPTS.WRITER_DISPUTE_FIX_INCOMPLETE:
      return lang.prompts.promptWriterPhaseBContinue(summary, count, ws);
    case RETRY_PROMPTS.CLEANER_RETRY:
      return lang.prompts.promptCleanerRetry(summary, count, ws);
    default:
      return "Fix the issues and try again.";
  }
}

// fix-negotiated-resolution-dropped: boundary language appended to the Phase B
// prompt when a negotiated resolution names a test-file change. Instructs the
// Writer to implement the source half, leave the test half to the Tester, and
// not claim completion while the test half is outstanding.
function RESOLUTION_BLOCK(resolution: string): string {
  return `\n\nNegotiated resolution:\n${resolution}\n\nImplement the source half of the resolution. Do not modify test files — test files are owned by the Tester. If the resolution requires test changes, implement the source half and report the test half as pending the Tester. Do not claim the resolution is complete if the test half is outstanding.`;
}

export function buildAdvancePrompt(
  promptType: string,
  state: LoopState,
  lang: LanguageConfig,
): string {
  const ws = getWorkspaceRoot(state.specPath);
  switch (promptType) {
    case ADVANCE_PROMPTS.WRITER_NEGOTIATE:
      return GP.promptWriterNegotiate(state.specPath, lang.testFilePattern);
    case ADVANCE_PROMPTS.WRITER_PHASE_B: {
      const base = lang.prompts.promptWriterPhaseB(ws);
      // fix-negotiated-resolution-dropped: carry the agreed resolution into
      // the Phase B prompt with boundary language so the Writer knows what
      // was agreed and what it can/can't do.
      if (!state.negotiateResolution) return base;
      return base + RESOLUTION_BLOCK(state.negotiateResolution);
    }
    case ADVANCE_PROMPTS.CLEANER_PHASE_C:
      return lang.prompts.promptCleanerPhaseC(ws);
    default:
      return promptType;
  }
}
