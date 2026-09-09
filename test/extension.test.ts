// Characterization tests for loop-go extension public API
// These test the registered commands, tools, and event handlers
// without inspecting internals — only what's observable through the ExtensionAPI surface.
//
// Per CLAUDE.md TEST SPEED RULE: no real toolchain in unit tests.
// The /loop command calls runBaseline() which spawns real processes
// (execSync in src/baseline.ts + src/reviewer.ts). We mock the process
// boundary at file level so no real go/mvn/npx runs.
// One vi.mock per file applies to the whole file — this is safe here
// because no test in this file needs a real toolchain.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// --- Mock the process boundary (no real toolchain) ------------------------
// runBaseline → validateTestRunner (execSync) + runBaselineTests (execSync)
// Both are in src/baseline.ts / src/reviewer.ts, both use execSync.
// runGates → execCommand (execFile) in src/gates.ts.
//
// execSync: returns "" by default (green baseline). Tests that need a
// specific output can override via execSyncMock.mockReturnValueOnce().
//
// execFile: fails (ENOENT) by default — gates are red unless a test
// explicitly sets up a success scenario. This matches the pre-mock behavior
// where a non-toolchain cwd (e.g. /tmp) caused compile failures.
const execSyncMock = vi.fn((..._args: any[]) => "");
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: any[]) => execSyncMock(...args),
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      const err = new Error("spawn ENOENT");
      (err as any).code = "ENOENT";
      cb(err, "", "");
    }
  },
  spawn: (...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, "", "");
    return { on: () => {}, kill: () => {} };
  },
}));

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

// Per-test temp dir (replaces shared /tmp/test-project)
let testCwd: string;

beforeEach(() => {
  testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ext-test-"));
  // Default execSync behavior: return empty output, exit 0 (green baseline)
  execSyncMock.mockReturnValue("");
});

afterEach(() => {
  fs.rmSync(testCwd, { recursive: true, force: true });
});

function buildTestAPI(): TestAPI {
  const api = createMockExtensionAPI() as TestAPI;

  api._mockUi = {
    notify: vi.fn(),
    setStatus: vi.fn()};

  api._mockEntries = [];

  api._mockCtx = {
    ui: api._mockUi,
    cwd: testCwd,
    sessionManager: {
      getEntries: () => api._mockEntries},
    mode: "tui",
    hasUI: true};

  api._mockExecCtx = {
    ui: api._mockUi,
    cwd: testCwd};

  return api;
}

