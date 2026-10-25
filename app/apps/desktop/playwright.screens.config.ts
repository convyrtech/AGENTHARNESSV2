import { defineConfig } from "@playwright/test";

/** PRSLOY UI screenshots (light + dark, 1280×800) into app/docs/prsloy/screens. */
export default defineConfig({
  testDir: "./e2e-screens",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
