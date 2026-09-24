// The frontier handoff: takes the structurally-valid variants (from evolve.ts)
// and the rubric, and builds a self-contained prompt for the FRONTIER model.
//
// Division of labor (the cost-aware design):
//   - Local model (free, long-running): generation + deterministic structural
//     scoring (run.ts baseline, evolve.ts variants).
//   - Frontier model (paid, you engage me): the irreplaceable judgment —
//     (a) rank QUALITY within the structurally-valid set (the local scorer can
//     only say "structurally valid or not," not "which valid prompt is best"),
//     and (b) refine the rubric (flag criteria that are too loose/tight).
//
// This is the "dish to the frontier" step. Run it, then send
// results/frontier-prompt.md to the frontier model, save its JSON response,
// and run ingest-frontier.ts to apply the rubric refinements.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG, type PromptEntry } from "./catalog";
import { scoreVariant } from "./score";
import { renderReal } from "./real-render";

const HERE = dirname(new URL(import.meta.url).pathname);
const OUT = join(HERE, "results");
mkdirSync(OUT, { recursive: true });

// Load the evolution results (structurally-valid variants + best per entry).
const evolutionPath = join(OUT, "evolution.json");
let evolution: Record<string, { bestScore: number; bestOperator: string; bestPrompt: string; variantCount: number }> = {};
try {
  evolution = JSON.parse(readFileSync(evolutionPath, "utf-8"));
} catch {
  console.error("No evolution.json — run `npx tsx prompt-forge/evolve.ts` first.");
  process.exit(1);
}

// Build the rubric contract (the structural guarantees, machine-readable).
const rubric = CATALOG.map((e) => ({
  entryId: e.id,
  name: e.name,
  phase: e.phase,
  role: e.role,
  inputs: e.inputs,
  guarantees: e.guarantees.map((g) => ({ id: g.id, why: g.why, weight: g.weight })),
}));

// The frontier prompt: self-contained, asks for quality-ranking + rubric
// refinement, NOT re-scoring from scratch (the local structural score is
// already done and trusted for the valid/invalid split).
const weakEntries = Object.keys(evolution);
let frontierPrompt = `You are the FRONTIER model judging prompt quality. A local model has already
done the deterministic STRUCTURAL scoring (valid/invalid split) and generated
strengthened variants. Your job is the judgment the local scorer cannot do:

1. QUALITY RANKING: For each prompt below, the local scorer says it is
   structurally valid (it has the right SHAPE: carries its inputs, states the
   role boundary, routes blocked work, has a termination contract, and —
   critically — does NOT hardcode a specific session's files/symbols). Rank
   the structurally-valid variants by QUALITY: clarity, precision, no
   redundancy, natural language, minimal length that still carries the
   guarantees. A 100/100 structural score does NOT mean "best" — rank within
   the valid set.

2. RUBRIC REFINEMENT: Read the structural guarantees (the rubric) below. Flag
   any that are (a) too loose (pass a prompt that should fail) or (b) too tight
   (fail a prompt that should pass), and propose a refined version. Be
   specific: name the guarantee id and the fix.

3. VERDICT: Which prompt per entry is the one to ship? Give the exact text.

Respond in JSON:
{
  "qualityRanking": { "<entryId>": [ { "variant": "<id>", "quality": 0-100, "why": "..." } ] },
  "rubricRefinements": [ { "guaranteeId": "...", "problem": "too loose|too tight", "fix": "..." } ],
  "bestPrompts": { "<entryId>": "<exact prompt text to ship>" },
  "verdict": "<one paragraph: did the structural harness catch the real gaps? any new failure mode?>"
}

--- THE PROMPTS (structurally-weak entries, with their best variants) ---

`;

for (const entryId of weakEntries) {
  const entry = CATALOG.find((e) => e.id === entryId);
  const evo = evolution[entryId];
  if (!entry || !evo) continue;
  // Re-score the best variant to show the frontier its structural breakdown.
  const s = scoreVariant(entry, evo.bestPrompt);
  frontierPrompt += `\n## ${entry.name} (${entry.phase}/${entry.role})\n\n`;
  frontierPrompt += `Local structural score: ${s.score}/100 (op: ${evo.bestOperator}, ${evo.variantCount} variants)\n`;
  frontierPrompt += `Guarantees: ${entry.guarantees.map((g) => `${g.id}(w${g.weight})`).join(", ")}\n\n`;
  frontierPrompt += `Best variant:\n\`\`\`\n${evo.bestPrompt}\n\`\`\`\n\n`;
}

frontierPrompt += `--- THE RUBRIC (structural guarantees) ---\n\n`;
frontierPrompt += JSON.stringify(rubric, null, 2);
frontierPrompt += `\n\nRespond in JSON only.`;

writeFileSync(join(OUT, "frontier-prompt.md"), frontierPrompt);
writeFileSync(
  join(OUT, "rubric.json"),
  JSON.stringify(rubric, null, 2),
);

console.log(`Wrote: ${join(OUT, "frontier-prompt.md")}`);
console.log(`      ${join(OUT, "rubric.json")}`);
console.log(`\n${weakEntries.length} structurally-weak entries for the frontier to judge.`);
console.log(`\nNEXT (engage the user):`);
console.log(`  1. Send results/frontier-prompt.md to the frontier model.`);
console.log(`  2. Save its JSON response to results/frontier-response.json.`);
console.log(`  3. Run: npx tsx prompt-forge/ingest-frontier.ts`);
console.log(`     → applies rubric refinements + the frontier's best prompts.`);
