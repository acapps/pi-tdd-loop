// Ingests the frontier model's JSON response (from build-frontier.ts) and
// applies its output:
//   - rubric refinements → written as a stub to apply to catalog.ts
//   - best prompts → written as the proposed ship-ready prompts
//   - verdict → the frontier's assessment (new failure modes, etc.)
//
// Run: npx tsx prompt-forge/ingest-frontier.ts [path-to-response.json]
// (defaults to results/frontier-response.json)

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const OUT = join(HERE, "results");
mkdirSync(OUT, { recursive: true });

const respPath =
  process.argv[2] ?? join(OUT, "frontier-response.json");

let resp: any;
try {
  resp = JSON.parse(readFileSync(respPath, "utf-8"));
} catch (e) {
  console.error(`Could not read/parse ${respPath}: ${(e as Error).message}`);
  process.exit(1);
}

// Validate shape.
const required = ["qualityRanking", "rubricRefinements", "bestPrompts", "verdict"];
const missing = required.filter((k) => !(k in resp));
if (missing.length) {
  console.error(`Frontier response missing keys: ${missing.join(", ")}`);
  console.error(`Got keys: ${Object.keys(resp).join(", ")}`);
  process.exit(1);
}

// --- Rubric refinements → stub to apply to catalog.ts ---
let rubricStub = `// Rubric refinements from the frontier model (round ${new Date().toISOString().slice(0, 10)}).\n`;
rubricStub += `// Apply these to prompt-forge/catalog.ts by editing the matching guarantee's\n`;
rubricStub += `// check() or weight. Then re-run: npx tsx prompt-forge/run.ts\n\n`;
rubricStub += `export const RUBRIC_REFINEMENTS = ${JSON.stringify(resp.rubricRefinements, null, 2)};\n`;
writeFileSync(join(OUT, "rubric-refinements.ts"), rubricStub);

// --- Best prompts → the proposed ship-ready prompts ---
let bestMd = `# Frontier Best Prompts (proposed to ship)\n\n`;
bestMd += `These are the frontier model's chosen prompts for the structurally-weak entries.\n`;
bestMd += `Apply them to the real prompt builders in src/ (see the catalog's \`source\` field\n`;
bestMd += `for where each lives), then re-run the baseline to confirm 100/100 structural.\n\n`;
for (const [entryId, prompt] of Object.entries(resp.bestPrompts as Record<string, string>)) {
  bestMd += `## ${entryId}\n\n\`\`\`\n${prompt}\n\`\`\`\n\n`;
}
writeFileSync(join(OUT, "frontier-best-prompts.md"), bestMd);

// --- Quality ranking → readable table ---
let rankMd = `# Frontier Quality Ranking\n\n`;
rankMd += `Within the structurally-valid set, the frontier ranked by quality (clarity, precision, no redundancy).\n\n`;
for (const [entryId, ranking] of Object.entries(resp.qualityRanking as Record<string, Array<{ variant: string; quality: number; why: string }>>)) {
  rankMd += `## ${entryId}\n\n| variant | quality | why |\n|---|---|---|\n`;
  for (const r of ranking) {
    rankMd += `| ${r.variant} | ${r.quality} | ${r.why} |\n`;
  }
  rankMd += `\n`;
}
writeFileSync(join(OUT, "frontier-quality-ranking.md"), rankMd);

// --- Verdict ---
let verdictMd = `# Frontier Verdict\n\n${resp.verdict}\n`;
writeFileSync(join(OUT, "frontier-verdict.md"), verdictMd);

console.log(`Ingested frontier response.`);
console.log(`  rubric refinements: ${resp.rubricRefinements.length}`);
console.log(`  best prompts: ${Object.keys(resp.bestPrompts).length}`);
console.log(`  quality rankings: ${Object.keys(resp.qualityRanking).length} entries`);
console.log(`\nWrote:`);
console.log(`  ${join(OUT, "rubric-refinements.ts")}`);
console.log(`  ${join(OUT, "frontier-best-prompts.md")}`);
console.log(`  ${join(OUT, "frontier-quality-ranking.md")}`);
console.log(`  ${join(OUT, "frontier-verdict.md")}`);
console.log(`\nNEXT:`);
console.log(`  1. Apply rubric refinements to prompt-forge/catalog.ts.`);
console.log(`  2. Apply the best prompts to the real builders in src/.`);
console.log(`  3. Re-run: npx tsx prompt-forge/run.ts (confirm 100/100 structural).`);
console.log(`  4. If new gaps appear, re-evolve + re-handoff to the frontier.`);
