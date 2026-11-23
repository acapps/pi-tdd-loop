// Validate compressed Writer candidates against the LOCAL model (Dirk) using the
// shared behavioral rubric (behavior-rubric.ts).
//
// This is the CROSS-MODEL behavioral gate BEFORE the frontier. Dirk is Qwen3.8-
// 27B — a DIFFERENT model family from the production Tiel-Coder-35B. A candidate
// that makes Dirk behave correctly is unlikely to be an overfit to Tiel-Coder's
// quirks. So: structural gate (compress.ts) -> Dirk behavioral gate (this) ->
// your frontier round (writer-v3.md, strong-judge cross-model). Each layer
// catches regressions the previous one cannot.
//
// Run (Dirk is the default model):
//   PI_PROMPT_BENCH_URL=http://192.168.71.250:8000/v1 \
//   PI_PROMPT_BENCH_MODEL=Dirk-Qwen3.8-27B-MLX-oQ4e \
//   PI_PROMPT_BENCH_KEY=asdf-asdf-asdf-asdf \
//   npx tsx prompt-forge/validate.ts
//
// Filter to specific candidates (introduce one at a time):
//   VALIDATE_IDS=B5,C2,A1,N1 npx tsx prompt-forge/validate.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const { CASES, CASE_BY_ID, callLLM } = await import("./behavior-rubric");
const { realPromptFor } = await import("./real-render");
const { CATALOG } = await import("./catalog");

const HERE = dirname(new URL(import.meta.url).pathname);
const CAND = JSON.parse(readFileSync(join(HERE, "results", "candidates.json"), "utf8")) as Array<{
  entryId: string;
  label: string;
  id: string;
  text: string;
}>;
const ROWS = JSON.parse(readFileSync(join(HERE, "results", "compression.json"), "utf8")) as Array<{
  entryId: string;
  kind: string;
  score: number;
  passed: number;
  total: number;
}>;

const BENCH_URL = process.env.PI_PROMPT_BENCH_URL ?? "";
const BENCH_MODEL = process.env.PI_PROMPT_BENCH_MODEL ?? "Dirk-Qwen3.8-27B-MLX-oQ4e";
const BENCH_KEY = process.env.PI_PROMPT_BENCH_KEY ?? "";
if (!BENCH_URL || !BENCH_KEY) {
  console.log("Skip: set PI_PROMPT_BENCH_URL and PI_PROMPT_BENCH_KEY.");
  process.exit(0);
}

const structScore = new Map(
  ROWS.filter((r) => r.kind !== "BASELINE(real)").map((r) => [r.kind, r]),
);
const ship = new Set(
  ROWS.filter((r) => r.kind !== "BASELINE(real)" && r.score === 100).map((r) => r.kind),
);
const filter = process.env.VALIDATE_IDS
  ? process.env.VALIDATE_IDS.split(",").map((s) => s.trim())
  : null;
const toRun = CAND.filter((c) => (filter ? filter.includes(c.id) : ship.has(c.id)));

// Fill the generation placeholders with representative scenario values, so the
// model is scored against a COMPLETE prompt (not literal {{ws}} etc.).
function subst(t: string): string {
  return t
    .replace(/\{\{ws\}\}/g, "/workspace")
    .replace(/\{\{spec\}\}/g, "/workspace/spec.md")
    .replace(/\{\{tests\}\}/g, "src/*.test.ts")
    .replace(/\{\{res\}\}/g, "The Tester and Writer agree: add a test `it(\"max is zero\", () => { expect(truncate(\"hello\", 0)).toBe(\"\"); })` and implement the source so truncate(\"hello\", 0) returns \"\".")
    .replace(/\{\{fail\}\}/g, 'FAIL src/truncate.test.ts > truncate > max is zero\n  Expected: \"\" but got: \"h\"');
}

// Run only the rubric cases mapped to this entry (a candidate is that entry's
// full prompt; other entries' cases are meaningless against it).
async function runEntryCases(promptText: string, entryId: string) {
  const entryCases = CASES.filter((c) => CASE_BY_ID[c.id] === entryId);
  const out = [];
  for (const c of entryCases) {
    const answer = await callLLM(
      BENCH_URL,
      BENCH_MODEL,
      BENCH_KEY,
      `${subst(promptText)}\n\nQuestion: ${c.question}`,
    );
    out.push({ id: c.id, passed: c.check(answer), detail: c.detail(answer) });
  }
  return out;
}

console.log(`\n${"=".repeat(78)}`);
console.log(`BEHAVIORAL VALIDATION — model: ${BENCH_MODEL} (cross-model vs production Tiel-Coder)`);
console.log(`${"=".repeat(78)}\n`);
console.log(
  filter
    ? `Filter VALIDATE_IDS=${filter.join(",")} — running ${toRun.length} candidate(s), no baseline.`
    : `All structurally-passing candidates (ship=100) + real baseline per entry.`,
);
console.log(`\n`);

const grand: Array<{ entry: string; variant: string; struct: number; beh: number; total: number; baseline: number }> = [];

// Group by entry, keeping catalog order.
const order = CATALOG.filter((e) => toRun.some((c) => c.entryId === e.id) || !filter);
for (const entry of order) {
  const entryId = entry.id;
  const cands = toRun.filter((c) => c.entryId === entryId);
  if (cands.length === 0 && !filter) continue;

  // Baseline for this entry (only in the full run).
  let basePass = 0;
  if (!filter) {
    const base = await runEntryCases(realPromptFor(entryId)!.prompt, entryId);
    basePass = base.filter((r) => r.passed).length;
    console.log(`## ${entryId}  (real baseline: ${basePass}/${CASES.filter((c) => CASE_BY_ID[c.id] === entryId).length} on ${BENCH_MODEL})`);
  } else {
    console.log(`## ${entryId}`);
  }

  for (const c of cands) {
    const s = structScore.get(c.id);
    const res = await runEntryCases(c.text, entryId);
    const pass = res.filter((r) => r.passed).length;
    console.log(`  ${c.id.padEnd(14)} struct ${s?.score ?? "?"}/100  behavioral ${pass}/${res.length} on ${BENCH_MODEL}`);
    for (const r of res) {
      console.log(`      ${r.passed ? "✓" : "✗"} ${r.id} — ${r.detail}`);
    }
    grand.push({
      entry: entryId,
      variant: c.id,
      struct: s?.score ?? 0,
      beh: pass,
      total: res.length,
      baseline: filter ? 0 : basePass,
    });
  }
  console.log("");
}

console.log(`${"=".repeat(78)}`);
console.log(`SUMMARY`);
for (const g of grand) {
  const ok = g.struct === 100 && g.beh === g.total;
  const note = g.baseline ? `  (baseline ${g.baseline}/${g.total})` : "";
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${g.variant.padEnd(14)} [${g.entry}]  struct ${g.struct}/100  beh ${g.beh}/${g.total}${note}`);
}
console.log(`${"=".repeat(78)}`);

const allPass = grand.length > 0 && grand.every((g) => g.struct === 100 && g.beh === g.total);
if (allPass) {
  console.log(
    `\nAll validated candidates hold shape AND behave on ${BENCH_MODEL}. ` +
      `Ready for the frontier round (writer-v3.md).`,
  );
} else {
  console.log(
    `\nSome candidates failed the ${BENCH_MODEL} behavioral gate. ` +
      `Do NOT send failures to the frontier — revert those compressions.`,
  );
}
