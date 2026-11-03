import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
