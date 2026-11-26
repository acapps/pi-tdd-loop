// U1 contract tests: the two-tier contract fields on each language config.
//
// Spec: internal/wire-holdback-test-contract.md. Each language pins its
// holdbackSubdir (inside the runner's test root) and threads it into the
// Tester/Writer/settle prompts. STUB prompt bodies — these fail until the
// Writer implements the prompts.

import { describe, it, expect } from "vitest";
import { getLanguageConfig } from "../../src/languages";

describe("holdbackSubdir (pinned per language)", () => {
  it("go pins test/holdback", () => {
    expect(getLanguageConfig("go").holdbackSubdir).toBe("test/holdback");
  });
  it("typescript pins test/holdback", () => {
    expect(getLanguageConfig("typescript").holdbackSubdir).toBe("test/holdback");
  });
  it("java pins src/test/java/holdback (inside the mvn test root)", () => {
    expect(getLanguageConfig("java").holdbackSubdir).toBe("src/test/java/holdback");
  });
});

describe("promptTesterHoldback", () => {
  it("names the subdir and tells the Tester to write the withheld tier there", () => {
    for (const key of ["go", "typescript", "java"] as const) {
      const cfg = getLanguageConfig(key);
      const s = cfg.prompts.promptTesterHoldback(cfg.holdbackSubdir);
      expect(s).toContain(cfg.holdbackSubdir);
      // The Tester owns the withheld tier and completes it in Phase A.
      expect(s.toLowerCase()).toContain("holdback");
    }
  });
});

describe("promptWriterHoldbackNotice", () => {
  it("names the subdir and tells the Writer never to read or modify it", () => {
    for (const key of ["go", "typescript", "java"] as const) {
      const cfg = getLanguageConfig(key);
      const s = cfg.prompts.promptWriterHoldbackNotice(cfg.holdbackSubdir);
      expect(s).toContain(cfg.holdbackSubdir);
      // Read + write isolation for the Writer.
      expect(s.toLowerCase()).toContain("do not");
      expect(s.toLowerCase()).toContain("modify");
    }
  });
});

describe("promptConsolidationStatus", () => {
  it("renders what folded at settle", () => {
    for (const key of ["go", "typescript", "java"] as const) {
      const s = getLanguageConfig(key).prompts.promptConsolidationStatus(1, 1, false);
      expect(s).toContain("1");
      expect(s.toLowerCase()).toContain("fold");
    }
  });
});
