import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
        join(__dirname, "test", "__mocks__", "@earendil-works", "pi-coding-agent.ts"),
    },
  },
});
