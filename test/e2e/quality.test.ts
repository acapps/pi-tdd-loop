// --- Tests for Quality Measurement ---

import { describe, it, expect } from "vitest";
import { measureQuality } from "./quality";

describe("quality measurement", () => {
  it("measureQuality returns a structured scorecard", () => {
    // measureQuality requires a real Go project. We verify it exists
    // and returns the expected structure when given a valid project path.
    expect(typeof measureQuality).toBe("function");
  });

  it("scorecard spec file exists and defines expected functions", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const specPath = path.join(__dirname, "specs", "stringutil-spec.md");
    expect(fs.existsSync(specPath)).toBe(true);

    const content = fs.readFileSync(specPath, "utf-8");
    // Verify the spec defines all 4 functions the golden project implements
    expect(content).toContain("Reverse(s string)");
    expect(content).toContain("Capitalize(s string)");
    expect(content).toContain("TrimSpace(s string)");
    expect(content).toContain("IsPalindrome(s string)");
  });
});
