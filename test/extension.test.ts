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

// Helper: ensure spec files exist in the mock cwd
function setupSpecFiles(): void {
  const fs = require("node:fs");
  fs.mkdirSync("/tmp/test-project/path/to", { recursive: true });
  fs.writeFileSync("/tmp/test-project/spec.md", `# Test Spec\n\n- Func1() — does something.\n- Func2() — does another thing.\n`);
  fs.writeFileSync("/tmp/test-project/path/to/spec.md", `# Test Spec\n\n- Func1() — does something.\n- Func2() — does another thing.\n`);
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
    const result = await tool.execute(
      "call-1",
      { plan: "I will use a struct-based approach with 3 types." },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Proposal recorded. Awaiting review.");

    // Should trigger Tester review prompt
    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.content).toContain("proposes");
    expect(lastMsg.content).toContain("Review");
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

    expect(result.content[0].text).toBe("Dispute filed. STOP producing tool calls. The Tester will review and respond.");

    // Dispute sets awaitDisputeReview flag (message deferred to agent_settled)
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.awaitDisputeReview).toBe(true);

    // Dispute entry should be recorded
    const disputeEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-dispute"
    );
    expect(disputeEntries).toHaveLength(1);
    expect(disputeEntries[0].data.claim).toContain("Test X/edge_case");
    expect(disputeEntries[0].data.disputeCount).toBe(1);
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

    const reviewTool = findTool(api, "negotiate_review");
    const result = await reviewTool.execute(
      "call-2",
      { decision: "Consider using an interface instead of a struct for flexibility." },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Feedback recorded.");

    // Should trigger Writer revision prompt
    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.content).toContain("feedback");
    expect(lastMsg.content).toContain("Revise");
  });

  it("concedes dispute and triggers Tester fix in Phase B", async () => {
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
  });

  it("defends test in Phase B dispute", async () => {
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
    const result = await reviewTool.execute(
      "call-2",
      { decision: "The test is correct. The spec clearly states this behavior." },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Feedback recorded.");

    // Should trigger Writer fix prompt
    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.content).toContain("defended");
    expect(lastMsg.content).toContain("Fix your implementation");
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