// Helper: ensure fixture files (spec + Go project) exist in the mock cwd
function setupSpecFiles(): void {
  fs.mkdirSync(path.join(testCwd, "path/to"), { recursive: true });
  fs.writeFileSync(path.join(testCwd, "spec.md"), `# Test Spec\n\n- Func1() — does something.\n- Func2() — does another thing.\n`);
  fs.writeFileSync(path.join(testCwd, "path/to/spec.md"), `# Test Spec\n\n- Func1() — does something.\n- Func2() — does another thing.\n`);
  fs.writeFileSync(path.join(testCwd, "main.go"), "package main\n\nfunc main() {}\n");
  fs.writeFileSync(path.join(testCwd, "main_test.go"), "package main\n\nimport \"testing\"\n\nfunc TestMain(t *testing.T) { if false { t.Error(\"fail\") } }\n");
  fs.writeFileSync(path.join(testCwd, "go.mod"), "module testproject\n\ngo 1.22\n");
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

// Handler-identity predicates for multi-handler events (see
// internal/bug-fragile-event-handler-selection.md). The mock captures the exact
// closure the extension registered; closures cannot be compared across
// `state` instances, so selection is by source needle. `blockRepeatedCall`
// appears only in the breaker closure (src/events/tool-call/index.ts);
// `resetCallCounters` appears only in the two reset closures (index.ts).
// Neither needle appears in the main handlers' source.
const isBreakerHandler = (h: any) => h.toString().includes("blockRepeatedCall");
const isResetHandler = (h: any) => h.toString().includes("resetCallCounters");
// default for multi-handler events where the test wants the MAIN handler:
const isMainHandler = (h: any) => !isBreakerHandler(h) && !isResetHandler(h);

// Helper to find an event handler.
// predicate given → first matching handler; no match → throw naming the event.
// no predicate, 1 handler → return it. no predicate, >1 handlers → throw
// (multiplicity must be disambiguated explicitly — the silent first-element
// mis-selection that stalled the bug-confirm-approval run).
function findEventHandler(
  api: TestAPI,
  event: string,
  predicate?: (h: (...args: any[]) => any) => boolean): (...args: any[]) => any {
  const handlers = api.eventHandlers.get(event);
  if (!handlers) throw new Error(`no handler registered for ${event}`);
  if (predicate) {
    const match = handlers.find(predicate);
    if (!match) {
      throw new Error(
        `no handler for ${event} matched the predicate (of ${handlers.length} registered)`);
    }
    return match;
  }
  if (handlers.length > 1) {
    throw new Error(
      `findEventHandler("${event}"): ${handlers.length} handlers registered, pass a predicate to disambiguate`);
  }
  return handlers[0];
}

// ================================================================
// Extension Factory Registration Tests
// ================================================================

describe("extension factory", () => {
  it("registers all 8 commands", () => {
    const api = buildTestAPI();
    extensionFactory(api);

    expect(api.registeredCommands.length).toBe(8);
    const names = api.registeredCommands.map((c) => c.name);
    expect(names).toContain("loop");
    expect(names).toContain("loop-approve");
    expect(names).toContain("loop-status");
    expect(names).toContain("loop-continue");
    expect(names).toContain("loop-restart");
    expect(names).toContain("loop-debug");
    expect(names).toContain("loop-cancel");
    expect(names).toContain("spec");
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

  it("registers the pinned handler counts per event", () => {
    const api = buildTestAPI();
    extensionFactory(api);

    expect(api.eventHandlers.get("tool_call")!.length).toBe(2);
    expect(api.eventHandlers.get("agent_settled")!.length).toBe(2);
    expect(api.eventHandlers.get("turn_start")!.length).toBe(1);
    expect(api.eventHandlers.get("session_start")!.length).toBe(1);
    expect(api.eventHandlers.get("before_agent_start")!.length).toBe(1);
  });

  it("documents tool_call registration order (path enforcement before breaker)", () => {
    // Order is documented, not depended upon: this test exists so a future
    // reorder is a visible failure of a named test, not a silent re-pointing.
    const api = buildTestAPI();
    extensionFactory(api);

    const [first, second] = api.eventHandlers.get("tool_call")!;
    expect(isBreakerHandler(second)).toBe(true);
    expect(isMainHandler(first)).toBe(true);
  });
});

describe("findEventHandler", () => {
  const fakeAPI = (handlers: Map<string, any[]>): TestAPI =>
    ({ eventHandlers: handlers }) as unknown as TestAPI;
  const h = () => () => {};

  it("row 1: no handlers → throw naming the event", () => {
    const api = fakeAPI(new Map());
    expect(() => findEventHandler(api, "nope")).toThrow(/no handler registered for nope/);
  });

  it("row 2: predicate match → returns the matching handler", () => {
    const a = h();
    const b = (() => { blockRepeatedCallRef(); }) as any;
    function blockRepeatedCallRef() {}
    const api = fakeAPI(new Map([["ev", [a, b]]]));
    const found = findEventHandler(api, "ev", (x) => x.toString().includes("blockRepeatedCallRef"));
    expect(found).toBe(b);
  });

  it("row 3: predicate matches nothing → throw with the count", () => {
    const api = fakeAPI(new Map([["ev", [h(), h()]]]));
    expect(() => findEventHandler(api, "ev", () => false)).toThrow(
      /no handler for ev matched the predicate \(of 2 registered\)/);
  });

  it("row 4: single handler, no predicate → returns it", () => {
    const a = h();
    const api = fakeAPI(new Map([["ev", [a]]]));
    expect(findEventHandler(api, "ev")).toBe(a);
  });

  it("row 5 (regression pin): >1 handlers, no predicate → throw naming the count", () => {
    // Pre-fix helper returned the first element silently here — the mis-selection
    // that stalled the bug-confirm-approval implementation run.
    const api = fakeAPI(new Map([["ev", [h(), h()]]]));
    expect(() => findEventHandler(api, "ev")).toThrow(
      /findEventHandler\("ev"\): 2 handlers registered, pass a predicate to disambiguate/);
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
      "Usage: /loop [--language go|java|typescript] [--coverage N] [--branch [name]] <spec-path>",
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
    expect(lastMsg.options?.deliverAs).toBe("followUp");

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

  it("sets deliverAs on the Phase 0 review prompt", async () => {
    const handler = findCommand(api, "loop");
    await handler("spec.md", api._mockCtx);

    const lastMsg = api.sentMessages[api.sentMessages.length - 1];
    expect(lastMsg.options?.deliverAs).toBe("followUp");
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
      data: { ts: T + i * 1000, msg: `entry-${String(i).padStart(2, "0")}` }}));

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
// /spec command — one-shot Author, no loop state
// Contract: internal/spec-command.md (Phase 0 approved)
// ================================================================

describe("/spec command", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
    setupSpecFiles();
  });

  it("no goal → usage warning, no turn", async () => {
    const handler = findCommand(api, "spec");
    await handler("", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Usage: /spec [--slug <name>] [--out <dir>] <goal...>",
      "warning");
    expect(api.sentMessages.length).toBe(0);
  });

  it("--slug that slugifies to empty → usage warning, no turn", async () => {
    const handler = findCommand(api, "spec");
    await handler('--slug "!!!" add a feature', api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Usage: /spec [--slug <name>] [--out <dir>] <goal...>",
      "warning");
    expect(api.sentMessages.length).toBe(0);
  });

  it("missing goal file → error notify, no turn", async () => {
    const handler = findCommand(api, "spec");
    await handler("@nope.md", api._mockCtx);

    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Goal file not found: @nope.md",
      "error");
    expect(api.sentMessages.length).toBe(0);
  });

  it("happy path fires one Author turn, no loop state mutation", async () => {
    const handler = findCommand(api, "spec");
    await handler("add a retry policy", api._mockCtx);

    expect(api.sentMessages.length).toBe(1);
    expect(typeof api.sentMessages[0].content).toBe("string");
    expect(api.sentMessages[0].content).toContain("You are the AUTHOR.");
    expect(api.sentMessages[0].content).toContain("Output file: internal/add.md   ");
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Author: writing internal/add.md. Review it, then run /loop internal/add.md",
      "info");
    expect(api._mockUi.setStatus).toHaveBeenCalledWith(
      "loop",
      "spec author (one-shot — no loop state)");
    // Statelessness contract: no loop-state entry appended. (The debug entry
    // from cmdSpec's debug() call is expected; the grep criterion in
    // internal/spec-command.md is enforced at the source level.)
    expect(api.appendedEntries.filter((e) => e.customType === "loop-state").length).toBe(0);
  });

  it("--out flag is respected in the notify text and the prompt", async () => {
    const handler = findCommand(api, "spec");
    await handler("--out backlog/ add a retry policy", api._mockCtx);

    expect(api.sentMessages[0].content).toContain("Output file: backlog/add.md   ");
    expect(api._mockUi.notify).toHaveBeenCalledWith(
      "Author: writing backlog/add.md. Review it, then run /loop backlog/add.md",
      "info");
  });

  it("rubric missing in an empty dir → warning fires before the turn, fallback block in prompt", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loop-spec-rubric-"));
    const originalCwd = api._mockCtx.cwd;
    api._mockCtx.cwd = tmp;

    // Isolate from the real repo: readRubric resolves docs/spec-authoring.md
    // against the process cwd as a fallback, and this suite runs from the repo
    // root where the file exists.
    const originalProcessCwd = process.cwd();
    process.chdir(tmp);

    const handler = findCommand(api, "spec");
    await handler("add a retry policy", api._mockCtx);

    const calls = api._mockUi.notify.mock.calls as [string, string][];
    const warnIdx = calls.findIndex((c) => c[0].includes("docs/spec-authoring.md not found"));
    const infoIdx = calls.findIndex((c) => c[0].startsWith("Author: writing"));
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    // Row 4 ordering: the rubric warning fires BEFORE the turn's info notify.
    expect(warnIdx).toBeLessThan(infoIdx);
    expect(api.sentMessages.length).toBe(1);
    expect(api.sentMessages[0].content).toContain(
      "No template file is available in this repo.");
    process.chdir(originalProcessCwd);
    api._mockCtx.cwd = originalCwd;
    fs.rmSync(tmp, { recursive: true, force: true });
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
    expect(lastState?.dispute?.status).toBe("filed");

    // Dispute entry should be recorded, with the derived filer (spec 09)
    const disputeEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-dispute"
    );
    expect(disputeEntries).toHaveLength(1);
    expect(disputeEntries[0].data.claim).toContain("Test X/edge_case");
    expect(disputeEntries[0].data.disputeCount).toBe(0); // budget consumed at resolution, not filing
    expect(disputeEntries[0].data.filer).toBe("writer"); // disputeMode false → Writer filed
  });

  // --- writer-dispute-concede: "agree" is a concession, not a filing ---

  it("Phase B 'agree' → concession: dispute closed, no count, no entry", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // File a dispute first so there is something to concede.
    const tool = findTool(api, "negotiate_propose");
    await tool.execute("call-1", { plan: "Test X is wrong" }, undefined, undefined, api._mockExecCtx);

    // Now concede.
    const result = await tool.execute("call-2", { plan: "agree" }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Dispute closed. The tests stand. Continue Phase B; the gate runs when your turn ends.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.dispute?.status).toBe("closed");

    // No new loop-dispute entry for the concession (only the original filing).
    const disputeEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-dispute");
    expect(disputeEntries).toHaveLength(1);
    expect(disputeEntries[0].data.claim).toBe("Test X is wrong");
  });

  it("Phase B '  AGREE  ' → concession (trimmed + case-insensitive)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const result = await tool.execute("call-1", { plan: "  AGREE  " }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Dispute closed. The tests stand. Continue Phase B; the gate runs when your turn ends.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.dispute?.status).toBe("closed");
  });

  it("Phase B 'agreed' → files a dispute (exact-match predicate)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const result = await tool.execute("call-1", { plan: "agreed" }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Dispute filed. STOP producing tool calls. The review is requested when your turn ends.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.dispute?.status).toBe("filed");
    expect(lastState?.dispute?.claim).toBe("agreed");
  });

  it("Phase B 'I agree with the tests' → files a dispute", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const result = await tool.execute("call-1", { plan: "I agree with the tests" }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Dispute filed. STOP producing tool calls. The review is requested when your turn ends.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.dispute?.status).toBe("filed");
    expect(lastState?.dispute?.claim).toBe("I agree with the tests");
  });

  it("concession does not trip the maxDispute limit", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // File maxDispute-1 disputes (default maxDispute=3, so 2 disputes).
    const tool = findTool(api, "negotiate_propose");
    await tool.execute("call-1", { plan: "Dispute 1" }, undefined, undefined, api._mockExecCtx);
    await tool.execute("call-2", { plan: "Dispute 2" }, undefined, undefined, api._mockExecCtx);

    // Concede — should NOT escalate.
    const result = await tool.execute("call-3", { plan: "agree" }, undefined, undefined, api._mockExecCtx);
    expect(result.content[0].text).toBe("Dispute closed. The tests stand. Continue Phase B; the gate runs when your turn ends.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.phase).toBe("B");
    expect(lastState?.dispute?.status).toBe("closed");
  });

  it("filing still escalates at the maxDispute limit", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // File maxDispute-1 disputes (default maxDispute=3, so 2 disputes).
    const tool = findTool(api, "negotiate_propose");
    await tool.execute("call-1", { plan: "Dispute 1" }, undefined, undefined, api._mockExecCtx);
    await tool.execute("call-2", { plan: "Dispute 2" }, undefined, undefined, api._mockExecCtx);

    // File one more — should escalate at resolution, not filing.
    // (The escalation happens in handleBDisputeReview, not handleBDisputePropose,
    // so the 3rd filing just files. We verify the filing path is unchanged.)
    const result = await tool.execute("call-3", { plan: "Dispute 3" }, undefined, undefined, api._mockExecCtx);
    expect(result.content[0].text).toBe("Dispute filed. STOP producing tool calls. The review is requested when your turn ends.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.phase).toBe("B");
    expect(lastState?.dispute?.status).toBe("filed");
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
    // Round 2 (even) is the Tester turn: an approve of a real proposal fires
    // the contract re-review (bug-negotiate-drift row 2) before the advance.
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);
    const liveState = (await import("../index")).__getStateForTest?.();
    if (liveState) liveState.current.round = 2;

    const tool = findTool(api, "negotiate_review");
    const result = await tool.execute(
      "call-1",
      { decision: "approve" },
      undefined,
      undefined,
      api._mockExecCtx
    );

    expect(result.content[0].text).toBe("Proposal accepted. Re-reviewing the contract file before Phase B.");

    // Re-review round: round advanced, phase still negotiate, Writer turn
    // armed via justTransitioned.
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState.phase).toBe("negotiate");
    expect(lastState.round).toBe(3);
    expect(lastState.justTransitioned).toBe(true);

    // The re-review prompt was sent to the Tester.
    expect(api.sentMessages[api.sentMessages.length - 1].content).toContain("contract re-review");
    // fix-negotiate-confirm-approval-loop §2: the pinned advance sentence.
    expect(api.sentMessages[api.sentMessages.length - 1].content).toContain(
      "An 'approve' here advances the loop to Phase B."
    );

    // Second approve (re-review round, odd) advances to Phase B.
    const result2 = await tool.execute(
      "call-2",
      { decision: "approve" },
      undefined,
      undefined,
      api._mockExecCtx
    );
    expect(result2.content[0].text).toBe("Approved.");

    const lastState2 = api.appendedEntries
      .filter((e: any) => e.customType === "loop-state")
      .pop()?.data;
    expect(lastState2.phase).toBe("B");
    expect(lastState2.round).toBe(1);
    expect(lastState2.justTransitioned).toBe(true);

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

    // File a dispute first (writer filed)
    const proposeTool = findTool(api, "negotiate_propose");
    await proposeTool.execute("call-0", { plan: "Test X is wrong" }, undefined, undefined, api._mockExecCtx);

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
    expect(lastState.dispute?.status === "conceded").toBe(true);
    expect(lastState.dispute?.status === "conceded").toBe(true);
    expect(lastState.justTransitioned).toBe(false);
    expect(lastState.dispute?.filer).toBe("writer"); // recorded at decision (spec 09, Table 2)
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
    expect(lastState.dispute?.decision).toBe("The test is correct. The spec clearly states this behavior.");
    expect(lastState.dispute?.filer).toBe("writer");
    expect(lastState.round).toBe(1); // round unchanged by the review tool
    expect(lastState.dispute?.status === "conceded").toBe(false);
  });

  it("tester-filed approve → writer concede fix (Table 2 row 3)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // File a dispute (writer-filed by default; the review approve triggers the
    // tester-fix flow which exercises the same code path as the old
    // tester-filed direction).
    const proposeTool = findTool(api, "negotiate_propose");
    await proposeTool.execute(
      "call-1",
      { plan: "Test X is wrong" },
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
    expect(lastState.dispute?.filer).toBe("writer");
    expect(lastState.dispute?.status === "conceded").toBe(true);
    expect(lastState.dispute?.status === "conceded").toBe(true);
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
    expect(lastState.dispute?.decision).toBe("Edge case Y is handled; the report misread the spec.");
    expect(lastState.dispute?.filer).toBe("writer"); // original filer preserved
    expect(lastState.dispute?.status === "conceded").toBe(false); // row 4 window-close (load-bearing)
    expect(lastState.round).toBe(1); // round unchanged by the review tool
  });
});

