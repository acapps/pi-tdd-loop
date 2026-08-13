// Unit tests for graphify-integration module

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("graphify-integration", () => {
  let mod: any;

  beforeEach(async () => {
    vi.resetModules();

    // Mock execSync before importing the module
    const execSyncMock = vi.fn();
    const cpMock = { execSync: execSyncMock };
    vi.doMock("node:child_process", () => cpMock);

    mod = await import("../src/graphify-integration");
    mod.execSyncMock = execSyncMock; // store reference for assertions
  });

  describe("isGraphifyAvailable", () => {
    it("returns true when graphify is on PATH", () => {
      mod.execSyncMock.mockReturnValue("/usr/local/bin/graphify");
      expect(mod.isGraphifyAvailable()).toBe(true);
    });

    it("returns false when graphify is not on PATH", () => {
      mod.execSyncMock.mockImplementation(() => {
        throw new Error("command not found");
      });
      expect(mod.isGraphifyAvailable()).toBe(false);
    });

    it("caches the result", () => {
      mod.execSyncMock.mockReturnValue("/usr/local/bin/graphify");
      mod.isGraphifyAvailable();
      mod.isGraphifyAvailable();
      mod.isGraphifyAvailable();
      expect(mod.execSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("ensureGraph", () => {
    it("skips gracefully when graphify is not available", () => {
      mod.execSyncMock.mockImplementation(() => {
        throw new Error("command not found");
      });

      const debug = vi.fn();
      const result = mod.ensureGraph("/tmp/project", "build", debug);

      expect(result).toBe(false);
      expect(debug).toHaveBeenCalledWith("graphify: not available on PATH, skipping");
    });

    it("runs build mode when graphify is available", () => {
      // First call: availability check, second: actual build
      mod.execSyncMock
        .mockReturnValueOnce("/usr/local/bin/graphify") // command -v
        .mockReturnValueOnce("Graph complete. 42 nodes, 15 edges"); // graphify build

      const debug = vi.fn();
      const result = mod.ensureGraph("/tmp/project", "build", debug);

      expect(result).toBe(true);
      expect(mod.execSyncMock).toHaveBeenCalledTimes(2);
      expect(debug).toHaveBeenCalledWith(expect.stringMatching(/graphify: success \(\d+ chars output\)/));
    });

    it("runs update mode when graphify is available", () => {
      mod.execSyncMock
        .mockReturnValueOnce("/usr/local/bin/graphify")
        .mockReturnValueOnce("Updated 3 files");

      const debug = vi.fn();
      const result = mod.ensureGraph("/tmp/project", "update", debug);

      expect(result).toBe(true);
      const buildCall = mod.execSyncMock.mock.calls[1][0] as string;
      expect(buildCall).toContain("--update");
    });

    it("handles graphify failure gracefully", () => {
      mod.execSyncMock
        .mockReturnValueOnce("/usr/local/bin/graphify") // availability check passes
        .mockImplementation(() => { // but build fails
          const e: any = new Error("graphify failed");
          e.stderr = "Error: no files found";
          throw e;
        });

      const debug = vi.fn();
      const result = mod.ensureGraph("/tmp/project", "build", debug);

      expect(result).toBe(false);
      expect(debug).toHaveBeenCalledWith("graphify: failed — Error: no files found");
    });

    it("resets cache between calls via resetCache", () => {
      // First: available
      mod.execSyncMock.mockReturnValue("/usr/local/bin/graphify");
      expect(mod.isGraphifyAvailable()).toBe(true);

      // Reset and mock as unavailable
      mod.resetCache();
      mod.execSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });
      expect(mod.isGraphifyAvailable()).toBe(false);
    });
  });
});
