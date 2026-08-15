// --- Event handlers ---

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState, Phase } from "./types";
import { runGates, formatFailures } from "./gates";
import * as GP from "./generic-prompts";
import * as T from "./transitions";
import { getLanguageConfig } from "./languages";
import { RETRY_PROMPTS, ADVANCE_PROMPTS, REPROMPT_KEYS } from "./constants";
import { handleSessionStart } from "./events/session-start";

// --- Types ---

interface EventCtx {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string) => void;
  };
  sessionManager: {
    getEntries: () => unknown[];
  };
  cwd: string;
}

type DebugFn = (msg: string) => void;

// --- Helpers ---

function stateSummary(s: LoopState): string {
  return `Phase ${s.phase} round ${s.round}`;
}

function getLang(state: LoopState) {
  return getLanguageConfig(state.language);
}

// --- session_start ---

export function eventSessionStart(
  state: { current: LoopState },
  _pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (_event: unknown, ctx: EventCtx) => {
    handleSessionStart({ state, ctx, debug });
  };
}

// --- before_agent_start ---

export function eventBeforeAgentStart(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (event: unknown) => {
    if (state.current.phase === "idle") return undefined;
    const evt = event as { systemPrompt: string };
    return buildPhasePrompt(state, pi, debug, evt.systemPrompt);
  };
}

function buildPhasePrompt(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
  systemPrompt: string,
): { message: Record<string, unknown>; systemPrompt: string } | undefined {
  const lang = getLang(state.current);
  const phase = state.current.phase as Phase;

  switch (phase) {
    case "review": return buildReviewPrompt(lang, systemPrompt);
    case "A": return buildTesterPrompt(lang, systemPrompt);
    case "negotiate": return buildNegotiatePrompt(state.current, debug, systemPrompt);
    case "B": return buildWriterPrompt(state, pi, lang, debug, systemPrompt);
    case "C": return buildCleanerPrompt(lang, state.current, systemPrompt);
    default: return undefined;
  }
}

function buildContextMessage(content: string): Record<string, unknown> {
  return { customType: "loop-context", content, display: false };
}

