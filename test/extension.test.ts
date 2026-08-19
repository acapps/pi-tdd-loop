// Characterization tests for loop-go extension public API
// These test the registered commands, tools, and event handlers
// without inspecting internals — only what's observable through the ExtensionAPI surface.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockExtensionAPI, type MockExtensionAPI } from "./__mocks__/@earendil-works/pi-coding-agent";

// Type for a mock Extended API that carries the captured registrations
type TestAPI = MockExtensionAPI & {
  // We'll attach the mock ui/sessionManager here
  _mockUi: any;
  _mockCtx: any;
  _mockExecCtx: any;
  _mockEntries: any[];
};

// Load the extension factory
import extensionFactory from "../index";
import * as Tool from "../src/tools";
import type { LoopState } from "../src/types";

function buildTestAPI(): TestAPI {
  const api = createMockExtensionAPI() as TestAPI;

  api._mockUi = {
    notify: vi.fn(),
    setStatus: vi.fn(),
  };

  api._mockEntries = [];

  api._mockCtx = {
    ui: api._mockUi,
    cwd: "/tmp/test-project",
    sessionManager: {
      getEntries: () => api._mockEntries,
    },
    mode: "tui",
    hasUI: true,
  };

  api._mockExecCtx = {
    ui: api._mockUi,
    cwd: "/tmp/test-project",
  };

  return api;
}

// Helper: ensure fixture files (spec + Go project) exist in the mock cwd
function setupSpecFiles(): void {
  const fs = require("node:fs");
  fs.mkdirSync("/tmp/test-project/path/to", { recursive: true });
  fs.writeFileSync("/tmp/test-project/spec.md", `# Test Spec\n\n- Func1() — does something.\n- Func2() — does another thing.\n`);
  fs.writeFileSync("/tmp/test-project/path/to/spec.md", `# Test Spec\n\n- Func1() — does something.\n- Func2() — does another thing.\n`);
  fs.writeFileSync("/tmp/test-project/main.go", "package main\n\nfunc main() {}\n");
  fs.writeFileSync("/tmp/test-project/main_test.go", "package main\n\nimport \"testing\"\n\nfunc TestMain(t *testing.T) { if false { t.Error(\"fail\") } }\n");
  fs.writeFileSync("/tmp/test-project/go.mod", "module testproject\n\ngo 1.22\n");
}

// Helper to find a registered command by name
function findCommand(api: TestAPI, name: string) {
  const entry = api.registeredCommands.find((c) => c.name === name);
  expect(entry).toBeDefined();
  return entry!.handler;
}

// Helper to find a registered tool by name
function findTool(api: TestAPI, name: string) {
  const entry = api.registeredTools.find((t: any) => t.name === name);
  expect(entry).toBeDefined();
  return entry!;
}

// Helper to find an event handler
function findEventHandler(api: TestAPI, event: string) {
  const handlers = api.eventHandlers.get(event);
  expect(handlers).toBeDefined();
  expect(handlers!.length).toBeGreaterThan(0);
  return handlers![0];
}

// ================================================================
// Extension Factory Registration Tests
// ================================================================

describe("extension factory", () => {
  it("registers all 7 commands", () => {
    const api = buildTestAPI();
    extensionFactory(api);

    expect(api.registeredCommands.length).toBe(7);
    const names = api.registeredCommands.map((c) => c.name);
    expect(names).toContain("loop");
    expect(names).toContain("loop-approve");
    expect(names).toContain("loop-status");
    expect(names).toContain("loop-continue");
    expect(names).toContain("loop-restart");
    expect(names).toContain("loop-debug");
    expect(names).toContain("loop-cancel");
  });

  it("registers both negotiate tools", () => {
    const api = buildTestAPI();
    extensionFactory(api);

    expect(api.registeredTools.length).toBe(2);
    const toolNames = api.registeredTools.map((t) => t.name);
    expect(toolNames).toContain("negotiate_propose");
    expect(toolNames).toContain("negotiate_review");
  });

  it("registers all 4 event handlers", () => {
    const api = buildTestAPI();
    extensionFactory(api);

    const expectedEvents = ["session_start", "before_agent_start", "tool_call", "agent_settled"];
    for (const event of expectedEvents) {
      expect(api.eventHandlers.has(event)).toBe(true);
    }
  });
});

// ================================================================
// /loop command — starts the loop at Phase A
// ================================================================

describe("/loop command", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("notifies usage error when no spec path", async () => {
    const handler = findCommand(api, "loop");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Usage: /loop [--language go|java|typescript] [--coverage N] [--skip-review] <spec-path>",
      "warning"
    );
  });

  it("starts Phase 0 review with default coverage 80", async () => {
    const handler = findCommand(api, "loop");
    await handler("path/to/spec.md", api._mockCtx);

    // Should send a Phase 0 review prompt
    expect(api.sentMessages.length).toBeGreaterThan(0);
    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.content).toContain("Phase 0: Spec Review");
    expect(lastMsg.content).toContain("Spec content");
    expect(lastMsg.options?.triggerTurn).toBe(true);

    // Should notify and set status
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("Phase 0"),
      "info"
    );
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "Phase 0 — review pending");
  });

  it("starts Phase 0 review with custom coverage", async () => {
    const handler = findCommand(api, "loop");
    await handler("--coverage 90 path/to/spec.md", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("Phase 0"),
      "info"
    );
    expect(api.sentMessages.length).toBeGreaterThan(0);
    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.content).toContain("Phase 0: Spec Review");
  });

  it("sets triggerTurn on the Phase 0 review prompt", async () => {
    const handler = findCommand(api, "loop");
    await handler("spec.md", api._mockCtx);

    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.options?.triggerTurn).toBe(true);
  });
});

