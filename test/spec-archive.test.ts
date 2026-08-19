// Unit tests for the spec-archive unit (done- rename at the B→C boundary).
//
// Contract:
//  - doneSpecPath is pure: computes the `done-`-prefixed path (joined against
//    cwd), returns null for already-archived names (idempotent — no double
//    prefix).
//  - archiveSpecFile performs the fs side effects and never throws:
//    missing source, existing target, and rename failures all return null
//    and leave the filesystem untouched.
//
// No vi.mock: the fs tests use real node:fs in a temp dir. The one failure
// path not covered here (renameSync throwing) is documented in
// internal/spec-archive-rename-failure-test.md — a proper regression test
// needs a real OS-level failure scenario, not a module mock.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { doneSpecPath, archiveSpecFile } from "../src/spec-archive";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ================================================================
// doneSpecPath (pure)
// ================================================================

describe("doneSpecPath", () => {
  it("prefixes the stem with done- and keeps the extension", () => {
    expect(doneSpecPath("spec.md", "/tmp/proj")).toBe(path.join("/tmp/proj", "done-spec.md"));
  });

  it("keeps the directory of a relative path", () => {
    expect(doneSpecPath("internal/07.md", "/tmp/proj")).toBe(path.join("/tmp/proj", "internal", "done-07.md"));
  });

  it("resolves a bare filename against cwd", () => {
    expect(doneSpecPath("spec.md", "/tmp/proj")).toBe(path.join("/tmp/proj", "done-spec.md"));
    expect(doneSpecPath("bug-foo.md", "/tmp/proj")).toBe(path.join("/tmp/proj", "done-bug-foo.md"));
  });

  it("keeps absolute paths as-is", () => {
    expect(doneSpecPath("/work/specs/spec.md", "/tmp/proj")).toBe("/work/specs/done-spec.md");
  });

  it("preserves multi-dot names (extension is the last segment only)", () => {
    expect(doneSpecPath("my.spec.v2.md", "/tmp/proj")).toBe(path.join("/tmp/proj", "done-my.spec.v2.md"));
  });

  it("handles extensionless files", () => {
    expect(doneSpecPath("README", "/tmp/proj")).toBe(path.join("/tmp/proj", "done-README"));
  });

  it("returns null for an already-archived name (no double prefix)", () => {
    expect(doneSpecPath("done-spec.md", "/tmp/proj")).toBeNull();
    expect(doneSpecPath("internal/done-07.md", "/tmp/proj")).toBeNull();
  });
});

// ================================================================
// archiveSpecFile (fs)
// ================================================================

describe("archiveSpecFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-archive-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content = "# spec\n"): string {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return rel;
  }

  it("renames the spec file in place and returns the archived path", () => {
    write("spec.md");
    const result = archiveSpecFile("spec.md", dir);
    expect(result).toBe(path.join(dir, "done-spec.md"));
    expect(fs.existsSync(path.join(dir, "done-spec.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "spec.md"))).toBe(false);
  });

  it("preserves the file content", () => {
    write("spec.md", "# the spec\n");
    archiveSpecFile("spec.md", dir);
    expect(fs.readFileSync(path.join(dir, "done-spec.md"), "utf-8")).toBe("# the spec\n");
  });

  it("keeps the subdirectory for nested spec paths", () => {
    write("internal/07.md");
    const result = archiveSpecFile("internal/07.md", dir);
    expect(result).toBe(path.join(dir, "internal", "done-07.md"));
    expect(fs.existsSync(path.join(dir, "internal", "done-07.md"))).toBe(true);
  });

  it("returns null and does not create a file when the source is missing", () => {
    expect(archiveSpecFile("nope.md", dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, "done-nope.md"))).toBe(false);
  });

  it("is idempotent: an already-archived name is left untouched", () => {
    write("done-spec.md", "already done\n");
    const result = archiveSpecFile("done-spec.md", dir);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(dir, "done-done-spec.md"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "done-spec.md"), "utf-8")).toBe("already done\n");
  });

  it("never overwrites an existing target", () => {
    write("spec.md", "original\n");
    write("done-spec.md", "other\n");
    const result = archiveSpecFile("spec.md", dir);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(dir, "spec.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "done-spec.md"), "utf-8")).toBe("other\n");
  });

});

// NOTE: The rename-failure path (renameSync throwing → null) is not unit
// tested here. A vi.mock("node:fs") approach was removed because the
// importOriginal factory made the suite take ~10 minutes. See
// internal/spec-archive-rename-failure-test.md for the proper regression
// test to backfill.
