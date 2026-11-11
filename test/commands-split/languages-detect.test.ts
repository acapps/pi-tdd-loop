// src/languages/index.ts — detectProject + defaultBuildToolFor
//
// Regression: session 01a1c767 — `--language typescript` on a TS project
// showed "typescript / go" because detectProject returned no buildTool for
// the TypeScript row and cmdLoop fell back blindly. detectProject now
// returns a complete { language, buildTool } for every row it recognizes,
// and defaultBuildToolFor is the named fallback when detection is null.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { detectProject, defaultBuildToolFor } from "../../src/languages";

const exists = vi.mocked(fs.existsSync);

describe("detectProject — complete results (buildTool on every row)", () => {
  beforeEach(() => {
    exists.mockReset();
    exists.mockReturnValue(false);
  });

  it("go.mod → { language: go, buildTool: go }", () => {
    exists.mockImplementation((p: any) => String(p).endsWith("go.mod"));
    expect(detectProject("/proj")).toEqual({ language: "go", buildTool: "go" });
  });

  it("pom.xml → { language: java, buildTool: maven }", () => {
    exists.mockImplementation((p: any) => String(p).endsWith("pom.xml"));
    expect(detectProject("/proj")).toEqual({ language: "java", buildTool: "maven" });
  });

  it("build.gradle → { language: java, buildTool: gradle }", () => {
    exists.mockImplementation((p: any) => String(p).endsWith("build.gradle"));
    expect(detectProject("/proj")).toEqual({ language: "java", buildTool: "gradle" });
  });

  it("build.gradle.kts → { language: java, buildTool: gradle }", () => {
    exists.mockImplementation((p: any) => String(p).endsWith("build.gradle.kts"));
    expect(detectProject("/proj")).toEqual({ language: "java", buildTool: "gradle" });
  });

  it("tsconfig.json → { language: typescript, buildTool: maven } (the 01a1c767 row)", () => {
    exists.mockImplementation((p: any) => String(p).endsWith("tsconfig.json"));
    expect(detectProject("/proj")).toEqual({
      language: "typescript",
      buildTool: defaultBuildToolFor("typescript"),
    });
  });

  it("nothing → null", () => {
    expect(detectProject("/proj")).toBeNull();
  });

  it("precedence: go.mod beats pom.xml beats tsconfig.json", () => {
    exists.mockReturnValue(true); // everything exists
    expect(detectProject("/proj")).toEqual({ language: "go", buildTool: "go" });
  });
});

describe("defaultBuildToolFor — the named fallback", () => {
  it("go → go", () => {
    expect(defaultBuildToolFor("go")).toBe("go");
  });
  it("java → maven", () => {
    expect(defaultBuildToolFor("java")).toBe("maven");
  });
  it("typescript → maven (inert for TS — gates dispatch on language)", () => {
    expect(defaultBuildToolFor("typescript")).toBe("maven");
  });
});