function buildReviewPrompt(
  lang: ReturnType<typeof getLanguageConfig>,
  systemPrompt: string,
): { message: Record<string, unknown>; systemPrompt: string } {
  return {
    message: buildContextMessage(
      `REVIEWER (Phase 0). Review the spec for ambiguities and missing edge cases.\n` +
      `Use negotiate_propose with plan='approve' to proceed, or provide feedback.\n` +
      `No file writes.`,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase 0 (Reviewer). Review the spec. Use negotiate_propose. No file writes.`,
  };
}

function buildTesterPrompt(
  lang: ReturnType<typeof getLanguageConfig>,
  systemPrompt: string,
): { message: Record<string, unknown>; systemPrompt: string } {
  return {
    message: buildContextMessage(
      `TESTER. Write contract: ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs.\nStop when done.`,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase A (Tester). Write ${lang.testFilePattern} and ${lang.sourceFilePattern} stubs.`,
  };
}

function buildNegotiatePrompt(
  state: LoopState,
  debug: DebugFn,
  systemPrompt: string,
): { message: Record<string, unknown>; systemPrompt: string } {
  const isWriterTurn = state.round % 2 === 1;
  if (isWriterTurn) {
    debug(`Negotiate round ${state.round} (Writer)`);
    return {
      message: buildContextMessage(
        `WRITER (negotiate). Use negotiate_propose. No file writes.\nplan='agree' if tests match spec. plan='your approach' otherwise.`,
      ),
      systemPrompt: `${systemPrompt}\n\nNegotiation. Use negotiate_propose tool. No file writes.`,
    };
  }
  debug(`Negotiate round ${state.round} (Tester)`);
  return {
    message: buildContextMessage(
      `TESTER (negotiate). Use negotiate_review. No file writes.\n'approve' if accept. feedback otherwise.`,
    ),
    systemPrompt: `${systemPrompt}\n\nNegotiation. Use negotiate_review tool. No file writes.`,
  };
}

function buildWriterPrompt(
  state: { current: LoopState },
  pi: ExtensionAPI,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  systemPrompt: string,
): { message: Record<string, unknown>; systemPrompt: string } {
  if (state.current.awaitDisputeFix) {
    return buildDisputeFixPrompt(state, pi, debug, systemPrompt);
  }
  debug(`Writer round ${state.current.round}`);
  return {
    message: buildContextMessage(
      `WRITER. Write ${lang.sourceFilePattern} to pass ${lang.testFilePattern}.\n` +
      `Preserve stub signatures. Dispute wrong tests via negotiate_propose.\n` +
      "When done, stop producing tool calls.",
    ),
    systemPrompt: `${systemPrompt}\n\nPhase B (Writer), round ${state.current.round}. Write ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.`,
  };
}

function buildDisputeFixPrompt(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
  systemPrompt: string,
): { message: Record<string, unknown>; systemPrompt: string } {
  debug("Tester fixing test");
  state.current.awaitDisputeFix = false;
  pi.appendEntry("loop-state", { ...state.current });
  return {
    message: buildContextMessage(
      "You are the TESTER (dispute fix). You conceded that the Writer's dispute was valid.\n" +
      "Fix the test(s) to match the spec.\n" +
      "After fixing, stop producing tool calls.",
    ),
    systemPrompt: `${systemPrompt}\n\nYou are in Phase B dispute fix (Tester). You may write test files.`,
  };
}

function buildCleanerPrompt(
  lang: ReturnType<typeof getLanguageConfig>,
  state: LoopState,
  systemPrompt: string,
): { message: Record<string, unknown>; systemPrompt: string } {
  return {
    message: buildContextMessage(
      "CLEANER. Refactor for readability:\n" +
      "- Return early. Extract helpers. Clear names.\n" +
      `You may only write ${lang.sourceFilePattern}. Do not modify ${lang.testFilePattern}. All tests must pass.`,
    ),
    systemPrompt: `${systemPrompt}\n\nPhase C (Cleaner), round ${state.round}. Refactor ${lang.sourceFilePattern} only. Do not modify ${lang.testFilePattern}.`,
  };
}

// --- tool_call (path enforcement) ---

export function eventToolCall(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (event: unknown, ctx: EventCtx) => {
    if (state.current.phase === "escalated") return undefined;
    const evt = event as { toolName: string; input: Record<string, string> };
    const lang = getLang(state.current);
    const path = extractToolPath(evt);

    // Block all tool calls during dispute review (Writer must stop)
    if (state.current.awaitDisputeReview) {
      debug(`Blocked: ${evt.toolName} (awaiting dispute review)`);
      return { block: true, reason: "Dispute filed. Waiting for Tester review. STOP producing tool calls." };
    }

    if (shouldBlockDispute(state.current, path, lang, debug, pi)) {
      return { block: true, reason: lang.refusalMessage.phaseC };
    }
    if (shouldBlockNegotiate(state.current, evt, debug, pi, lang)) {
      return { block: true, reason: lang.refusalMessage.negotiate };
    }
    if (shouldBlockPhaseA(state.current, path, evt, lang, debug, pi, ctx)) {
      return { block: true, reason: lang.refusalMessage.phaseA };
    }
    return checkPhaseBCWrite(state.current, path, evt, lang, debug, pi, ctx);
  };
}

function extractToolPath(evt: { input: Record<string, string> }): string {
  return evt.input.path as string;
}

function isProjectPath(path: string, cwd: string): boolean {
  const full = path.startsWith("/") ? path : cwd + "/" + path;
  return full.startsWith(cwd + "/");
}

function isWriteAction(evt: { toolName: string }): boolean {
  return evt.toolName === "write" || evt.toolName === "edit";
}

function shouldBlockDispute(
  state: LoopState,
  path: string,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  pi: ExtensionAPI,
): boolean {
  if (!state.disputeMode) return false;
  if (!path || lang.isTestFile(path)) return false;
  debug(`Blocked: ${path} (dispute mode, not test file)`);
  pi.appendEntry("loop-refusal", { phase: "B-dispute", path, tool: "write" });
  return true;
}

function shouldBlockNegotiate(
  state: LoopState,
  evt: { toolName: string },
  debug: DebugFn,
  pi: ExtensionAPI,
  lang: ReturnType<typeof getLanguageConfig>,
): boolean {
  if (state.phase !== "negotiate") return false;
  if (!isWriteAction(evt)) return false;
  debug(`Blocked: ${evt.toolName} (negotiate phase, discussion only)`);
  pi.appendEntry("loop-refusal", { phase: "negotiate", tool: evt.toolName });
  return true;
}

function shouldBlockPhaseA(
  state: LoopState,
  path: string,
  evt: { toolName: string },
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  pi: ExtensionAPI,
  ctx: EventCtx,
): boolean {
  if (state.phase !== "A") return false;
  if (!isWriteAction(evt)) return false;
  if (!isProjectPath(path, ctx.cwd)) return false;
  if (lang.isPhaseAAllowed(path)) return false;
  debug(`Blocked: ${evt.toolName} ${path} (phase A, not allowed)`);
  pi.appendEntry("loop-refusal", { phase: "A", path, tool: evt.toolName });
  return true;
}

function checkPhaseBCWrite(
  state: LoopState,
  path: string,
  evt: { toolName: string },
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  pi: ExtensionAPI,
  ctx: EventCtx,
): { block: true; reason: string } | undefined {
  if (state.phase !== "B" && state.phase !== "C") return undefined;
  if (state.disputeMode) return undefined;
  if (!isWriteAction(evt)) return undefined;
  if (!isProjectPath(path, ctx.cwd)) return undefined;
  if (!path || !lang.isTestFile(path)) return undefined;

  debug(`Blocked: ${evt.toolName} ${path} (phase ${state.phase}, is test file)`);
  pi.appendEntry("loop-refusal", {
    phase: state.phase,
    path,
    tool: evt.toolName,
  });
  return { block: true, reason: lang.refusalMessage.phaseC };
}

// --- agent_settled (phase transitions) ---

export function eventAgentSettled(
  state: { current: LoopState },
  pi: ExtensionAPI,
  debug: DebugFn,
) {
  return async (_event: unknown, ctx: EventCtx) => {
    if (isTerminalPhase(state.current.phase)) return undefined;
    const lang = getLang(state.current);

    if (checkLoopEscalation(state, ctx, debug)) return undefined;
    if (handleJustTransitioned(state, pi, lang, debug)) return undefined;
    if (handleDisputeFix(state, pi, lang, ctx)) return undefined;
    if (handleDisputeReview(state, pi, lang, debug, ctx)) return undefined;
    if (state.current.phase === "review") {
      return handleReviewSettled(state, pi, ctx, lang, debug);
    }
    if (state.current.phase === "negotiate") {
      return handleNegotiateSettled(state, pi, ctx, lang, debug);
    }
    return handleGateTransition(state, pi, ctx, lang, debug);
  };
}

function isTerminalPhase(phase: string): boolean {
  return phase === "idle" || phase === "done" || phase === "escalated";
}

function checkLoopEscalation(
  state: { current: LoopState },
  ctx: EventCtx,
  debug: DebugFn,
): boolean {
  state.current.turnsThisPhase = (state.current.turnsThisPhase || 0) + 1;
  const maxTurns = state.current.maxTurnsPerPhase || 5;
  if (state.current.turnsThisPhase <= maxTurns) return false;

  debug(`Loop detected (${state.current.turnsThisPhase} turns in phase ${state.current.phase}), escalating`);
  state.current.lastPhase = state.current.phase;
  state.current.phase = "escalated";
  ctx.ui.notify(`Loop detected in Phase ${state.current.lastPhase}. Escalating to human.`, "warning");
  ctx.ui.setStatus("loop", "escalated (loop detected)");
  return true;
}

function handleReviewSettled(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
): boolean {
  if (!state.current.awaitingReview) return false;

  debug("Phase 0 review: agent settled, awaiting human /loop-approve");
  // Don't advance — wait for human to use /loop-approve or negotiate_propose
  ctx.ui.notify("Phase 0: Review findings. Use /loop-approve to proceed.", "info");
  ctx.ui.setStatus("loop", "Phase 0 — review pending");
  pi.appendEntry("loop-state", { ...state.current });
  return true;
}

function handleJustTransitioned(
  state: { current: LoopState },
  pi: ExtensionAPI,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
): boolean {
  if (!state.current.justTransitioned) return false;
  debug(`agent_settled: justTransitioned → clearing & triggering turn (${stateSummary(state.current)})`);
  state.current.justTransitioned = false;

  if (state.current.phase === "B" && state.current.round === 1) {
    debug("agent_settled: triggering Phase B Writer turn");
    pi.sendUserMessage(lang.prompts.promptNegotiateApproved(), { triggerTurn: true });
  }
  return true;
}

function handleDisputeFix(
  state: { current: LoopState },
  pi: ExtensionAPI,
  lang: ReturnType<typeof getLanguageConfig>,
  ctx: EventCtx,
): boolean {
  if (!state.current.awaitDisputeFix) return false;
  ctx.ui.setStatus("loop", `Phase B — round ${state.current.round} (dispute fix)`);
  pi.sendUserMessage(lang.prompts.promptTesterDisputeFix(), { triggerTurn: true });
  return true;
}

function handleDisputeReview(
  state: { current: LoopState },
  pi: ExtensionAPI,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  ctx: EventCtx,
): boolean {
  if (!state.current.awaitDisputeReview) return false;
  // Don't clear the flag yet — keep blocking tool calls until gate runs
  debug(`Dispute review pending`);
  pi.appendEntry("loop-state", { ...state.current });
  ctx.ui.setStatus("loop", `Phase B — round ${state.current.round} (dispute review)`);
  return false; // Fall through to gate
}

function handleNegotiateSettled(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
): boolean {
  debug(`Negotiate: agent didn't use tool (reprompted=${state.current.negotiateReprompted}, round ${state.current.round})`);
  const { state: newState, effect } = T.computeNegotiateTransition(state.current);
  state.current = newState;

  if (effect.type === "reprompt") {
    ctx.ui.notify(effect.notify, effect.level);
    const prompt = effect.prompt === REPROMPT_KEYS.WRITER
      ? GP.promptNegotiateRepromptWriter()
      : GP.promptNegotiateRepromptTester();
    pi.sendUserMessage(prompt, { triggerTurn: true });
  } else if (effect.type === "advance") {
    debug("Negotiate: auto-advancing to Phase B");
    ctx.ui.notify(effect.notify, "info");
    ctx.ui.setStatus("loop", effect.status);
    pi.sendUserMessage(lang.prompts.promptNegotiateAutoAdvance(), { triggerTurn: true });
  }
  return true;
}

function handleGateTransition(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
): boolean {
  const gateResult = runGates(
    ctx.cwd,
    state.current.coverageThreshold,
    state.current.language,
    state.current.buildTool,
    state.current.phase,
  );

  logGateResult(debug, state.current, gateResult);
  const { state: newState, effect } = T.computeTransition(state.current, gateResult);
  state.current = newState;
  state.current.lastGateResult = gateResult;
  debug(`→ ${effect.type} (${stateSummary(state.current)})`);

  return applyEffect(state, pi, ctx, lang, debug, effect, gateResult);
}

function logGateResult(
  debug: DebugFn,
  state: LoopState,
  gateResult: ReturnType<typeof runGates>,
): void {
  const status = gateResult.allPassed
    ? "pass"
    : gateResult.tests
      ? `pass (${gateResult.failures.length} failures)`
      : `fail (${gateResult.failures.length} failures)`;
  debug(`Gate ${status} [compile=${gateResult.compile} tests=${gateResult.tests} cov=${gateResult.coverage}%]`);
}

function applyEffect(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  effect: ReturnType<typeof T.computeTransition>["effect"],
  gateResult: ReturnType<typeof runGates>,
): boolean {
  switch (effect.type) {
    case "noop":
      return false;
    case "retry":
      return handleRetryEffect(state, pi, ctx, lang, debug, effect, gateResult);
    case "advance":
      return handleAdvanceEffect(state, pi, ctx, lang, debug, effect);
    case "done":
      return handleDoneEffect(state, pi, ctx, debug, effect);
    case "escalated":
      return handleEscalatedEffect(state, pi, ctx, debug, effect);
    default:
      return false;
  }
}

function handleRetryEffect(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  effect: { type: "retry"; phase: string; round: number; notify?: string; level?: string; status: string; prompt?: string },
  gateResult: { compile: boolean; compileError: string; failures: Array<{ test: string; subtest: string; output: string }> },
): boolean {
  state.current.turnsThisPhase = 1;

  // If dispute review was pending, inject the dispute prompt and clear the flag
  if (state.current.awaitDisputeReview) {
    state.current.awaitDisputeReview = false;
    debug(`Dispute review → retry with prompt`);
    pi.sendUserMessage(GP.promptWriterDispute(state.current.lastProposal), { triggerTurn: true });
    return true;
  }

  debug(`Retry ${effect.phase} round ${effect.round}`);
  ctx.ui.setStatus("loop", effect.status);
  if (effect.notify) {
    ctx.ui.notify(effect.notify, effect.level || "info");
  }
  if (effect.prompt) {
    const prompt = buildRetryPrompt(effect.prompt, lang, gateResult);
    pi.sendUserMessage(prompt, { triggerTurn: true });
  }
  return true;
}

function buildRetryPrompt(
  promptType: string,
  lang: ReturnType<typeof getLanguageConfig>,
  gateResult: { compile: boolean; compileError: string; failures: Array<{ test: string; subtest: string; output: string }> },
): string {
  const failures = gateResult.failures;
  const summary = formatFailures(failures);
  const count = failures.length;

  switch (promptType) {
    case RETRY_PROMPTS.TESTER_COMPILE_RETRY:
      return lang.prompts.promptTesterCompileRetry(gateResult.compileError);
    case RETRY_PROMPTS.WRITER_PHASE_B_RETRY:
      return lang.prompts.promptWriterPhaseBContinue(summary, count);
    case RETRY_PROMPTS.CLEANER_RETRY:
      return lang.prompts.promptCleanerRetry(summary, count);
    case RETRY_PROMPTS.WRITER_DISPUTE_FIX_INCOMPLETE:
      return lang.prompts.promptWriterPhaseBContinue(summary, count);
    case RETRY_PROMPTS.TESTER_DISPUTE_FIX_COMPILE_FAIL:
      return lang.prompts.promptTesterCompileRetry(gateResult.compileError);
    default:
      return "Fix the issues and try again.";
  }
}

function handleAdvanceEffect(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  lang: ReturnType<typeof getLanguageConfig>,
  debug: DebugFn,
  effect: { type: "advance"; phase: string; notify: string; status: string; prompt?: string },
): boolean {
  state.current.turnsThisPhase = 1;
  debug(`Advance → ${effect.phase}`);

  ctx.ui.notify(effect.notify, "info");
  ctx.ui.setStatus("loop", effect.status);
  if (effect.prompt) {
    const prompt = buildAdvancePrompt(effect.prompt, state, lang);
    pi.sendUserMessage(prompt, { triggerTurn: true });
  }
  return true;
}

function buildAdvancePrompt(
  promptType: string,
  state: { current: LoopState },
  lang: ReturnType<typeof getLanguageConfig>,
): string {
  switch (promptType) {
    case ADVANCE_PROMPTS.WRITER_NEGOTIATE:
      return GP.promptWriterNegotiate(state.current.specPath, lang.testFilePattern);
    case ADVANCE_PROMPTS.CLEANER_PHASE_C:
      return lang.prompts.promptCleanerPhaseC();
    default:
      return promptType;
  }
}

function handleDoneEffect(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: DebugFn,
  effect: { type: "done"; notify: string; status: string },
): boolean {
  state.current.turnsThisPhase = 1;
  debug(`Done`);
  ctx.ui.notify(effect.notify, "info");
  ctx.ui.setStatus("loop", effect.status);
  return true;
}

function handleEscalatedEffect(
  state: { current: LoopState },
  pi: ExtensionAPI,
  ctx: EventCtx,
  debug: DebugFn,
  effect: { type: "escalated"; notify: string; status: string },
): boolean {
  debug(`Escalated (${effect.status})`);
  ctx.ui.notify(effect.notify, "warning");
  ctx.ui.setStatus("loop", effect.status);
  return true;
}
