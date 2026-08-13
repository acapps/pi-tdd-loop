import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
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
