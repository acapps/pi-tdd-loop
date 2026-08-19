# Spec archive: rename-failure regression test (backfill)

## Gap

`src/spec-archive.ts` → `archiveSpecFile` has a `try/catch` around
`fs.renameSync(abs, target)` that returns `null` when the OS refuses the
rename. No test exercises this path.

## Why the old test was removed

The previous test (`test/spec-archive.test.ts`, "returns null on a rename
failure instead of throwing") used:

```ts
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
```

The `importOriginal` factory forces vitest to:
1. Fully load the real `node:fs` module (~100+ exports)
2. Spread every export into a new module namespace object
3. Route **every** `node:fs` access in the file's dependency graph through
   vitest's module interceptor (ESM/CJS interop for mocked builtins)

This made the single test file take **~10 minutes** to run, violating the
test-speed rule (default `vitest run` must stay in the seconds-to-~20s
range). The assertion itself — "a `try/catch` catches" — was not worth the
cost.

## What the gap actually is

The `try/catch` guards against OS-level rename failures:
- Permission denied (read-only filesystem, locked file)
- Cross-device rename (rename across mount points → `EXDEV`)
- Disk full / I/O error

Without the guard, a cosmetic rename failure would crash the loop at the
B→C boundary. With the guard, the loop completes and the spec simply isn't
renamed. Low severity, low likelihood, but the guard is 3 lines and correct.

## What a proper regression test would look like

**Option A — real OS failure (preferred, no mock):**

Create a scenario where `renameSync` genuinely throws:

```ts
it("returns null when renameSync fails (cross-device)", () => {
  // Create a file on a different filesystem (e.g. /tmp vs a tmpfs mount)
  // This is platform-specific; may not work on all CI runners.
  // Alternative: use a read-only directory if the platform allows it.
});
```

Platform-dependent. May not be portable across macOS/Linux/Windows CI.

**Option B — refactor for injectability (best long-term):**

Extract the fs call into a parameter:

```ts
// src/spec-archive.ts
export function archiveSpecFile(
  specPath: string,
  cwd: string,
  rename: (from: string, to: string) => void = fs.renameSync,
): string | null {
  // ...
  try {
    rename(abs, target);
  } catch {
    return null;
  }
  // ...
}
```

Test:

```ts
it("returns null when rename throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-archive-"));
  fs.writeFileSync(path.join(dir, "spec.md"), "# spec\n");
  const boom = () => { throw new Error("EXDEV"); };
  expect(archiveSpecFile("spec.md", dir, boom)).toBeNull();
  // spec.md still exists, no done-spec.md created
  expect(fs.existsSync(path.join(dir, "spec.md"))).toBe(true);
  expect(fs.existsSync(path.join(dir, "done-spec.md"))).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

This is fast (no mock, no temp-dir scaffolding beyond one file), hermetic,
and directly tests the guard. The default parameter keeps the public API
unchanged — `effect-applicator.ts` calls `archiveSpecFile(specPath, cwd)`
with two args, no change needed.

**Option C — skip (acceptable):**

The guard is 3 lines. The failure mode is "OS refuses a cosmetic rename."
The consequence without the guard is a crash at the B→C boundary. If we
accept that risk, we can leave the gap and revisit if a real rename
failure is ever observed in the field.

## Recommendation

**Option B** when we next touch `spec-archive.ts`. It's a 2-line source
change (add default parameter), a 10-line test, zero mocking, and it
closes the gap permanently without platform-dependent flakiness.

Until then, the 13 existing tests in `test/spec-archive.test.ts` cover all
the meaningful paths (rename, content, missing source, idempotency,
no-overwrite, nested paths, pure path math) and run in <500ms.
