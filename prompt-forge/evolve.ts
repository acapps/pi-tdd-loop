// The evolver: generates strengthened prompt variants for catalog entries that
// are structurally weak, scores them against the same structural rubric, and
// keeps the ones that (a) fix the structural gaps and (b) stay general
// (noHardcodedData passes).
//
// This is the local-model work: generation + deterministic scoring, free,
// long-running. The frontier's job (separate step) is to judge QUALITY within
// the structurally-valid set and refine the rubric.
//
// Anti-overfit is enforced structurally: a variant that fixes a gap by
// hardcoding a specific file/symbol FAILS noHardcodedData and is rejected.
// So the evolver can't "win" by memorizing one session's data.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG, type PromptEntry } from "./catalog";
import { scoreVariant } from "./score";
import { renderReal } from "./real-render";

const HERE = dirname(new URL(import.meta.url).pathname);
const OUT = join(HERE, "results");
mkdirSync(OUT, { recursive: true });

// --- Structural mutation operators ---
// Each takes a prompt + entry and returns a strengthened variant. They add
// the MISSING structural guarantees generically (no specific data).

type Operator = (prompt: string, entry: PromptEntry) => string;

// Round 1 refinement (frontier): boundary ops are ROLE-SCOPED. A reviewer
// (Phase 0) cannot edit tests OR source — its boundary is "do not edit any
// files". A writer/cleaner (Phase B/C) cannot edit tests — its boundary is
// "do not edit test files". The old unscoped ops injected a Tester-ownership
// line into the reviewer prompt, which is noise.
function boundaryFor(entry: PromptEntry): string {
  if (entry.role === "reviewer")
    return "You CANNOT edit any files in this phase. Your only output is the negotiate_propose call.";
  if (entry.role === "tester")
    return "You CANNOT edit non-test files in this phase. That half is owned by the Writer.";
  return "You CANNOT edit test files in this phase. That half is owned by the Tester.";
}

const ops: Record<string, Operator> = {
  addTestBoundary: (p, entry) =>
    p + "\n\n" + boundaryFor(entry),
  routeTestToTester: (p, entry) =>
    entry.role === "reviewer"
      ? p // reviewer has no test half to route
      : p +
        "\n\nIf a part of the agreed work requires editing a test file, do NOT do " +
        "it yourself — it belongs to the Tester. Report it as pending the Tester.",
  addFalseDoneGuard: (p) =>
    p +
    "\n\nDo NOT report the work as complete or done while any part of it is " +
    "pending another actor.",
  leadWithBoundary: (p, entry) =>
    `STOP — read this first: ` +
    boundaryFor(entry).replace(/^You /, "you ").replace(/\.$/, ".") +
    `\n\n` +
    p,
  addPendingReport: (p) =>
    p +
    "\n\nIf any part of the work is blocked on another actor, state exactly which " +
    "part and that it is pending them — do not claim it is done.",
  ensureTermination: (p, entry) => {
    // Round 2 refinement: the termination line must include a COMPLETION
    // CONDITION that is REACHABLE given the entry's permitted actions.
    // No-write entries (negotiate, reviewer) reference the tool call, not
    // test results.
    let line: string;
    if (entry.phase === "negotiate" || entry.role === "reviewer") {
      // No-write: reference the tool call.
      const tool = entry.role === "reviewer" ? "negotiate_propose" : "negotiate_review";
      line = `After the ${tool} call, stop producing tool calls.`;
    } else if (entry.role === "writer") {
      line = "When all tests pass, or the only remaining work is blocked on the Tester, stop producing tool calls.";
    } else if (entry.role === "cleaner") {
      line = "When all tests pass and the refactor is complete, stop producing tool calls.";
    } else {
      line = "When all contract tests are written and compile, stop producing tool calls.";
    }
    const existing = /stop producing tool calls|when done/i.test(p);
    if (existing) return p; // already has a stop line; assume it has a condition
    return p + "\n\n" + line;
  },
  fullFix: (p, entry) => {
    if (entry.role === "reviewer") {
      // Reviewer: no test half, no boundary beyond "no file edits".
      return (
        p +
        "\n\n" +
        boundaryFor(entry) +
        "\n\nThe findings listed are auto-generated heuristics, not confirmed defects. " +
        "Verify each one against the spec before relying on it."
      );
    }
    return (
      p +
      "\n\nYou CANNOT edit test files in this phase — that half is owned by the " +
      "Tester. If the work includes a test-file change, do the source half, then " +
      "report the test half as pending the Tester. Do NOT report the work as " +
      "complete while any part is pending another actor."
    );
  },
};