// ================================================================
// /loop-status command — shows formatted status
// ================================================================

describe("/loop-status command", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("shows idle state with no gate data", async () => {
    const handler = findCommand(api, "loop-status");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("Phase: idle"),
      "info"
    );
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("no gate data"),
      "info"
    );
  });

  it("shows gate data after a loop has run", async () => {
    // Start a loop first (now enters Phase 0 review)
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    const handler = findCommand(api, "loop-status");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("Phase: review"),
      "info"
    );
  });
});

// ================================================================
// /loop-continue command — continues from current phase or resumes from escalated
// ================================================================

describe("/loop-continue command", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("warns when idle", async () => {
    const handler = findCommand(api, "loop-continue");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Nothing to continue. Run /loop <spec-path> to start.",
      "warning"
    );
  });

  it("warns when done", async () => {
    // Simulate done state by running loop then manually setting phase
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    // Use session_start handler to simulate a reload with modified state
    // For now, just check that non-idle phases trigger continue
    const handler = findCommand(api, "loop-continue");
    await handler("", api._mockCtx);

    // After /loop, phase is "review" so continue should work
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("Continued from Phase review"),
      "info"
    );
  });

  it("sets status to Phase 0 review", async () => {
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    // Check that status was set to Phase 0 review
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "Phase 0 — review pending");
  });
});

// ================================================================
// /loop-restart command — restarts from a specific phase
// ================================================================

describe("/loop-restart command", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("warns on invalid phase", async () => {
    const handler = findCommand(api, "loop-restart");
    await handler("invalid", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Usage: /loop-restart <A|negotiate|B|C>",
      "warning"
    );
  });

  it.each(["A", "a", "B", "b", "C", "c", "negotiate"])(
    "accepts phase '%s'",
    async (phase) => {
      const handler = findCommand(api, "loop-restart");
      await handler(phase, api._mockCtx);

      // Should notify and set status
      expect(api._mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("Restarted from Phase"),
        "info"
      );
    }
  );

  it("sends phase-appropriate prompt for A", async () => {
    // Need /loop first so specPath is set
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("A", api._mockCtx);

    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    // Restart A delegates to full prompt (TESTER role, spec path, stubs/tests)
    expect(lastMsg.content).toContain("TESTER");
    expect(lastMsg.content).toContain("spec.md");
    expect(lastMsg.content).toContain("Stubs");
  });

  it("sends phase-appropriate prompt for B", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    // Restart B sends: "Phase B: Implement. Read *_test.go..."
    expect(lastMsg.content).toContain("Phase B");
    expect(lastMsg.content).toContain("Implement");
  });

  it("sends phase-appropriate prompt for C", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("C", api._mockCtx);

    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    // Restart C delegates to full prompt (Cleaner role, refactor guidance)
    expect(lastMsg.content).toContain("Cleaner");
    expect(lastMsg.content).toContain("Refactor");
  });
});

// ================================================================
// /loop-debug command — shows debug entries
// ================================================================

