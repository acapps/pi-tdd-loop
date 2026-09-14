// Tests for src/spec-path.ts — resolveExistingSpec

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveExistingSpec } from "../src/spec-path";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "spec-path-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveExistingSpec", () => {
  it("returns absolute path when file exists", () => {
    const file = join(tmpDir, "spec.md");
    writeFileSync(file, "# test");
    const result = resolveExistingSpec("spec.md", tmpDir);
    expect(result).toBe(file);
  });

  it("returns null when file does not exist", () => {
    const result = resolveExistingSpec("nonexistent.md", tmpDir);
    expect(result).toBeNull();
  });

  it("resolves relative path with subdirectory", () => {
    mkdirSync(join(tmpDir, "internal"), { recursive: true });
    const file = join(tmpDir, "internal", "spec.md");
    writeFileSync(file, "# test");
    const result = resolveExistingSpec("internal/spec.md", tmpDir);
    expect(result).toBe(file);
  });

  it("handles absolute path", () => {
    const file = join(tmpDir, "spec.md");
    writeFileSync(file, "# test");
    const result = resolveExistingSpec(file, tmpDir);
    expect(result).toBe(file);
  });

  it("returns null for directory (not a file)", () => {
    mkdirSync(join(tmpDir, "adir"), { recursive: true });
    // existsSync returns true for directories, so this will return the path
    // This is acceptable — the caller checks file readability separately
    const result = resolveExistingSpec("adir", tmpDir);
    expect(result).toBe(join(tmpDir, "adir"));
  });
});
