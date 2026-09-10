// Regression tests for src/prompt.ts — sendPrompt() mode adaptation.
// Spec: internal/fix-print-mode-session-replacement.md
//
// In runner mode (PI_LOOP_RUNNER=1), sendPrompt writes to the status file
// instead of calling pi.sendUserMessage. In normal mode, it calls
// pi.sendUserMessage with deliverAs: "followUp".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPrompt, isRunnerMode } from "../src/prompt";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoopState } from "../src/types";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeState(overrides?: Partial<LoopState>): LoopState {
  return {
    phase: "A",
    round: 1,
    specPath: "test/golden/sample/spec.md",
    language: "go",
    buildTool: "go",
    maxA: 3,
    maxNegotiate: 3,
    maxB: 5,
    maxC: 3,
    maxDispute: 3,
    maxTurnsPerPhase: 5,
    coverageThreshold: 80,
    gateTimeoutSec: 60,
    dispute: { status: "none" },
    disputeCount: 0,
    turnsThisPhase: 1,
    lastProposal: "",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: false,
    negotiateProposed: false,
    negotiateFeedback: "",
    ...overrides,
  };
}

function makeMockPi() {
  return {
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
}

const debug = vi.fn();

describe("isRunnerMode", () => {
  const originalEnv = process.env.PI_LOOP_RUNNER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PI_LOOP_RUNNER;
    } else {
      process.env.PI_LOOP_RUNNER = originalEnv;
    }
  });

  it("returns true when PI_LOOP_RUNNER=1", () => {
    process.env.PI_LOOP_RUNNER = "1";
    expect(isRunnerMode()).toBe(true);
  });

  it("returns false when PI_LOOP_RUNNER is unset", () => {
    delete process.env.PI_LOOP_RUNNER;
    expect(isRunnerMode()).toBe(false);
  });

  it("returns false when PI_LOOP_RUNNER=0", () => {
    process.env.PI_LOOP_RUNNER = "0";
    expect(isRunnerMode()).toBe(false);
  });
});

describe("sendPrompt — normal mode", () => {
  const originalEnv = process.env.PI_LOOP_RUNNER;

  beforeEach(() => {
    delete process.env.PI_LOOP_RUNNER;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PI_LOOP_RUNNER = originalEnv;
    }
  });

  it("calls pi.sendUserMessage with deliverAs: followUp", () => {
    const pi = makeMockPi();
    const state = makeState();
    sendPrompt(pi, "Hello world", state, debug);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Hello world", { deliverAs: "followUp" });
  });

  it("does not write status file", () => {
    const pi = makeMockPi();
    const state = makeState();
    const wsRoot = join(tmpdir(), "prompt-test-normal");
    // Use a spec path that maps to a temp dir we can check
    const state2 = makeState({ specPath: join(wsRoot, "spec.md") });
    sendPrompt(pi, "Hello", state2, debug);
    expect(existsSync(join(wsRoot, ".pi", "loop-status"))).toBe(false);
  });

  it("does not throw when pi.sendUserMessage throws", () => {
    const pi = {
      sendUserMessage: vi.fn(() => { throw new Error("stale ctx"); }),
    } as unknown as ExtensionAPI;
    const state = makeState();
    expect(() => sendPrompt(pi, "Hello", state, debug)).not.toThrow();
    expect(debug).toHaveBeenCalled();
  });
});

describe("sendPrompt — runner mode", () => {
  const originalEnv = process.env.PI_LOOP_RUNNER;
  let tmpWs: string;

  beforeEach(() => {
    process.env.PI_LOOP_RUNNER = "1";
    tmpWs = join(tmpdir(), `prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpWs, ".pi"), { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PI_LOOP_RUNNER = originalEnv;
    } else {
      delete process.env.PI_LOOP_RUNNER;
    }
    if (existsSync(tmpWs)) {
      rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it("writes the prompt to the status file", () => {
    const pi = makeMockPi();
    // Use a golden project path so getWorkspaceRoot returns the project dir.
    // The status file will be written to test/golden/sample/.pi/loop-status.
    const state = makeState(); // specPath: "test/golden/sample/spec.md"
    const wsRoot = "test/golden/sample";
    const statusFile = join(wsRoot, ".pi", "loop-status");
    // Clean up any existing status file
    if (existsSync(statusFile)) rmSync(statusFile);

    sendPrompt(pi, "Next prompt here", state, debug);

    // pi.sendUserMessage should NOT be called
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    // Status file should exist with the prompt
    expect(existsSync(statusFile)).toBe(true);
    const data = JSON.parse(readFileSync(statusFile, "utf8"));
    expect(data.status).toBe("continue");
    expect(data.prompt).toBe("Next prompt here");
    expect(data.phase).toBe("A");
    expect(data.round).toBe(1);

    // Clean up
    rmSync(statusFile);
  });

  it("does not throw when state is undefined", () => {
    const pi = makeMockPi();
    expect(() => sendPrompt(pi, "Hello", undefined, debug)).not.toThrow();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not throw when status file write fails", () => {
    const pi = makeMockPi();
    // Use a spec path that maps to a non-writable location
    const state = makeState({ specPath: "/nonexistent/path/spec.md" });
    expect(() => sendPrompt(pi, "Hello", state, debug)).not.toThrow();
  });
});
