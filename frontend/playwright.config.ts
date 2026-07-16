import { defineConfig } from "@playwright/test";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  testDir: "./e2e",
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
  },
  webServer: {
    command: "pnpm exec vite --config frontend/vite.config.ts --host 127.0.0.1 --port 5173",
    cwd: projectRoot,
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