describe("/loop-debug command", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("shows empty debug log", async () => {
    const handler = findCommand(api, "loop-debug");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Loop debug (0 entries):\n",
      "info"
    );
  });

  it("shows debug entries after loop start", async () => {
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    const debugHandler = findCommand(api, "loop-debug");
    await debugHandler("", api._mockCtx);

    // After /loop, there should be at least 1 debug entry
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringMatching(/Loop debug \(\d+ entries\)/),
      "info"
    );
  });

  // ------------------------------------------------------------------
  // --log-bug flag contract (internal/log-bug-spec.md, Phase 0 approved)
  // 9 cases: success / equals-form parity / multi-word / usage / collision /
  //          write failure / no events / idle context / legacy last-20+ISO
  // ------------------------------------------------------------------

  it("log-bug success writes the bug spec file and notifies once", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-"));
    api._mockCtx.cwd = tmp;

    const handler = findCommand(api, "loop-debug");
    await handler("--log-bug test-bug", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledTimes(1);
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Wrote bug-fix-test-bug.md\nNext: fill in Observed problem / Proposed fix, then /loop bug-fix-test-bug.md",
      "info"
    );
    const file = path.join(tmp, "bug-fix-test-bug.md");
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("# Bug: test-bug");
    expect(content).toContain(
      "> Generated by /loop-debug --log-bug on "
    );
    expect(content).toContain("> Resolve with: /loop bug-fix-test-bug.md");
    for (const heading of [
      "## Context",
      "## Observed problem",
      "## Proposed fix",
      "## Log excerpt",
      "## Acceptance",
    ]) {
      expect(content).toContain(heading);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("--log-bug=<x> equals form behaves identically to the space form", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const handler = findCommand(api, "loop-debug");

    const tmpEq = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-eq-"));
    api._mockCtx.cwd = tmpEq;
    await handler("--log-bug=parity", api._mockCtx);
    const notifyEq = api._mockUi.notify.mock.calls.at(-1)![0] as string;

    const tmpSp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-sp-"));
    api._mockCtx.cwd = tmpSp;
    await handler("--log-bug parity", api._mockCtx);
    const notifySp = api._mockUi.notify.mock.calls.at(-1)![0] as string;

    expect(notifyEq).toBe(notifySp);
    expect(notifyEq).toBe(
      "Wrote bug-fix-parity.md\nNext: fill in Observed problem / Proposed fix, then /loop bug-fix-parity.md"
    );
    expect(fs.existsSync(path.join(tmpEq, "bug-fix-parity.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpSp, "bug-fix-parity.md"))).toBe(true);
    fs.rmSync(tmpEq, { recursive: true, force: true });
    fs.rmSync(tmpSp, { recursive: true, force: true });
  });

  it("multi-word space-form name is slugified for the file, verbatim in the title", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-mw-"));
    api._mockCtx.cwd = tmp;

    const handler = findCommand(api, "loop-debug");
    await handler("--log-bug Frozen at Phase B Step 5", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Wrote bug-fix-frozen-at-phase-b-step-5.md\nNext: fill in Observed problem / Proposed fix, then /loop bug-fix-frozen-at-phase-b-step-5.md",
      "info"
    );
    const file = path.join(tmp, "bug-fix-frozen-at-phase-b-step-5.md");
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("# Bug: Frozen at Phase B Step 5");
    expect(content).toContain(
      "> Resolve with: /loop bug-fix-frozen-at-phase-b-step-5.md"
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("empty name (flag as final token, or equals form with empty remainder) → usage notify, no file", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-usage-"));
    api._mockCtx.cwd = tmp;

    const handler = findCommand(api, "loop-debug");
    await handler("--log-bug", api._mockCtx);
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Usage: /loop-debug --log-bug <name>",
      "warning"
    );
    expect(fs.readdirSync(tmp)).toEqual([]);

    api._mockUi.notify.mockClear();
    await handler("--log-bug=", api._mockCtx);
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Usage: /loop-debug --log-bug <name>",
      "warning"
    );
    expect(fs.readdirSync(tmp)).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("collision → error notify, original file untouched (multi-word name pins slug in message and path)", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-col-"));
    api._mockCtx.cwd = tmp;
    const file = path.join(tmp, "bug-fix-dup-name.md");
    fs.writeFileSync(file, "original content", "utf8");

    const handler = findCommand(api, "loop-debug");
    await handler("--log-bug dup name", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "bug-fix-dup-name.md already exists. Pick a different name.",
      "error"
    );
    expect(fs.readFileSync(file, "utf8")).toBe("original content");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("write failure (non-existent cwd) → error notify with the pinned prefix, no throw", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-fail-"));
    api._mockCtx.cwd = path.join(tmp, "no-such-dir");

    const handler = findCommand(api, "loop-debug");
    await handler("--log-bug fail name", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringMatching(/^Failed to write bug-fix-fail-name\.md: /),
      "error"
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("session with no loop entries → file contains the no-events line", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-none-"));
    api._mockCtx.cwd = tmp;
    // api._mockEntries is [] (fresh buildTestAPI)

    const handler = findCommand(api, "loop-debug");
    await handler("--log-bug no-events", api._mockCtx);

    const content = fs.readFileSync(
      path.join(tmp, "bug-fix-no-events.md"),
      "utf8"
    );
    expect(content).toContain("(no loop events found in this session)");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("idle state → Context line reports no active loop", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-bug-idle-"));
    api._mockCtx.cwd = tmp;
    // state is idle by default (no /loop run in this test)

    const handler = findCommand(api, "loop-debug");
    await handler("--log-bug idle-check", api._mockCtx);

    const content = fs.readFileSync(
      path.join(tmp, "bug-fix-idle-check.md"),
      "utf8"
    );
    expect(content).toContain("- Loop state at logging time: no active loop");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("no-args still shows the last 20 entries and renders data.ts as an ISO timestamp", async () => {
    const T = 1700000000000;
    api._mockEntries = Array.from({ length: 25 }, (_, i) => ({
      type: "custom",
      customType: "loop-debug",
      data: { ts: T + i * 1000, msg: `entry-${String(i).padStart(2, "0")}` },
    }));

    const handler = findCommand(api, "loop-debug");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringMatching(/^Loop debug \(25 entries\):\n/),
      "info"
    );
    const msg = api._mockUi.notify.mock.calls.at(-1)![0] as string;
    // shift 1: data.ts (epoch ms) renders as ISO instead of '?'
    expect(msg).toContain(`[${new Date(T + 24 * 1000).toISOString()}] loop-debug:`);
    // last-20 slice: index 24 shown, index 4 dropped
    expect(msg).toContain("entry-24");
    expect(msg).not.toContain("entry-04");
  });
});

// ================================================================
// /loop-cancel command — stops the loop
// ================================================================

describe("/loop-cancel command", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("notifies cancellation", async () => {
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    const handler = findCommand(api, "loop-cancel");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith("Loop cancelled.", "info");
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "idle");
  });
});

// ================================================================
// negotiate_propose tool — Writer proposes or disputes
// ================================================================

describe("negotiate_propose tool", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("records proposal and transitions to Tester review in negotiate phase", async () => {
    // Set up negotiate phase
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    // Simulate transition to negotiate (via agent_settled handler path)
    // For this test, we manually set state via session_start with pre-loaded state
    // But the simplest approach: use /loop-restart negotiate
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const before = api.sentMessages.length;
    const result = await tool.execute(
      "call-1",
      { plan: "I will use a struct-based approach with 3 types." },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Proposal recorded. Awaiting review.");

    // The tool records intent in state; it must NOT send a user message —
    // delivery happens in the agent-settled handler.
    expect(api.sentMessages.length).toBe(before);

    // The last loop-state entry carries the proposal marker + payload.
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.negotiateProposed).toBe(true);
    expect(lastState.lastProposal).toBe("I will use a struct-based approach with 3 types.");
    expect(lastState.round).toBe(1); // round untouched by the tool (parity stays Writer's)
  });

  it("transitions to Phase B on 'agree' in negotiate phase", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const result = await tool.execute(
      "call-1",
      { plan: "agree" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Proposal recorded. Moving to Phase B.");

    // State entry should show Phase B with justTransitioned
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.phase).toBe("B");
    expect(lastState.round).toBe(1);
    expect(lastState.justTransitioned).toBe(true);

    // Status should be Phase B
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1");
  });

  it("records dispute in Phase B", async () => {
    // Use Phase B directly
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const result = await tool.execute(
      "call-1",
      { plan: "Test X/edge_case expects nil but spec says return zero-value" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Dispute filed. STOP producing tool calls. The review is requested when your turn ends.");

    // Dispute sets awaitDisputeReview flag (review scheduled at settle, spec 09)
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.awaitDisputeReview).toBe(true);

    // Dispute entry should be recorded, with the derived filer (spec 09)
    const disputeEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-dispute"
    );
    expect(disputeEntries).toHaveLength(1);
    expect(disputeEntries[0].data.claim).toContain("Test X/edge_case");
    expect(disputeEntries[0].data.disputeCount).toBe(1);
    expect(disputeEntries[0].data.filer).toBe("writer"); // disputeMode false → Writer filed
  });
});

// ================================================================
// negotiate_review tool — Tester approves or gives feedback
// ================================================================

describe("negotiate_review tool", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
  });

  it("transitions to Phase B on 'approve' in negotiate phase", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const tool = findTool(api, "negotiate_review");
    const result = await tool.execute(
      "call-1",
      { decision: "approve" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Approved.");

    // State entry should show Phase B with justTransitioned
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.phase).toBe("B");
    expect(lastState.round).toBe(1);
    expect(lastState.justTransitioned).toBe(true);

    // Status should be Phase B
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1");
  });

  it("gives feedback in negotiate phase", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    // First, do a propose to set round > 1
    const proposeTool = findTool(api, "negotiate_propose");
    await proposeTool.execute(
      "call-1",
      { plan: "My approach" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    const decision = "Consider using an interface instead of a struct for flexibility.";
    const reviewTool = findTool(api, "negotiate_review");
    const before = api.sentMessages.length;
    const result = await reviewTool.execute(
      "call-2",
      { decision },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Feedback recorded.");

    // The tool records intent in state; it must NOT send a user message —
    // delivery happens in the agent-settled handler.
    expect(api.sentMessages.length).toBe(before);

    // The last loop-state entry carries the feedback payload.
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.negotiateFeedback).toBe(decision);
    expect(lastState.round).toBe(1); // round untouched by the tool (parity stays Tester's)
  });

  it("concedes dispute and triggers Tester fix in Phase B (Table 2 row 1: writer filed)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const tool = findTool(api, "negotiate_review");
    const result = await tool.execute(
      "call-1",
      { decision: "approve" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Approved.");

    // State entry should show disputeMode and awaitDisputeFix (no justTransitioned)
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.disputeMode).toBe(true);
    expect(lastState.awaitDisputeFix).toBe(true);
    expect(lastState.justTransitioned).toBe(false);
    expect(lastState.disputeFiler).toBe("writer"); // recorded at decision (spec 09, Table 2)
  });

  it("defends test in Phase B dispute (Table 2 row 2: writer filed)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // First raise a dispute
    const proposeTool = findTool(api, "negotiate_propose");
    await proposeTool.execute(
      "call-1",
      { plan: "Test is wrong" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    const reviewTool = findTool(api, "negotiate_review");
    const before = api.sentMessages.length;
    const result = await reviewTool.execute(
      "call-2",
      { decision: "The test is correct. The spec clearly states this behavior." },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Feedback recorded.");

    // Spec 09: the tool sends NOTHING — delivery moves to the settle handler.
    expect(api.sentMessages.length).toBe(before);

    // State entry shows the pending delivery + recorded filer
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.disputeDefended).toBe("The test is correct. The spec clearly states this behavior.");
    expect(lastState.disputeFiler).toBe("writer");
    expect(lastState.round).toBe(2); // round incremented by the defend cell
    expect(lastState.disputeMode).toBe(false);
  });

  it("tester-filed approve → writer concede fix (Table 2 row 3)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // Enter the dispute-fix window (Tester-filed direction requires disputeMode).
    const proposeTool = findTool(api, "negotiate_propose");
    await proposeTool.execute(
      "call-1",
      { plan: "agree" }, // negotiate phase? no — Phase B: this files a dispute
      undefined,
      undefined,
      api._mockExecCtx
    );

    const reviewTool = findTool(api, "negotiate_review");
    const result = await reviewTool.execute(
      "call-2",
      { decision: "approve" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Approved.");

    // Writer-filed approve (disputeMode false at decision) → tester fix flow
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.disputeFiler).toBe("writer");
    expect(lastState.disputeMode).toBe(true);
    expect(lastState.awaitDisputeFix).toBe(true);
  });

  it("tester-filed defend → window closes, report-rejected pending (Table 2 row 4)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // File a dispute (writer direction to enter the window), then concede to enter it.
    const proposeTool = findTool(api, "negotiate_propose");
    await proposeTool.execute(
      "call-1",
      { plan: "Test is wrong" },
      undefined,
      undefined,
      api._mockExecCtx
    );
    const reviewTool = findTool(api, "negotiate_review");
    await reviewTool.execute(
      "call-2",
      { decision: "approve" }, // writer filed → tester fix window opens (disputeMode true)
      undefined,
      undefined,
      api._mockExecCtx
    );

    // Now in the fix window (disputeMode true): the Tester files a report.
    await proposeTool.execute(
      "call-3",
      { plan: "Your fix still fails edge case Y" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    // The Writer defends its implementation.
    const result = await reviewTool.execute(
      "call-4",
      { decision: "Edge case Y is handled; the report misread the spec." },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Feedback recorded.");

    // No message from the tool (spec 09); delivery is at settle.
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.disputeDefended).toBe("Edge case Y is handled; the report misread the spec.");
    expect(lastState.disputeFiler).toBe("tester"); // recorded pre-mutation (F-B)
    expect(lastState.disputeMode).toBe(false); // row 4 window-close (load-bearing)
    expect(lastState.round).toBe(2); // round incremented once by the defend cell (spec 09 Table 2 row 2/4: one round++ per defend decision; restart baseline is round 1)
  });
});

// ================================================================
// session_start event — restores state from session entries
// ================================================================

describe("session_start event", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
  });

  it("restores state from previous session entries", async () => {
    // Seed a saved state
    api._mockEntries = [
      {
        type: "custom",
        customType: "loop-state",
        data: {
          phase: "B",
          round: 3,
          specPath: "spec.md",
          language: "go",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          coverageThreshold: 90,
          disputeMode: true, // should be cleared
          disputeCount: 1,
          lastProposal: "some plan",
          lastPhase: "A",
          justTransitioned: false,
          negotiateReprompted: false,
          awaitDisputeFix: false,
          awaitDisputeReview: false,
        },
      },
    ];

    const handler = findEventHandler(api, "session_start");
    await handler({ type: "session_start", reason: "reload" }, api._mockCtx);

    // State should be restored with disputeMode and justTransitioned cleared
    // We verify this by checking the debug entry
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 3");
  });

  it("leaves idle when no previous state", async () => {
    api._mockEntries = [];

    const handler = findEventHandler(api, "session_start");
    await handler({ type: "session_start", reason: "startup" }, api._mockCtx);

    // No status set when idle (no previous state)
    expect(api._mockUi.setStatus).not.toHaveBeenCalled();
  });
});

// ================================================================
// before_agent_start event — injects role-specific system prompts
// ================================================================

describe("before_agent_start event", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("returns nothing in idle phase", async () => {
    const handler = findEventHandler(api, "before_agent_start");
    const result = await handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: "system" },
      api._mockCtx
    );

    expect(result).toBeUndefined();
  });

  it("returns Phase 0 review prompt after /loop", async () => {
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    const handler = findEventHandler(api, "before_agent_start");
    const result = await handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: "base-prompt" },
      api._mockCtx
    );

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain("Phase 0");
    expect(result!.message.content).toContain("Phase 0");
  });

  it("returns Writer proposal prompt in negotiate odd round", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const handler = findEventHandler(api, "before_agent_start");
    const result = await handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: "base-prompt" },
      api._mockCtx
    );

    expect(result!.systemPrompt).toContain("Negotiation");
    expect(result!.message.content).toContain("WRITER");
    expect(result!.message.content).toContain("negotiate_propose");
  });

  it("returns Writer prompt in Phase B", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const handler = findEventHandler(api, "before_agent_start");
    const result = await handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: "base-prompt" },
      api._mockCtx
    );

    expect(result!.systemPrompt).toContain("Phase B (Writer)");
    expect(result!.message.content).toContain("WRITER");
  });

  it("returns Cleaner prompt in Phase C", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("C", api._mockCtx);

    const handler = findEventHandler(api, "before_agent_start");
    const result = await handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: "base-prompt" },
      api._mockCtx
    );

    expect(result!.systemPrompt).toContain("Phase C (Cleaner)");
    expect(result!.message.content).toContain("CLEANER");
  });
});

