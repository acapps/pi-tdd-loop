// Tests for src/args.ts — parseTokens

import { describe, it, expect } from "vitest";
import { parseTokens } from "../src/args";

describe("parseTokens", () => {
  it("empty string → no flags, no positional", () => {
    const { flags, positional } = parseTokens("");
    expect(flags.size).toBe(0);
    expect(positional).toEqual([]);
  });

  it("single positional", () => {
    const { flags, positional } = parseTokens("spec.md");
    expect(flags.size).toBe(0);
    expect(positional).toEqual(["spec.md"]);
  });

  it("multiple positional", () => {
    const { flags, positional } = parseTokens("a.md b.md");
    expect(flags.size).toBe(0);
    expect(positional).toEqual(["a.md", "b.md"]);
  });

  it("--flag value", () => {
    const { flags, positional } = parseTokens("--coverage 90 spec.md");
    expect(flags.get("coverage")).toBe("90");
    expect(positional).toEqual(["spec.md"]);
  });

  it("--flag=value", () => {
    const { flags, positional } = parseTokens("--coverage=90 spec.md");
    expect(flags.get("coverage")).toBe("90");
    expect(positional).toEqual(["spec.md"]);
  });

  it("--flag=value with = in value", () => {
    const { flags } = parseTokens("--branch=feat/x=y");
    expect(flags.get("branch")).toBe("feat/x=y");
  });

  it("--flag followed by another flag → bare flag", () => {
    const { flags, positional } = parseTokens("--branch --coverage 90 spec.md");
    expect(flags.get("branch")).toBeUndefined();
    expect(flags.has("branch")).toBe(true);
    expect(flags.get("coverage")).toBe("90");
    expect(positional).toEqual(["spec.md"]);
  });

  it("--flag at end → bare flag", () => {
    const { flags, positional } = parseTokens("spec.md --branch");
    expect(flags.has("branch")).toBe(true);
    expect(flags.get("branch")).toBeUndefined();
    expect(positional).toEqual(["spec.md"]);
  });

  it("multiple flags with values", () => {
    const { flags, positional } = parseTokens("--coverage 90 --language java spec.md");
    expect(flags.get("coverage")).toBe("90");
    expect(flags.get("language")).toBe("java");
    expect(positional).toEqual(["spec.md"]);
  });

  it("mixed flag forms", () => {
    const { flags } = parseTokens("--coverage=85 --language java spec.md");
    expect(flags.get("coverage")).toBe("85");
    expect(flags.get("language")).toBe("java");
  });

  it("unknown --* token consumes next non-flag token as value", () => {
    const { flags, positional } = parseTokens("--unknown spec.md");
    expect(flags.has("unknown")).toBe(true);
    expect(flags.get("unknown")).toBe("spec.md");
    expect(positional).toEqual([]);
  });

  it("unknown --* token at end → bare flag", () => {
    const { flags, positional } = parseTokens("spec.md --unknown");
    expect(flags.has("unknown")).toBe(true);
    expect(flags.get("unknown")).toBeUndefined();
    expect(positional).toEqual(["spec.md"]);
  });

  it("bareFlags: flag never consumes next token", () => {
    const bare = new Set(["no-auto-approve"]);
    const { flags, positional } = parseTokens("--no-auto-approve spec.md", bare);
    expect(flags.has("no-auto-approve")).toBe(true);
    expect(flags.get("no-auto-approve")).toBeUndefined();
    expect(positional).toEqual(["spec.md"]);
  });

  it("bareFlags: flag at end", () => {
    const bare = new Set(["no-auto-approve"]);
    const { flags, positional } = parseTokens("spec.md --no-auto-approve", bare);
    expect(flags.has("no-auto-approve")).toBe(true);
    expect(positional).toEqual(["spec.md"]);
  });

  it("bareFlags: flag followed by another flag", () => {
    const bare = new Set(["no-auto-approve"]);
    const { flags, positional } = parseTokens("--no-auto-approve --coverage 90 spec.md", bare);
    expect(flags.has("no-auto-approve")).toBe(true);
    expect(flags.get("coverage")).toBe("90");
    expect(positional).toEqual(["spec.md"]);
  });

  it("bareFlags: --flag=value form still works", () => {
    const bare = new Set(["no-auto-approve"]);
    const { flags } = parseTokens("--no-auto-approve=true spec.md", bare);
    // --no-auto-approve=true → eq form, name="no-auto-approve", value="true"
    expect(flags.get("no-auto-approve")).toBe("true");
  });

  it("extra whitespace is ignored", () => {
    const { flags, positional } = parseTokens("  --coverage   90   spec.md  ");
    expect(flags.get("coverage")).toBe("90");
    expect(positional).toEqual(["spec.md"]);
  });
});
