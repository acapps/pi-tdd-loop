// Renders the REAL prompt for a catalog entry by calling the actual builder in
// src/. Shared by run.ts (baseline) and evolve.ts (evolution) so both work on
// the real prompts, not the catalog stubs. Inputs are bound to the sentinel
// (for carries-* verification) or to provided test data.

import { CATALOG, SENTINEL, type PromptEntry } from "./catalog";
import * as GP from "../src/generic-prompts";
import { buildPhaseZeroPrompt } from "../src/commands/loop";
import type { SpecAnalysis } from "../src/types";
import tsConfig from "../src/languages/typescript";

export function renderReal(entry: PromptEntry, bind?: Record<string, string>): string {
  const b: Record<string, string> = { ...(bind ?? {}) };
  for (const i of entry.inputs) if (!(i in b)) b[i] = SENTINEL;
  const p = entry.name;
  const L = tsConfig.prompts;
  switch (p) {
    case "buildPhaseZeroPrompt":
      return buildPhaseZeroPrompt(
        b.specText ?? "",
        { findings: [], reasons: ["threshold met"] } as unknown as SpecAnalysis,
      );
    case "promptTesterPhaseA":
      return L.promptTesterPhaseA(b.specPath ?? "", "vitest", b.workspaceRoot);
    case "promptTesterCompileRetry":
      return L.promptTesterCompileRetry(b.compileError ?? "");
    case "promptTesterDisputeFix":
      return L.promptTesterDisputeFix(b.workspaceRoot);
    case "promptWriterPhaseB":
      return L.promptWriterPhaseB(b.workspaceRoot);
    case "promptWriterPhaseBContinue":
      return L.promptWriterPhaseBContinue(b.failureSummary ?? "", 1, b.workspaceRoot);
    case "promptNegotiateAutoAdvance":
      return L.promptNegotiateAutoAdvance(b.workspaceRoot);
    case "promptCleanerPhaseC":
      return L.promptCleanerPhaseC(b.workspaceRoot);
    case "promptCleanerRetry":
      return L.promptCleanerRetry(b.failureSummary ?? "", 1, b.workspaceRoot);
    case "promptWriterNegotiate":
      return GP.promptWriterNegotiate(b.specPath ?? "", b.testFilePattern ?? "");
    case "promptTesterReviewWriterDispute":
      return GP.promptTesterReviewWriterDispute(b.claim ?? "");
    case "promptWriterConcedeFix":
      return GP.promptWriterConcedeFix(b.claim ?? "");
    default:
      return entry.render(b);
  }
}

export function realPromptFor(entryId: string): { entry: PromptEntry; prompt: string } | null {
  const entry = CATALOG.find((e) => e.id === entryId);
  if (!entry) return null;
  return { entry, prompt: renderReal(entry) };
}