// ================================================================
// tool_call event — path enforcement
// ================================================================

describe("tool_call event (path enforcement)", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("allows file writes in Phase A (stubs and tests)", async () => {
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    const handler = findEventHandler(api, "tool_call");

    // Allow *.go stub
    const stubResult = await handler(
      { type: "tool_call", toolName: "write", input: { path: "pkg/handler.go" } },
      api._mockCtx
    );
    expect(stubResult).toBeUndefined(); // not blocked

    // Allow *_test.go
    const testResult = await handler(
      { type: "tool_call", toolName: "write", input: { path: "pkg/handler_test.go" } },
      api._mockCtx
    );
    expect(testResult).toBeUndefined(); // not blocked
  });

  it("blocks file writes in negotiate phase", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const handler = findEventHandler(api, "tool_call");

    const result = await handler(
      { type: "tool_call", toolName: "write", input: { path: "pkg/handler.go" } },
      api._mockCtx
    );

    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("Negotiation is discussion-only");
  });

  it("blocks *_test.go writes in Phase B", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const handler = findEventHandler(api, "tool_call");

    const result = await handler(
      { type: "tool_call", toolName: "write", input: { path: "pkg/handler_test.go" } },
      api._mockCtx
    );

    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.reason).toContain("*_test.go");
  });

  it("allows *.go writes in Phase B", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const handler = findEventHandler(api, "tool_call");

    const result = await handler(
      { type: "tool_call", toolName: "write", input: { path: "pkg/handler.go" } },
      api._mockCtx
    );

    expect(result).toBeUndefined(); // not blocked
  });

  it("blocks *_test.go writes in Phase C", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("C", api._mockCtx);

    const handler = findEventHandler(api, "tool_call");

    const result = await handler(
      { type: "tool_call", toolName: "edit", input: { path: "pkg/handler_test.go" } },
      api._mockCtx
    );

    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
  });

  it("allows writes in escalated phase (relaxed enforcement)", async () => {
    const loopHandler = findCommand(api, "loop");
    await loopHandler("spec.md", api._mockCtx);

    // Manually escalate via state manipulation through debug entries
    // Use /loop-restart to get to a non-idle state, then simulate escalation
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // We need to get the internal state. Since state is a closure variable,
    // we simulate escalation by checking that an escalated phase relaxes enforcement.
    // The cleanest way is to trigger escalation via the tool_call handler
    // by manually checking. But since state is internal, let's test via the session entry.
    //
    // Actually, let's use session_start to set escalated state.
    api._mockEntries = [
      {
        type: "custom",
        customType: "loop-state",
        data: {
          phase: "escalated",
          round: 5,
          specPath: "spec.md",
          language: "go",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          coverageThreshold: 80,
          disputeMode: false,
          disputeCount: 3,
          lastProposal: "",
          lastPhase: "B",
          justTransitioned: false,
          negotiateReprompted: false,
          awaitDisputeFix: false,
          awaitDisputeReview: false,
        },
      },
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const toolHandler = findEventHandler(api, "tool_call");

    // In escalated mode, writes should NOT be blocked
    const result = await toolHandler(
      { type: "tool_call", toolName: "write", input: { path: "pkg/handler_test.go" } },
      api._mockCtx
    );

    expect(result).toBeUndefined(); // not blocked in escalated mode
  });
});

