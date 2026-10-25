import { defineConfig } from "@playwright/test";

/** Streaming stress against the built app (React update depth under high event rates). */
export default defineConfig({
  testDir: "./e2e-stress",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
