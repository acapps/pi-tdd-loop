// Tests for /loop-decompose command (internal/spec-decomposition.md)

import { describe, it, expect, vi } from "vitest";
import { cmdDecompose } from "../src/commands";
import type { LoopState } from "../src/types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "idle" as any,
    round: 0,
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
    dispute: { status: "none" },
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "idle" as any,
    justTransitioned: false,
    negotiateReprompted: false,
    negotiateProposed: false,
    negotiateFeedback: "",
    autoApprove: true,
    ...overrides,
  };
}

function makeApi(): ExtensionAPI {
  return {
    appendEntry: vi.fn(),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    state: { cwd: "/tmp/test-project", model: { id: "test" } },
  } as unknown as ExtensionAPI;
}

function makeCtx(cwd = "/tmp/test-project") {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    cwd,
  } as any;
}

describe("cmdDecompose", () => {
  it("no args → usage message", async () => {
    const state = { current: makeState() };
    const pi = makeApi();
    const ctx = makeCtx();
    const cmd = cmdDecompose(state, pi, () => {});
    await cmd.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
  });

  it("non-existent spec → error notification", async () => {
    const state = { current: makeState() };
    const pi = makeApi();
    const ctx = makeCtx();
    const cmd = cmdDecompose(state, pi, () => {});
    await cmd.handler("internal/nonexistent.md", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not found"), "error");
  });

  it("valid spec → sendPrompt called with decomposition prompt", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "decompose-"));
    try {
      writeFileSync(join(tmpDir, "big-spec.md"), "# big-spec\n\n## Target\nImplement a REST API.\n");
      const state = { current: makeState() };
      const pi = makeApi();
      const ctx = makeCtx(tmpDir);
      const cmd = cmdDecompose(state, pi, () => {});
      await cmd.handler("big-spec.md", ctx);

      // sendPrompt calls sendUserMessage
      const sendMsg = (pi as any).sendUserMessage;
      expect(sendMsg).toHaveBeenCalled();
      const callArgs = sendMsg.mock.calls[0];
      const msgContent = typeof callArgs[0] === "string" ? callArgs[0] : callArgs[0]?.content;
      expect(msgContent).toContain("independently-testable units");
      expect(msgContent).toContain("big-spec.md");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("--out and --prefix → prompt includes correct paths", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "decompose-"));
    try {
      writeFileSync(join(tmpDir, "api.md"), "# api\n\n## Target\nBuild API.\n");
      const state = { current: makeState() };
      const pi = makeApi();
      const ctx = makeCtx(tmpDir);
      const cmd = cmdDecompose(state, pi, () => {});
      await cmd.handler("api.md --out docs --prefix my-api", ctx);

      const sendMsg = (pi as any).sendUserMessage;
      const callArgs = sendMsg.mock.calls[0];
      const msgContent = typeof callArgs[0] === "string" ? callArgs[0] : callArgs[0]?.content;
      expect(msgContent).toContain("docs/my-api-");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT modify LoopState", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "decompose-"));
    try {
      writeFileSync(join(tmpDir, "spec.md"), "# spec\n\n## Target\nDo thing.\n");
      const state = { current: makeState({ phase: "B", round: 3 }) };
      const pi = makeApi();
      const ctx = makeCtx(tmpDir);
      const cmd = cmdDecompose(state, pi, () => {});
      await cmd.handler("spec.md", ctx);

      // State should be unchanged
      expect(state.current.phase).toBe("B");
      expect(state.current.round).toBe(3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prefix derived from filename when not given", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "decompose-"));
    try {
      writeFileSync(join(tmpDir, "my-rest-api.md"), "# rest\n\n## Target\nAPI.\n");
      const state = { current: makeState() };
      const pi = makeApi();
      const ctx = makeCtx(tmpDir);
      const cmd = cmdDecompose(state, pi, () => {});
      await cmd.handler("my-rest-api.md", ctx);

      const sendMsg = (pi as any).sendUserMessage;
      const callArgs = sendMsg.mock.calls[0];
      const msgContent = typeof callArgs[0] === "string" ? callArgs[0] : callArgs[0]?.content;
      expect(msgContent).toContain("my-rest-api-");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