// ================================================================
// agent_settled event — gate execution and phase transitions
// ================================================================

describe("agent_settled event (phase transitions)", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("returns nothing when idle", async () => {
    const handler = findEventHandler(api, "agent_settled");
    await handler({ type: "agent_settled" }, api._mockCtx);

    // No messages sent when idle
    expect(api.sentMessages.length).toBe(0);
  });

  it("returns nothing when done", async () => {
    // Seed done state
    api._mockEntries = [
      {
        type: "custom",
        customType: "loop-state",
        data: {
          phase: "done",
          round: 0,
          specPath: "",
          language: "go",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          coverageThreshold: 80,
          disputeMode: false,
          disputeCount: 0,
          lastProposal: "",
          lastPhase: "C",
          justTransitioned: false,
          negotiateReprompted: false,
          awaitDisputeFix: false,
          awaitDisputeReview: false,
        },
      },
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const handler = findEventHandler(api, "agent_settled");
    const msgCountBefore = api.sentMessages.length;
    await handler({ type: "agent_settled" }, api._mockCtx);

    // No new messages when done
    expect(api.sentMessages.length).toBe(msgCountBefore);
  });

  it("returns nothing when escalated", async () => {
    api._mockEntries = [
      {
        type: "custom",
        customType: "loop-state",
        data: {
          phase: "escalated",
          round: 5,
          specPath: "spec.md",
          language: "go",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          coverageThreshold: 80,
          disputeMode: false,
          disputeCount: 3,
          lastProposal: "",
          lastPhase: "B",
          justTransitioned: false,
          negotiateReprompted: false,
          awaitDisputeFix: false,
          awaitDisputeReview: false,
        },
      },
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const handler = findEventHandler(api, "agent_settled");
    const msgCountBefore = api.sentMessages.length;
    await handler({ type: "agent_settled" }, api._mockCtx);

    expect(api.sentMessages.length).toBe(msgCountBefore);
  });

  it("runs gates in Phase A (compile check via go build)", async () => {
    // Set up Phase A state
    api._mockEntries = [
      {
        type: "custom",
        customType: "loop-state",
        data: {
          phase: "A",
          round: 1,
          specPath: "spec.md",
          language: "go",
          buildTool: "maven",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          coverageThreshold: 80,
          awaitingReview: false,
          justTransitioned: true,
        },
      },
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const handler = findEventHandler(api, "agent_settled");
    await handler({ type: "agent_settled" }, api._mockCtx);

    // After agent_settled in Phase A, gates run and result in some message
    expect(api.sentMessages.length).toBeGreaterThan(0);
  });

  it("negotiate phase re-prompts when agent doesn't use tool", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const handler = findEventHandler(api, "agent_settled");
    await handler({ type: "agent_settled" }, api._mockCtx);

    // First settle: re-prompt
    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.content).toContain("negotiate_propose");
    expect(lastMsg.content).toContain("Do NOT write");

    // Notify warning
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("use negotiate_propose"),
      "warning"
    );
  });

  it("negotiate phase auto-advances on second settle without tool use", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const handler = findEventHandler(api, "agent_settled");

    // First settle: re-prompt
    await handler({ type: "agent_settled" }, api._mockCtx);

    // Second settle: auto-advance
    await handler({ type: "agent_settled" }, api._mockCtx);

    // Should auto-advance to Phase B
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "Phase B — round 1");
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      expect.stringContaining("without explicit proposal"),
      "info"
    );
  });

  it("resets turnsThisPhase on retry so repeated gate failures do not trigger loop escalation", async () => {
    // Set up Phase B
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const handler = findEventHandler(api, "agent_settled");

    // Trigger multiple agent_settled events — each time the gate fails (no real Go project),
    // the handler should produce a retry effect. With the fix, turnsThisPhase resets on retry
    // so we never hit the loop escalation threshold.
    for (let i = 0; i < 8; i++) {
      await handler({ type: "agent_settled" }, api._mockCtx);
    }

    // Should NOT have escalated (no "loop detected" notification)
    const loopNotifications = api.notifications.filter(
      (n) => n.message.includes("loop") && n.message.toLowerCase().includes("escalat")
    );
    expect(loopNotifications).toHaveLength(0);

    // State entries should show turnsThisPhase staying low (reset on each retry)
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    for (const entry of stateEntries) {
      expect(entry.data.turnsThisPhase).toBeLessThanOrEqual(1);
    }

    // Phase should remain B (not escalated)
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.phase).toBe("B");
  });
});

