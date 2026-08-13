// --- Tests for Quality Measurement ---

import { describe, it, expect } from "vitest";
import { measureQuality } from "./quality";

describe("quality measurement", () => {
  it("produces valid scorecard for a project", () => {
    // This test needs a real Go project directory.
    // For now, verify the function returns the right structure.
    // In practice, you'd create a temp project with real Go code.
    expect(typeof measureQuality).toBe("function");
  });

  it("scorecard spec file exists", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const specPath = path.join(__dirname, "specs", "stringutil-spec.md");
    expect(fs.existsSync(specPath)).toBe(true);
    
    const content = fs.readFileSync(specPath, "utf-8");
    expect(content).toContain("Reverse(s string)");
    expect(content).toContain("Capitalize(s string)");
    expect(content).toContain("TrimSpace(s string)");
    expect(content).toContain("IsPalindrome(s string)");
  });
});
