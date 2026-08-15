# done: gate parser false-positive (FAIL substring matched test names)

**Status:** Implemented during the internal/01-wire-session-start.md run (Phase B gate
was retrying on 3 phantom failures). Routed through a Writer dispute/concession rather
than a separate loop; recorded here as provenance per internal/README.md.

## Bug

`parseTestOutput` (src/gates.ts, generic branch for TypeScript/Java) matched
`/FAIL\s+[\w/.+-]+/g` over the **entire** test output. The gate invokes vitest with
`--reporter=verbose`, which prints passing test names inline — so any passing test
whose name contains `FAIL ` (three existed in test/gates.test.ts itself, which pins
the parser) was counted as a gate failure on a fully green run (811/811 passed).

Symptom: gate reported 3 phantom failures, each with id `FAIL lines`, and retried the
Writer forever. General bug: any project using the loop with a test named `FAIL …`
false-failed every Phase B/C settle.

## Fix

Line-anchored matching in the generic branch only:

```typescript
for (const line of output.split("\n")) {
  const match = line.match(/^\s*FAIL\s+([\w/.+-]+)/);
  if (match) failures.push({ test: `FAIL ${match[1]}`, subtest: "", output: "" });
}
```

Real failure lines start with `FAIL <id>` (vitest: `␣FAIL␣␣test/x.test.ts > suite >
name`; maven-style: `FAIL com.example.MyTest`). Passing verbose lines embed `FAIL`
mid-line after `✓ … > ` and no longer count. Recorded identifier format (`FAIL <id>`)
is unchanged, so all existing parseTestOutput tests pass unmodified — including the
Java FQCN fixture that has no `.test.*` suffix (why the fix must not require a
test-file extension; line-anchoring is the discriminator).

## Verified

- Green `npx vitest run --reporter=verbose` in this repo → 0 gate failures (was 3)
- All existing parseTestOutput tests pass unchanged (Java FQCN, TS path, no-FAIL, Go branch)
- Real vitest failure line → detected, recorded id = file path (`FAIL test/x.test.ts`)
- `Tests run: 5, Failures: 2`, `WARNING: …`, `✓ … FAIL …` lines → not failures
- Go branch byte-identical; `npx tsc --noEmit` clean; full suite 811/811 green
