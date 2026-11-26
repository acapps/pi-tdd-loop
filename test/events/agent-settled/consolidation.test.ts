// Contract tests for the fold settle effect (src/events/agent-settled/consolidate.ts).
//
// Spec: internal/wire-holdback-test-contract.md. The fold is a MECHANICAL settle
// effect: it rewrites the spec Inventory (promote non-conceded [holdback] rows,
// drop conceded ones) and emits the settle status prompt. It runs before the loop
// reports done, so the loop cannot report green with an un-promoted holdback tier.
//
// node:fs is mocked (no real spec file on disk). STUB bodies — these fail until
// the Writer implements the fold.

import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileSync = vi.fn();
const writeFileSync = vi.fn();
const rmSync = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => readFileSync(...args),
  writeFileSync: (...args: unknown[]) => writeFileSync(...args),
  rmSync: (...args: unknown[]) => rmSync(...args),
}));

import { consolidateEffect, runConsolidation } from "../../../src/events/agent-settled/consolidate";
import type { LoopState } from "../../../src/types";
import type { EventCtx } from "../../../src/events";
import type { MockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";
import { createMockExtensionAPI } from "../../__mocks__/@earendil-works/pi-coding-agent";

const SPEC_WITH_HOLDBACK = [
  "## Inventory",
  "- `test/holdback/math.test.ts` [holdback]",
  "- `test/holdback/string.test.ts` [holdback]",
  "",
].join("\n");

const HOLDBACK_FILES = {
  "test/holdback/math.test.ts": 'describe("math", () => { it("adds", () => {}); });',
  "test/holdback/string.test.ts": 'describe("strings", () => { it("reverses", () => {}); });',
};

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    phase: "C",
    round: 1,
    specPath: "SPEC.md",
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
    disputeCount: 0,
    turnsThisPhase: 0,
    lastProposal: "",
    lastPhase: "C",
    justTransitioned: false,
    negotiateReprompted: false,
    dispute: { status: "none", resolvedFailures: [] },
    ...overrides,
  } as LoopState;
}

function makeCtx(): EventCtx {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getEntries: () => [] },
    cwd: "/repo",
  };
}

function pi(): MockExtensionAPI {
  return createMockExtensionAPI() as unknown as MockExtensionAPI;
}

beforeEach(() => {
  readFileSync.mockReset();
  writeFileSync.mockReset();
  rmSync.mockReset();
});

describe("consolidateEffect — fold at settle", () => {
  it("reads the spec, folds it, and writes the folded spec back", () => {
    readFileSync.mockReturnValue(SPEC_WITH_HOLDBACK);
    const res = consolidateEffect({
      state: makeState(),
      ctx: makeCtx(),
      pi: pi(),
      debug: vi.fn(),
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
    });
    // The spec was read from disk.
    expect(readFileSync).toHaveBeenCalledWith("SPEC.md", expect.anything());
    // The folded spec was written back.
    expect(writeFileSync).toHaveBeenCalledWith("SPEC.md", expect.not.stringContaining("[holdback]"));
    // The folded spec has the promoted row as [visible].
    expect(writeFileSync).toHaveBeenCalled();
    const written = writeFileSync.mock.calls[0][1] as string;
    expect(written).toContain("`test/holdback/math.test.ts` [visible]");
    expect(res.promoted).toBeGreaterThan(0);
  });

  it("emits the fold status prompt", () => {
    readFileSync.mockReturnValue(SPEC_WITH_HOLDBACK);
    const ctx = makeCtx();
    consolidateEffect({
      state: makeState(),
      ctx,
      pi: pi(),
      debug: vi.fn(),
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
    });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("loop", expect.stringContaining("fold"));
  });

  it("is idempotent: a second fold over the folded spec folds nothing", () => {
    readFileSync.mockReturnValueOnce(SPEC_WITH_HOLDBACK);
    readFileSync.mockReturnValueOnce("[visible] folded spec");
    writeFileSync.mockImplementation((_p, content: string) => content);
    const first = runConsolidation({
      state: makeState(),
      ctx: makeCtx(),
      pi: pi(),
      debug: vi.fn(),
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
    });
    expect(first.promoted).toBeGreaterThan(0);
    const second = runConsolidation({
      state: makeState(),
      ctx: makeCtx(),
      pi: pi(),
      debug: vi.fn(),
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
    });
    expect(second.promoted).toBe(0);
  });
});

describe("drop-concede via the effect (reliability crux)", () => {
  it("drops the conceded file (removed from disk + spec) and promotes the rest", () => {
    readFileSync.mockReturnValue(SPEC_WITH_HOLDBACK);
    const state = makeState({
      dispute: { status: "none", resolvedFailures: [{ test: "strings", subtest: "reverses", output: "x" }] },
    });
    consolidateEffect({
      state,
      ctx: makeCtx(),
      pi: pi(),
      debug: vi.fn(),
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
    });
    // The conceded file's row is gone from the written spec.
    expect(writeFileSync).toHaveBeenCalled();
    const written = writeFileSync.mock.calls[0][1] as string;
    expect(written).not.toContain("string.test.ts");
    expect(written).toContain("`test/holdback/math.test.ts` [visible]");
    // The conceded file is removed from disk.
    const removedPaths = rmSync.mock.calls.map((c) => c[0]);
    expect(removedPaths).toContain("test/holdback/string.test.ts");
  });

  it("maps the conceded test to its file by test+subtest, not by guess", () => {
    const spec = [
      "## Inventory",
      "- `test/holdback/a.test.ts` [holdback]",
      "- `test/holdback/b.test.ts` [holdback]",
      "",
    ].join("\n");
    const files = {
      "test/holdback/a.test.ts": 'describe("suite", () => { it("edge", () => {}); });',
      "test/holdback/b.test.ts": 'describe("suite", () => { it("other", () => {}); });',
    };
    readFileSync.mockReturnValue(spec);
    const state = makeState({
      dispute: { status: "none", resolvedFailures: [{ test: "suite", subtest: "edge", output: "x" }] },
    });
    consolidateEffect({
      state,
      ctx: makeCtx(),
      pi: pi(),
      debug: vi.fn(),
      holdbackSubdir: "test/holdback",
      holdbackFiles: files,
    });
    expect(writeFileSync).toHaveBeenCalled();
    const written = writeFileSync.mock.calls[0][1] as string;
    expect(written).not.toContain("a.test.ts");
    expect(written).toContain("`test/holdback/b.test.ts` [visible]");
  });
});

describe("deadlock fix (Phase C not blocked)", () => {
  it("removes the conceded holdback file so it can't block settlement or be enshrined", () => {
    // A conceded holdback test is mis-specified; if left on disk it would fail
    // Phase C and deadlock the loop. The fold's defensive drop removes it.
    readFileSync.mockReturnValue(SPEC_WITH_HOLDBACK);
    const state = makeState({
      dispute: { status: "none", resolvedFailures: [{ test: "strings", subtest: "reverses", output: "x" }] },
    });
    const res = consolidateEffect({
      state,
      ctx: makeCtx(),
      pi: pi(),
      debug: vi.fn(),
      holdbackSubdir: "test/holdback",
      holdbackFiles: HOLDBACK_FILES,
    });
    expect(res.dropped).toBe(1);
    const removedPaths = rmSync.mock.calls.map((c) => c[0]);
    expect(removedPaths).toContain("test/holdback/string.test.ts");
    // The folded spec is clean: no holdback tier remains.
    const written = writeFileSync.mock.calls[0][1] as string;
    expect(written).not.toContain("[holdback]");
  });
});
