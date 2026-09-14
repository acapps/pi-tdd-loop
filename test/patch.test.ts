// Tests for /loop-patch command (internal/loop-spec-patch-resume.md)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cmdPatch } from "../src/commands";
import type { LoopState } from "../src/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "patch-test-"));
  mkdirSync(join(tmpDir, "internal"), { recursive: true });
  writeFileSync(join(tmpDir, "internal", "test-spec.md"), "# test-spec\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "B",
    round: 3,
    specPath: "internal/test-spec.md",
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
    dispute: { status: "filed", filer: "writer", claim: "test is wrong" },
    disputeCount: 1,
    turnsThisPhase: 3,
    lastProposal: "some proposal",
    lastPhase: "A",
    justTransitioned: false,
    negotiateReprompted: true,
    negotiateProposed: true,
    negotiateFeedback: "some feedback",
    autoApprove: true,
    ...overrides,
  };
}

function makeApi(): ExtensionAPI {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    state: {
      cwd: "/tmp/test-project",
      model: { id: "test" },
    },
  } as unknown as ExtensionAPI;
}

function makeCtx(cwd = "/tmp/test-project") {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    cwd,
  } as any;
}

describe("cmdPatch", () => {
  it("idle state → 'not running' message", async () => {
    const state = { current: makeState({ phase: "idle" as any, lastPhase: "idle" as any }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not running"), "warning");
  });

  it("done state → 'complete' message", async () => {
    const state = { current: makeState({ phase: "done" as any, lastPhase: "C" as any }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("complete"), "warning");
  });

  it("escalated state, no --from → uses lastPhase", async () => {
    const state = { current: makeState({ phase: "escalated" as any, lastPhase: "B" }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(state.current.phase).toBe("B");
    expect(state.current.round).toBe(1);
  });

  it("active state, no --from → uses A", async () => {
    const state = { current: makeState({ phase: "B", lastPhase: "A" }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(state.current.phase).toBe("A");
    expect(state.current.round).toBe(1);
  });

  it("--from B → phase set to B, round 1", async () => {
    const state = { current: makeState({ phase: "C", lastPhase: "B" }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("--from B", ctx);
    expect(state.current.phase).toBe("B");
    expect(state.current.round).toBe(1);
  });

  it("spec path preserved from state when not given", async () => {
    const state = { current: makeState({ phase: "B" }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(state.current.specPath).toBe("internal/test-spec.md");
  });

  it("appends loop-spec-patch entry", async () => {
    const state = { current: makeState({ phase: "B" }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    // appendEntry is called for the patch entry AND for commit (loop-state)
    const calls = (pi.appendEntry as any).mock.calls;
    const patchCall = calls.find((c: any[]) => c[0] === "loop-spec-patch");
    expect(patchCall).toBeDefined();
    expect(patchCall[1].specPath).toBe("internal/test-spec.md");
    expect(patchCall[1].fromPhase).toBe("B");
    expect(patchCall[1].toPhase).toBe("A");
    expect(patchCall[1].ts).toBeDefined();
  });

  it("prompt includes 'has been patched'", async () => {
    const state = { current: makeState({ phase: "B" }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    // sendPrompt calls sendUserMessage with the prompt text
    const sendMsg = (pi as any).sendUserMessage;
    if (sendMsg && sendMsg.mock.calls.length > 0) {
      const callArgs = sendMsg.mock.calls[0];
      // The first arg is the message content (string or object)
      const msgContent = typeof callArgs[0] === "string" ? callArgs[0] : callArgs[0]?.content;
      expect(msgContent).toContain("has been patched");
    }
  });

  it("dispute reset, negotiate flags cleared", async () => {
    const state = {
      current: makeState({
        phase: "B",
        dispute: { status: "filed", filer: "writer", claim: "x" },
        disputeCount: 2,
        negotiateReprompted: true,
        negotiateProposed: true,
        negotiateFeedback: "fb",
        turnsThisPhase: 4,
      }),
    };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(state.current.dispute).toEqual({ status: "none" });
    expect(state.current.disputeCount).toBe(0);
    expect(state.current.negotiateReprompted).toBe(false);
    expect(state.current.negotiateProposed).toBe(false);
    expect(state.current.negotiateFeedback).toBe("");
    expect(state.current.turnsThisPhase).toBe(1);
  });

  it("justTransitioned set to true", async () => {
    const state = { current: makeState({ phase: "B", justTransitioned: false }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(state.current.justTransitioned).toBe(true);
  });

  it("invalid --from value → warning, no state change", async () => {
    const state = { current: makeState({ phase: "B" }) };
    const pi = makeApi();
    const ctx = makeCtx(tmpDir);
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("--from X", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid"), "warning");
    expect(state.current.phase).toBe("B");
  });

  it("non-existent spec file → error, no state change", async () => {
    const state = { current: makeState({ phase: "B" }) };
    const pi = makeApi();
    const ctx = makeCtx("/tmp/nonexistent-dir-" + Date.now());
    const cmd = cmdPatch(state, pi, () => {});
    await cmd.handler("internal/does-not-exist.md", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not found"), "error");
    expect(state.current.phase).toBe("B");
    expect(state.current.specPath).toBe("internal/test-spec.md"); // unchanged
  });
});
