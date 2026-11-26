// U1 contract test: spec Inventory tag validation.
//
// Spec: internal/wire-holdback-test-contract.md. Every Inventory row is tagged
// [visible] or [holdback]; an untagged row is rejected/flagged (the fold can't
// decide promote vs. drop otherwise). STUB validation — fails until implemented.

import { describe, it, expect } from "vitest";
import { validateInventoryTags } from "../src/spec-inventory";

const TAGGED = [
  "## Inventory",
  "- `test/a.test.ts` [visible]",
  "- `test/b.test.ts` [holdback]",
  "",
].join("\n");

const UNTAGGED = [
  "## Inventory",
  "- `test/a.test.ts`",
  "- `test/b.test.ts` [holdback]",
  "",
].join("\n");

describe("validateInventoryTags", () => {
  it("accepts a fully-tagged Inventory", () => {
    expect(validateInventoryTags(TAGGED)).toBeNull();
  });

  it("flags an Inventory row that lacks a [visible]/[holdback] tag", () => {
    const err = validateInventoryTags(UNTAGGED);
    expect(err).not.toBeNull();
    expect(err).toContain("a.test.ts");
  });
});
