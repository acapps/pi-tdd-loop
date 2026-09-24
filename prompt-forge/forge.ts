#!/usr/bin/env tsx
// Top-level orchestrator for the prompt-forge local phase.
//
// Run the whole local (free, long-running) pipeline in one command:
//   npx tsx prompt-forge/forge.ts
//
// This does: baseline (score real prompts) → evolve (generate + score
// variants) → build-frontier (prepare the handoff). It STOPS before the
// frontier step — that's the paid step where the user is engaged.
//
// The full loop (see README.md):
//   1. npx tsx prompt-forge/forge.ts          ← local, free, long-running
//   2. send results/frontier-prompt.md to the frontier model (user engages)
//   3. save its JSON → results/frontier-response.json
//   4. npx tsx prompt-forge/ingest-frontier.ts ← apply rubric + best prompts
//   5. apply best prompts to src/, re-run forge.ts to confirm 100/100

import { execSync } from "node:child_process";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);

function step(label: string, cmd: string) {
  console.log(`\n=== ${label} ===`);
  try {
    const out = execSync(cmd, { cwd: HERE, encoding: "utf-8", stdio: "pipe" });
    process.stdout.write(out);
  } catch (e: any) {
    console.error(`FAILED: ${cmd}\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    process.exit(1);
  }
}

step("1. BASELINE (score the real prompts)", "npx tsx run.ts");
step("2. EVOLVE (generate + score variants)", "npx tsx evolve.ts");
step("3. BUILD FRONTIER HANDOFF", "npx tsx build-frontier.ts");

console.log(`\n${"=".repeat(50)}`);
console.log(`LOCAL PHASE COMPLETE.`);
console.log(`\nNext (ENGAGE THE USER — this is the paid frontier step):`);
console.log(`  1. Send ${join(HERE, "results/frontier-prompt.md")} to the frontier model.`);
console.log(`  2. Save its JSON response to ${join(HERE, "results/frontier-response.json")}.`);
console.log(`  3. Run: npx tsx ${join(HERE, "ingest-frontier.ts")}`);
console.log(`  4. Apply the frontier's best prompts to src/, then re-run forge.ts.`);
console.log(`\nStop here until the user has run the frontier step.`);
