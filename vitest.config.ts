import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "!test/e2e/**/*.test.ts"],
    // e2e/ is a commit/push gate, not a per-step run. See test:e2e script.
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
