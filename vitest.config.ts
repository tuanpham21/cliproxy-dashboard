import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "frontend/src/**/*.test.ts"],
    setupFiles: ["src/test/mock-child-process.ts"],
  },
});
