import { defineConfig } from "@playwright/test";

/** Casual-owner audit: every screen, light/dark, scale 100/125/150 % (see e2e-audit/). */
export default defineConfig({
  testDir: "./e2e-audit",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