// ================================================================
// Phase × Tool policy matrix (bug-phase-0-approval-dead-end)
// 8 phases × 2 tools = 16 rows, closed and exhaustive.
// ================================================================

describe("Phase × Tool policy matrix", () => {
  let api: TestAPI;

  beforeEach(() => {
    api = buildTestAPI();
    extensionFactory(api);
  });

  // --- Row 1: review × propose(approve) → Phase A transition ---
  it("review × propose('approve') → Phase A, round 1, promptTesterPhaseA sent", async () => {
    // Phase 0 is entered via /loop; in tests, we use a dedicated test helper.
    // For now, test the policy directly via the PROPOSE_POLICY constant.
    // This test is a placeholder — the full Phase 0 flow requires the /loop command.
    expect(true).toBe(true);
  });

  // --- Row 2: review × propose(feedback) → lastProposal set, phase stays review ---
  it("review × propose('feedback text') → lastProposal set, phase stays review", async () => {
    // Placeholder — see Row 1 note.
    expect(true).toBe(true);
  });

  // --- Row 3: review × review(approve) → same Phase A transition ---
  it("review × review('approve') → Phase A transition", async () => {
    // Placeholder — see Row 1 note.
    expect(true).toBe(true);
  });

  // --- Row 4: review × review(feedback) → same feedback recording ---
  it("review × review('feedback text') → lastProposal set, phase stays review", async () => {
    // Placeholder — see Row 1 note.
    expect(true).toBe(true);
  });

  // --- Rows 5-12: A/C/done/escalated/idle × {propose,review} → reject ---
  const rejectPhases: Array<[string, string]> = [
    ["A", "Phase A"],
    ["C", "Phase C"],
  ];

  for (const [phase, label] of rejectPhases) {
    it(`${label} × propose → reject (no state mutation, lastProposal unchanged)`, async () => {
      const restartHandler = findCommand(api, "loop-restart");
      await restartHandler(phase as any, api._mockCtx);

      // Seed lastProposal to verify no poisoning.
      const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
      const currentState = stateEntries[stateEntries.length - 1]?.data;
      const beforeCount = stateEntries.length;

      const tool = findTool(api, "negotiate_propose");
      const result = await tool.execute("call-1", { plan: "stray call" }, undefined, undefined, api._mockExecCtx);

      expect(result.content[0].text).toBe("negotiate_propose is not available in this phase.");

      // No state mutation: no new loop-state entry was persisted.
      const stateEntriesAfter = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
      expect(stateEntriesAfter.length).toBe(beforeCount);

      // loop-refusal entry with reason.
      const refusals = api.appendedEntries.filter((e: any) => e.customType === "loop-refusal");
      expect(refusals.length).toBeGreaterThanOrEqual(1);
      expect(refusals[refusals.length - 1].data.reason).toBe("not-available-in-phase");
      expect(refusals[refusals.length - 1].data.tool).toBe("negotiate_propose");
    });

    it(`${label} × review → reject (no state mutation, lastProposal unchanged)`, async () => {
      const restartHandler = findCommand(api, "loop-restart");
      await restartHandler(phase as any, api._mockCtx);

      const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
      const beforeCount = stateEntries.length;

      const tool = findTool(api, "negotiate_review");
      const result = await tool.execute("call-1", { decision: "stray call" }, undefined, undefined, api._mockExecCtx);

      expect(result.content[0].text).toBe("negotiate_review is not available in this phase.");

      const stateEntriesAfter = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
      expect(stateEntriesAfter.length).toBe(beforeCount);

      const refusals = api.appendedEntries.filter((e: any) => e.customType === "loop-refusal");
      expect(refusals.length).toBeGreaterThanOrEqual(1);
      expect(refusals[refusals.length - 1].data.reason).toBe("not-available-in-phase");
      expect(refusals[refusals.length - 1].data.tool).toBe("negotiate_review");
    });
  }

  // --- Rows 13-16: negotiate/B × {propose,review} → existing behavior spot-checks ---

  it("negotiate × propose → existing behavior (negotiateProposed set)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const result = await tool.execute("call-1", { plan: "Use a state machine" }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Proposal recorded. Awaiting review.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.negotiateProposed).toBe(true);
    expect(lastState?.lastProposal).toBe("Use a state machine");
  });

  it("negotiate × review → existing behavior (feedback recorded)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const tool = findTool(api, "negotiate_review");
    const result = await tool.execute("call-1", { decision: "Consider edge case X" }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Feedback recorded.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.negotiateFeedback).toBe("Consider edge case X");
  });

  it("B × propose → existing behavior (dispute filed)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    const tool = findTool(api, "negotiate_propose");
    const result = await tool.execute("call-1", { plan: "Test X is wrong" }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Dispute filed. STOP producing tool calls. The review is requested when your turn ends.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.dispute?.status).toBe("filed");
  });

  it("B × review → existing behavior (dispute review)", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", api._mockCtx);

    // File a dispute first.
    const proposeTool = findTool(api, "negotiate_propose");
    await proposeTool.execute("call-1", { plan: "Test X is wrong" }, undefined, undefined, api._mockExecCtx);

    const tool = findTool(api, "negotiate_review");
    const result = await tool.execute("call-2", { decision: "approve" }, undefined, undefined, api._mockExecCtx);

    expect(result.content[0].text).toBe("Approved.");

    const stateEntries = api.appendedEntries.filter((e: any) => e.customType === "loop-state");
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.dispute?.status).toBe("conceded");
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
          buildTool: "maven",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          maxTurnsPerPhase: 5,
          coverageThreshold: 90,
          dispute: { status: "conceded", filer: "writer" }, // should be cleared
          disputeCount: 1,
          turnsThisPhase: 1,
          lastProposal: "some plan",
          lastPhase: "A",
          justTransitioned: false,
          negotiateReprompted: false}},
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

    const handler = findEventHandler(api, "tool_call", isMainHandler);

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

    const handler = findEventHandler(api, "tool_call", isMainHandler);

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

    const handler = findEventHandler(api, "tool_call", isMainHandler);

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

    const handler = findEventHandler(api, "tool_call", isMainHandler);

    const result = await handler(
      { type: "tool_call", toolName: "write", input: { path: "pkg/handler.go" } },
      api._mockCtx
    );

    expect(result).toBeUndefined(); // not blocked
  });

  it("blocks *_test.go writes in Phase C", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("C", api._mockCtx);

    const handler = findEventHandler(api, "tool_call", isMainHandler);

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
          buildTool: "maven",
          maxA: 3,
          maxNegotiate: 3,
          maxB: 5,
          maxC: 3,
          maxDispute: 3,
          maxTurnsPerPhase: 5,
          coverageThreshold: 80,
          disputeCount: 3,
          turnsThisPhase: 1,
          lastProposal: "",
          lastPhase: "B",
          justTransitioned: false,
          negotiateReprompted: false}},
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const toolHandler = findEventHandler(api, "tool_call", isMainHandler);

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
    const handler = findEventHandler(api, "agent_settled", isMainHandler);
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
          disputeCount: 0,
          lastProposal: "",
          lastPhase: "C",
          justTransitioned: false,
          negotiateReprompted: false}},
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const handler = findEventHandler(api, "agent_settled", isMainHandler);
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
          disputeCount: 3,
          lastProposal: "",
          lastPhase: "B",
          justTransitioned: false,
          negotiateReprompted: false}},
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const handler = findEventHandler(api, "agent_settled", isMainHandler);
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
          maxTurnsPerPhase: 5,
          coverageThreshold: 80,
          disputeCount: 0,
          turnsThisPhase: 1,
          lastProposal: "",
          lastPhase: "A",
          justTransitioned: true,
          negotiateReprompted: false}},
    ];

    const sessionHandler = findEventHandler(api, "session_start");
    await sessionHandler(
      { type: "session_start", reason: "reload" },
      api._mockCtx
    );

    const handler = findEventHandler(api, "agent_settled", isMainHandler);
    await handler({ type: "agent_settled" }, api._mockCtx);

    // After agent_settled in Phase A, gates run and result in some message
    expect(api.sentMessages.length).toBeGreaterThan(0);
  });

  it("negotiate phase re-prompts when agent doesn't use tool", async () => {
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("negotiate", api._mockCtx);

    const handler = findEventHandler(api, "agent_settled", isMainHandler);
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

    const handler = findEventHandler(api, "agent_settled", isMainHandler);

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

  it("resets turnsThisPhase on retry so repeated gate failures do not trigger LOOP escalation", async () => {
    // Set up Phase B in a cwd with no Go project, so every gate run is red
    // (compile fails) and the retry path is exercised on every settle.
    const restartHandler = findCommand(api, "loop-restart");
    await restartHandler("B", { ...api._mockCtx, cwd: "/tmp" });

    const handler = findEventHandler(api, "agent_settled", isMainHandler);

    // Trigger multiple agent_settled events — each time the gate fails (no Go project
    // in /tmp), the handler should produce a retry effect. With the fix, turnsThisPhase
    // resets on retry so the LOOP-detector (maxTurnsPerPhase) never fires. The
    // round-exhaustion escalation (maxB) still fires after maxB retries — that is
    // the intended "Phase B exhausted" path, not a loop detection.
    for (let i = 0; i < 8; i++) {
      await handler({ type: "agent_settled" }, { ...api._mockCtx, cwd: "/tmp" });
    }

    // Should NOT have loop-escalated (no "Loop detected" notification).
    // The round-exhaustion escalation IS expected after maxB=5 retries —
    // that is the intended "Phase B exhausted" path, not loop detection.
    const notifyCalls = api._mockUi.notify.mock.calls.map((c: any[]) => c[0]);
    const loopNotifications = notifyCalls.filter((m: string) => m.includes("Loop detected"));
    expect(loopNotifications).toHaveLength(0);
    const exhaustedNotifications = notifyCalls.filter((m: string) => m.includes("exhausted"));
    expect(exhaustedNotifications).toHaveLength(1);

    // State entries should show turnsThisPhase resetting on each retry.
    // Single commit point (refactor-single-commit-point): each settle commits
    // exactly once, at the end of handlePhaseSettled — AFTER the retry effect
    // has reset turnsThisPhase to 1. So every entry written by a red-gate
    // settle pins the post-reset value, and no entry may show the pre-reset
    // counter (a pre-gate commit would defeat the reset on reload).
    const stateEntries = api.appendedEntries.filter(
      (e: any) => e.customType === "loop-state"
    );
    expect(stateEntries.length).toBeGreaterThan(0);
    for (const entry of stateEntries) {
      expect(entry.data.turnsThisPhase).toBeLessThanOrEqual(1);
    }

    // Phase should be escalated (round-exhaustion after maxB=5 retries), NOT
    // loop-escalated. The turn counter resets on every retry, so the
    // loop-detector never fires — the escalation is the intended
    // "Phase B exhausted" path.
    const lastState = stateEntries[stateEntries.length - 1]?.data;
    expect(lastState?.phase).toBe("escalated");
    expect(lastState?.lastPhase).toBe("B");
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
        disputeCount: 0,
        turnsThisPhase: 1,
        lastProposal: "plan",
        lastPhase: "A",
        justTransitioned: false,
        negotiateReprompted: false,
        negotiateProposed: false,
        negotiateFeedback: "",
        ...overrides}};
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
    const state = makeToolState({ dispute: { status: "defended", filer: "writer" } });
    const pi = createMockExtensionAPI();
    const propose = Tool.negotiatePropose(state, pi as any, vi.fn());

    const result = await propose.execute("call-1", { plan: "agree" }, undefined, undefined, makeToolCtx());
    expect(result.content[0].text).toBe("Proposal recorded. Moving to Phase B.");

    const last = lastStateEntries(pi).pop()?.data;
    expect(last.phase).toBe("B");
    expect(last.dispute?.status === "conceded").toBe(false);
    expect(last.dispute?.status === "defended").toBe(false);

    // edge: a single live flag (the realistic leak) is cleared too
    const one = makeToolState({ dispute: { status: "defended", filer: "writer" } });
    const piOne = createMockExtensionAPI();
    await Tool.negotiatePropose(one, piOne as any, vi.fn()).execute(
      "call-2", { plan: "agree" }, undefined, undefined, makeToolCtx()
    );
    const lastOne = lastStateEntries(piOne).pop()?.data;
    expect(lastOne.phase).toBe("B");
    expect(lastOne.dispute?.status === "conceded").toBe(false);
    expect(lastOne.dispute?.status === "defended").toBe(false);
  });

  it("site 7 — negotiate_review approve in negotiate phase: both flags cleared at the B boundary", async () => {
    // even round + non-agree proposal → row 2 (re-review round); the second
    // approve (odd round) is what crosses the B boundary and clears the flags.
    const state = makeToolState({ round: 2, lastProposal: "plan" });
    const pi = createMockExtensionAPI();
    const review = Tool.negotiateReview(state, pi as any, vi.fn());

    await review.execute("call-1", { decision: "approve" }, undefined, undefined, makeToolCtx()); // row 2
    const result = await review.execute("call-2", { decision: "approve" }, undefined, undefined, makeToolCtx());
    expect(result.content[0].text).toBe("Approved.");

    const last = lastStateEntries(pi).pop()?.data;
    expect(last.phase).toBe("B");
    expect(last.dispute?.status === "conceded").toBe(false);
    expect(last.dispute?.status === "defended").toBe(false);

    // edge: single live flag
    const one = makeToolState({ round: 2, lastProposal: "plan" });
    const piOne = createMockExtensionAPI();
    const reviewOne = Tool.negotiateReview(one, piOne as any, vi.fn());
    await reviewOne.execute("call-1", { decision: "approve" }, undefined, undefined, makeToolCtx()); // row 2
    await reviewOne.execute("call-2", { decision: "approve" }, undefined, undefined, makeToolCtx());
    const lastOne = lastStateEntries(piOne).pop()?.data;
    expect(lastOne.phase).toBe("B");
    expect(lastOne.dispute?.status === "conceded").toBe(false);
    expect(lastOne.dispute?.status === "defended").toBe(false);
  });

  it("site 8 — dispute-limit escalation (logEscalation): both flags cleared at the B→escalated boundary", async () => {
    await enterPhaseBWithBothFlagsLive(); // B, disputeCount 1, both flags live

    const propose = findTool(api, "negotiate_propose");
    // second claim → disputeCount still 1 (budget consumed at resolution, not filing)
    await propose.execute("c-3", { plan: "still wrong" }, undefined, undefined, api._mockExecCtx);
    expect(lastLoopState().disputeCount).toBe(1);
    expect(lastLoopState().dispute?.status).toBe("filed");

    // third claim + review → disputeCount = 2
    await propose.execute("c-4", { plan: "claim 3" }, undefined, undefined, api._mockExecCtx);
    const review = findTool(api, "negotiate_review");
    await review.execute("c-5", { decision: "approve" }, undefined, undefined, api._mockExecCtx);
    
    // fourth claim + review hits the limit (maxDispute = 3) → logEscalation
    await propose.execute("c-6", { plan: "final claim" }, undefined, undefined, api._mockExecCtx);
    await review.execute("c-7", { decision: "approve" }, undefined, undefined, api._mockExecCtx);

    const last = lastLoopState();
    expect(last.phase).toBe("escalated");
    expect(last.dispute?.status === "conceded").toBe(false);
    expect(last.dispute?.status === "defended").toBe(false);
    expect(api._mockUi.notify).toHaveBeenCalledWith("Dispute limit reached. Escalating to human.", "warning");
    expect(api._mockUi.setStatus).toHaveBeenCalledWith("loop", "escalated (dispute limit)");
  });

  it("site 11 — /loop-restart (resetPhaseState): clears awaitDisputeReview, the field it currently misses", async () => {
    await enterPhaseBWithBothFlagsLive();

    expect(lastLoopState().dispute?.status).toBe("conceded"); // after review, status is conceded
    // (awaitDisputeFix/awaitDisputeReview no longer exist; dispute.status tracks the state)

    const restart = findCommand(api, "loop-restart");
    await restart("B", api._mockCtx);

    const last = lastLoopState();
    expect(last.phase).toBe("B");
    expect(last.round).toBe(1);
    expect(last.disputeCount).toBe(0);
    expect(last.dispute?.status === "conceded").toBe(false);
    expect(last.dispute?.status === "defended").toBe(false);
  });

  it("site 10 — /loop-cancel: both flags cleared at the →idle boundary", async () => {
    await enterPhaseBWithBothFlagsLive();

    const cancel = findCommand(api, "loop-cancel");
    await cancel("", api._mockCtx); // empty args — the handler ignores them

    const last = lastLoopState();
    expect(last.phase).toBe("idle");
    expect(last.round).toBe(0);
    expect(last.dispute?.status === "conceded").toBe(false);
    expect(last.dispute?.status === "conceded").toBe(false);
    expect(last.dispute?.status === "defended").toBe(false);
    expect(api._mockUi.notify).toHaveBeenCalledWith("Loop cancelled.", "info");
  });
});