interface Variant {
  id: string;
  entryId: string;
  operator: string;
  prompt: string;
  score: number;
  failedIds: string[];
}

interface EvolveResult {
  variants: Variant[];
  best: Variant;
  trajectory: Array<{ iter: number; op: string; score: number }>;
}

// Generate + score variants for one entry.
function evolveEntryFull(
  entry: PromptEntry,
  basePrompt: string,
  iterations = 60,
): EvolveResult {
  const variants: Variant[] = [];
  const seen = new Set<string>();
  const seeds: Array<[string, Operator]> = Object.entries(ops);

  for (const [name, op] of seeds) {
    const prompt = op(basePrompt, entry);
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    const s = scoreVariant(entry, prompt);
    variants.push({
      id: `seed-${name}`,
      entryId: entry.id,
      operator: name,
      prompt,
      score: s.score,
      failedIds: s.failedIds,
    });
  }

  let best = [...variants].sort((a, b) => b.score - a.score)[0];
  const trajectory: Array<{ iter: number; op: string; score: number }> = [];
  for (let i = 0; i < iterations; i++) {
    const [opName, op] = seeds[Math.floor(Math.random() * seeds.length)];
    const source = Math.random() < 0.5 ? best.prompt : basePrompt;
    const prompt = op(source, entry);
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    const s = scoreVariant(entry, prompt);
    const v: Variant = {
      id: `mut-${i}-${opName}`,
      entryId: entry.id,
      operator: opName,
      prompt,
      score: s.score,
      failedIds: s.failedIds,
    };
    variants.push(v);
    trajectory.push({ iter: i, op: opName, score: s.score });
    if (s.score > best.score) best = v;
  }

  return { variants, best, trajectory };
}

// --- Run the evolution for the structurally-weak entries ---
// Base prompts are the REAL prompts (renderReal). We evolve only entries that
// are < 100 in the baseline, to keep the output focused on the gaps.

const weak = CATALOG.filter((e) => scoreVariant(e, renderReal(e)).score < 100);

console.log(`Evolving ${weak.length} structurally-weak entries (from their REAL prompts)...\n`);

const allResults: Record<string, EvolveResult & { bestScore: number }> = {};

for (const entry of weak) {
  const base = renderReal(entry);
  const res = evolveEntryFull(entry, base, 60);
  allResults[entry.id] = { ...res, bestScore: res.best.score };
  console.log(`  ${entry.name}: best ${res.best.score}/100 (op: ${res.best.operator})`);
}

// --- Write artifacts ---
writeFileSync(
  join(OUT, "evolution.json"),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(allResults).map(([id, r]) => [
        id,
        {
          bestScore: r.bestScore,
          bestOperator: r.best.operator,
          bestPrompt: r.best.prompt,
          trajectory: r.trajectory,
          variantCount: r.variants.length,
        },
      ]),
    ),
    null,
    2,
  ),
);

let md = `# Prompt-Forge Evolution\n\n`;
md += `Local model generated + deterministically scored variants for the structurally-weak prompts.\n\n`;
md += `## Results\n\n| prompt | best score | best operator | variants |\n|---|---|---|---|\n`;
for (const [id, r] of Object.entries(allResults)) {
  const name = CATALOG.find((e) => e.id === id)?.name ?? id;
  md += `| ${name} | ${r.bestScore}/100 | ${r.best.operator} | ${r.variants.length} |\n`;
}
md += `\n## Best variants (structurally-valid, general prompts)\n\n`;
for (const [id, r] of Object.entries(allResults)) {
  const name = CATALOG.find((e) => e.id === id)?.name ?? id;
  md += `### ${name} — ${r.bestScore}/100 (op: ${r.best.operator})\n\n\`\`\`\n${r.best.prompt}\n\`\`\`\n\n`;
}
writeFileSync(join(OUT, "evolution.md"), md);

console.log(`\nWrote: ${join(OUT, "evolution.json")}, ${join(OUT, "evolution.md")}`);
console.log(`\nNext: prompt-forge/build-frontier.ts → frontier judges QUALITY within the structurally-valid set + refines the rubric.`);