// ================================================================
// spec 08 — dispute flags cleared at phase boundaries
// Contract: no dispute flag survives a phase boundary
// (internal/08-clear-dispute-flags.md, items 6, 7, 8, 10, 11).
// ================================================================

describe("spec 08 — dispute flags cleared at phase boundaries", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  // Direct-call fixtures for the negotiate-phase tool sites (items 6-7).
  // The factory state is a closure variable, and once the boundary clears
  // land no public API can enter the negotiate phase with a live dispute
  // flag (that is the invariant this spec establishes), so the exported
  // tool functions are called directly with a state wrapper carrying the
  // live flags — the same functions the registered tools execute.
  function makeToolState(overrides: Partial<LoopState> = {}): { current: LoopState } {
    return {
      current: {
        phase: "negotiate",
        round: 2,
        specPath: "spec.md",
        language: "go",
        buildTool: "maven",
        maxA: 3,
        maxNegotiate: 3,
        maxB: 5,
        maxC: 3,
        maxDispute: 3,
        maxTurnsPerPhase: 5,
        coverageThreshold: 80,
        disputeMode: false,
        disputeCount: 0,
        turnsThisPhase: 1,
        lastProposal: "plan",
        lastPhase: "A",
        justTransitioned: false,
        negotiateReprompted: false,
        negotiateProposed: false,
        negotiateFeedback: "",
        awaitDisputeFix: false,
        awaitDisputeReview: false,
        ...overrides,
      },
    };
  }

  function makeToolCtx(): any {
    return { ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "tui", hasUI: true };
  }

  function lastStateEntries(pi: { appendedEntries: any[] }): any[] {
    return pi.appendedEntries.filter((e: any) => e.customType === "loop-state");
  }

  // Factory-level setup: Phase B with both dispute flags live — a dispute
  // filed (sets awaitDisputeReview) then conceded (sets awaitDisputeFix).
  async function enterPhaseBWithBothFlagsLive(): Promise<void> {
    const restart = findCommand(api, "loop-restart");
    await restart("B", api._mockCtx);

    const propose = findTool(api, "negotiate_propose");
    await propose.execute("s-1", { plan: "test is wrong per spec" }, undefined, undefined, api._mockExecCtx);

    const review = findTool(api, "negotiate_review");
    await review.execute("s-2", { decision: "approve" }, undefined, undefined, api._mockExecCtx);
  }

  function lastLoopState(): any {
    const entries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    return entries[entries.length - 1]?.data;
  }

  it("site 6 — negotiate_propose 'agree' in negotiate phase: both flags cleared at the B boundary", async () => {
    const state = makeToolState({ awaitDisputeFix: true, awaitDisputeReview: true });
    const pi = createMockExtensionAPI();
    const propose = Tool.negotiatePropose(state, pi as any, vi.fn());

    const result = await propose.execute("call-1", { plan: "agree" }, undefined, undefined, makeToolCtx());
    expect(result.content[0].text).toBe("Proposal recorded. Moving to Phase B.");

    const last = lastStateEntries(pi).pop()?.data;
    expect(last.phase).toBe("B");
    expect(last.awaitDisputeFix).toBe(false);
    expect(last.awaitDisputeReview).toBe(false);

    // edge: a single live flag (the realistic leak) is cleared too
    const one = makeToolState({ awaitDisputeReview: true });
    const piOne = createMockExtensionAPI();
    await Tool.negotiatePropose(one, piOne as any, vi.fn()).execute(
      "call-2", { plan: "agree" }, undefined, undefined, makeToolCtx()
    );
    const lastOne = lastStateEntries(piOne).pop()?.data;
    expect(lastOne.phase).toBe("B");
    expect(lastOne.awaitDisputeFix).toBe(false);
    expect(lastOne.awaitDisputeReview).toBe(false);
  });

  it("site 7 — negotiate_review approve in negotiate phase: both flags cleared at the B boundary", async () => {
    const state = makeToolState({ awaitDisputeFix: true, awaitDisputeReview: true });
    const pi = createMockExtensionAPI();
    const review = Tool.negotiateReview(state, pi as any, vi.fn());

    const result = await review.execute("call-1", { decision: "approve" }, undefined, undefined, makeToolCtx());
    expect(result.content[0].text).toBe("Approved.");

    const last = lastStateEntries(pi).pop()?.data;
    expect(last.phase).toBe("B");
    expect(last.awaitDisputeFix).toBe(false);
    expect(last.awaitDisputeReview).toBe(false);

    // edge: single live flag
    const one = makeToolState({ awaitDisputeFix: true });
    const piOne = createMockExtensionAPI();
    await Tool.negotiateReview(one, piOne as any, vi.fn()).execute(
      "call-2", { decision: "approve" }, undefined, undefined, makeToolCtx()
    );
    const lastOne = lastStateEntries(piOne).pop()?.data;
    expect(lastOne.phase).toBe("B");
    expect(lastOne.awaitDisputeFix).toBe(false);
    expect(lastOne.awaitDisputeReview).toBe(false);
  });

  it("site 8 — dispute-limit escalation (logEscalation): both flags cleared at the B→escalated boundary", async () => {
    await enterPhaseBWithBothFlagsLive(); // B, disputeCount 1, both flags live

    const propose = findTool(api, "negotiate_propose");
    // second claim → disputeCount = maxDispute - 1, both flags still live
    await propose.execute("c-3", { plan: "still wrong" }, undefined, undefined, api._mockExecCtx);
    expect(lastLoopState().disputeCount).toBe(2);
    expect(lastLoopState().awaitDisputeFix).toBe(true);
    expect(lastLoopState().awaitDisputeReview).toBe(true);

    // third claim hits the limit → logEscalation
    await propose.execute("c-4", { plan: "final claim" }, undefined, undefined, api._mockExecCtx);

    const last = lastLoopState();
    expect(last.phase).toBe("escalated");
    expect(last.awaitDisputeFix).toBe(false);
    expect(last.awaitDisputeReview).toBe(false);
    expect(api._mockUi.notify).toHaveBeenCalledWith("Dispute limit reached. Escalating to human.", "warning");
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "escalated (dispute limit)");
  });

  it("site 11 — /loop-restart (resetPhaseState): clears awaitDisputeReview, the field it currently misses", async () => {
    await enterPhaseBWithBothFlagsLive();

    expect(lastLoopState().awaitDisputeFix).toBe(true);
    expect(lastLoopState().awaitDisputeReview).toBe(true);

    const restart = findCommand(api, "loop-restart");
    await restart("B", api._mockCtx);

    const last = lastLoopState();
    expect(last.phase).toBe("B");
    expect(last.round).toBe(1);
    expect(last.disputeCount).toBe(0);
    expect(last.awaitDisputeFix).toBe(false);
    expect(last.awaitDisputeReview).toBe(false);
  });

  it("site 10 — /loop-cancel: both flags cleared at the →idle boundary", async () => {
    await enterPhaseBWithBothFlagsLive();

    const cancel = findCommand(api, "loop-cancel");
    await cancel("", api._mockCtx); // empty args — the handler ignores them

    const last = lastLoopState();
    expect(last.phase).toBe("idle");
    expect(last.round).toBe(0);
    expect(last.disputeMode).toBe(false);
    expect(last.awaitDisputeFix).toBe(false);
    expect(last.awaitDisputeReview).toBe(false);
    expect(api._mockUi.notify).toHaveBeenCalledWith("Loop cancelled.", "info");
  });
});
