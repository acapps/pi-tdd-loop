// The negotiate auto-advance into Phase B bypasses the gate's effect applier,
// so it must re-capture the scope-check baseline itself (the other B-entry
// paths do it in the applier). Without this, Phase A's test files are read
// against the stale Phase 0 baseline and flagged as out-of-scope contamination
// (session 01a1c72a). This pins that the auto-advance bakes the re-captured
// baseline into the returned state.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/scope-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/scope-check")>();
  return { ...actual, recaptureBaselineForPhaseB: vi.fn() };
});

import { handleNegotiateSettled } from "../../../src/events/agent-settled/negotiate";
import type { NegotiateHandlerInput } from "../../../src/events/agent-settled/negotiate";
import type { LoopState } from "../../../src/types";
import { recaptureBaselineForPhaseB } from "../../../src/scope-check";
import { getLanguageConfig } from "../../../src/languages";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

const mockRecapture = vi.mocked(recaptureBaselineForPhaseB);
const GO = getLanguageConfig("go");

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "negotiate",
    round: 1,
    specPath: "test/golden/proj/spec.md",
    language: "go",
    buildTool: "maven",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    gateTimeoutSec: 60,
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    ...overrides,
  };
}

function makeInput(state: LoopState): NegotiateHandlerInput {
  const pi = createMockExtensionAPI();
  return {
    state,
    pi: pi as any,
    ctx: { ui: { notify: vi.fn(), setStatus: vi.fn() }, sessionManager: { getEntries: () => [] }, cwd: "/proj" },
    lang: GO,
    debug: vi.fn(),
  } as NegotiateHandlerInput;
}

describe("negotiate auto-advance re-captures the Phase B scope-check baseline", () => {
  beforeEach(() => mockRecapture.mockReset());

  it("auto-advance to B sets baselineDirtyFiles from the re-capture", () => {
    mockRecapture.mockReturnValue(["core/runtime.test.ts", "extension-contract.test.ts"]);
    const state = makeState({ negotiateReprompted: true });
    const before = JSON.parse(JSON.stringify(state));
    const result = handleNegotiateSettled(makeInput(state));

    expect(result.handled).toBe(true);
    expect(result.newState.phase).toBe("B");
    expect(result.newState.baselineDirtyFiles).toEqual(["core/runtime.test.ts", "extension-contract.test.ts"]);
    // input never mutated (pure-state contract)
    expect(state).toEqual(before);
    expect(mockRecapture).toHaveBeenCalledWith("test/golden/proj/spec.md", "/proj", expect.anything());
  });

  it("when the re-capture returns null (not a git repo) the baseline is left untouched", () => {
    mockRecapture.mockReturnValue(null);
    const state = makeState({
      negotiateReprompted: true,
      baselineDirtyFiles: ["pre-existing.ts"],
    });
    const result = handleNegotiateSettled(makeInput(state));

    expect(result.newState.baselineDirtyFiles).toEqual(["pre-existing.ts"]);
  });

  it("non-advance negotiate effects do not re-capture", () => {
    const state = makeState({ round: 1, negotiateProposed: true });
    handleNegotiateSettled(makeInput(state));
    expect(mockRecapture).not.toHaveBeenCalled();
  });
});
