// The runner: scores the ACTUAL prompts the extension uses (by calling the real
// builders) against the structural rubric. This is the "test the real thing"
// step — not my render() stubs, the actual prompt strings from src/.
//
// Run: npx tsx prompt-forge/run.ts
//   Scores every catalog entry against the real prompt, reports which
//   structural guarantees each real prompt passes/fails.
//
// The output is the baseline: which of the extension's real prompts are structurally
// weak (missing a boundary, not carrying an input, etc.). The evolver then
// generates strengthened variants and the frontier judges quality within the
// structurally-valid set.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG, type PromptEntry } from "./catalog";
import { scoreVariant, type EntryScore } from "./score";
import { renderReal } from "./real-render";

const HERE = dirname(new URL(import.meta.url).pathname);
const OUT = join(HERE, "results");
mkdirSync(OUT, { recursive: true });

const scores: EntryScore[] = CATALOG.map((entry) =>
  scoreVariant(entry, renderReal(entry)),
);

// --- Report ---
let report = `# Prompt-Forge Baseline Report\n\n`;
report += `Scored the ACTUAL prompts the extension uses against the structural rubric.\n`;
report += `${CATALOG.length} prompts across phases: ${[...new Set(CATALOG.map((e) => e.phase))].join(", ")}\n\n`;

report += `## Summary\n\n`;
report += `| prompt | phase | role | score | failed guarantees |\n`;
report += `|---|---|---|---|---|\n`;
for (const s of [...scores].sort((a, b) => a.score - b.score)) {
  report += `| ${s.name} | ${s.phase} | ${s.role} | ${s.score}/100 | ${s.failedIds.join(", ") || "—"} |\n`;
}

report += `\n## Per-prompt detail\n\n`;
for (const s of scores) {
  report += `### ${s.name} (${s.phase}/${s.role}) — ${s.score}/100\n\n`;
  report += `**Real prompt:**\n\`\`\`\n${s.prompt}\n\`\`\`\n\n`;
  for (const g of s.guarantees) {
    report += `- ${g.passed ? "✅" : "❌"} **${g.id}** (w${g.weight}): ${g.why}\n`;
  }
  report += `\n`;
}

writeFileSync(join(OUT, "baseline.md"), report);
writeFileSync(
  join(OUT, "baseline.json"),
  JSON.stringify(
    scores.map((s) => ({
      entryId: s.entryId,
      name: s.name,
      phase: s.phase,
      role: s.role,
      score: s.score,
      prompt: s.prompt,
      failed: s.failedIds,
      guarantees: s.guarantees,
    })),
    null,
    2,
  ),
);

// Console summary
console.log(`Scored ${scores.length} real prompts.\n`);
const weak = [...scores].filter((s) => s.score < 100).sort((a, b) => a.score - b.score);
console.log(`Weakest (structural gaps):`);
for (const s of weak) {
  console.log(`  ${s.score}/100  ${s.name}  — missing: ${s.failedIds.join(", ")}`);
}
const strong = scores.filter((s) => s.score === 100);
console.log(`\nFully structurally-valid: ${strong.length}/${scores.length}`);
console.log(`\nWrote: ${join(OUT, "baseline.md")}, ${join(OUT, "baseline.json")}`);
