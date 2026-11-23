// e2e / on-demand test config.
//
// e2e tests (real toolchain, LLM benchmarks, black-box RPC) are a commit/push
// gate, NOT a per-step run. The default `vitest run` (vitest.config.ts) excludes
// test/e2e/**. To run e2e on demand — e.g. when asked to commit/push — use the
// test:e2e script, which points here:
//
//   npm run test:e2e                       # uses PI_PROMPT_BENCH_* from env
//   PI_PROMPT_BENCH_KEY=... npm run test:e2e
//
// This config mirrors vitest.config.ts (same pi-coding-agent alias) but only
// collects test/e2e/**.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    // Mock the pi-coding-agent module entirely
  },
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent":
        "/Users/alancapps/.pi/agent/extensions/loop-go-bak/test/__mocks__/@earendil-works/pi-coding-agent.ts",
    },
  },
});
