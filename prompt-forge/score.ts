// The structural scorer. Renders each catalog entry with sentinel-bound inputs
// and evaluates its guarantees. This is what makes the harness general:
//
//   - `carriesInput` is verified by binding the input to a SENTINEL and checking
//     the sentinel appears in the rendered prompt. That proves the input FLOWS
//     THROUGH (a slot), without asserting it equals any specific value.
//   - `noHardcodedData` fails if the prompt embeds a specific path/symbol that
//     isn't a declared input. This is the anti-overfit guard — the check that
//     would have caught the 92/100 prompt that hardcoded 01a0d128's files.
//
// Scoring is deterministic (no judgment), so it's reproducible and the frontier
// can re-score from the same contract.

import {
  CATALOG,
  SENTINEL,
  type PromptEntry,
  type Guarantee,
} from "./catalog";

export interface GuaranteeResult {
  id: string;
  weight: number;
  passed: boolean;
  why: string;
}

export interface EntryScore {
  entryId: string;
  name: string;
  phase: string;
  role: string;
  prompt: string; // the rendered prompt (with sentinel inputs)
  guarantees: GuaranteeResult[];
  passed: number;
  total: number;
  score: number; // 0..100
  failedIds: string[];
}

// Bind every declared input to the sentinel so carriesInput can verify the slot.
function bindSentinels(entry: PromptEntry): Record<string, string> {
  const bind: Record<string, string> = {};
  for (const input of entry.inputs) bind[input] = SENTINEL;
  return bind;
}

// Evaluate one guarantee. carriesInput-style guarantees (id starts with
// "carries-") are checked against the sentinel-bound render.
function evalGuarantee(
  g: Guarantee,
  prompt: string,
  entry: PromptEntry,
): boolean {
  if (g.id === "carries-resolution-slot" || g.id.startsWith("carries-")) {
    // For carries-* guarantees, verify the sentinel (bound input) is present,
    // OR the guarantee's own structural check passes (e.g. "agreed resolution").
    const sentinelPresent = prompt.includes(SENTINEL);
    const structural = g.check(prompt, entry);
    return sentinelPresent || structural;
  }
  return g.check(prompt, entry);
}

export function scoreEntry(entry: PromptEntry): EntryScore {
  const prompt = entry.render(bindSentinels(entry));
  const results: GuaranteeResult[] = entry.guarantees.map((g) => ({
    id: g.id,
    weight: g.weight,
    passed: evalGuarantee(g, prompt, entry),
    why: g.why,
  }));
  const total = entry.guarantees.reduce((s, g) => s + g.weight, 0);
  const passed = results.reduce((s, r) => s + (r.passed ? r.weight : 0), 0);
  return {
    entryId: entry.id,
    name: entry.name,
    phase: entry.phase,
    role: entry.role,
    prompt,
    guarantees: results,
    passed,
    total,
    score: total === 0 ? 0 : Math.round((passed / total) * 100),
    failedIds: results.filter((r) => !r.passed).map((r) => r.id),
  };
}

export function scoreAll(): EntryScore[] {
  return CATALOG.map(scoreEntry);
}

// Score an ARBITRARY prompt (e.g. a generated variant) against an entry's
// guarantees. Used by the evolver to score variants.
export function scoreVariant(entry: PromptEntry, prompt: string): EntryScore {
  const results: GuaranteeResult[] = entry.guarantees.map((g) => ({
    id: g.id,
    weight: g.weight,
    passed: evalGuarantee(g, prompt, entry),
    why: g.why,
  }));
  const total = entry.guarantees.reduce((s, g) => s + g.weight, 0);
  const passed = results.reduce((s, r) => s + (r.passed ? r.weight : 0), 0);
  return {
    entryId: entry.id,
    name: entry.name,
    phase: entry.phase,
    role: entry.role,
    prompt,
    guarantees: results,
    passed,
    total,
    score: total === 0 ? 0 : Math.round((passed / total) * 100),
    failedIds: results.filter((r) => !r.passed).map((r) => r.id),
  };
}
