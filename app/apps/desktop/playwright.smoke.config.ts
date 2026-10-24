import { defineConfig } from "@playwright/test";
import { join, resolve } from "node:path";

const outDir = resolve(process.env.SMOKE_OUT ?? "smoke-out");

/** Installed-app smoke (PRSLOY_EXE). See e2e-smoke/smoke.spec.ts. */
export default defineConfig({
  testDir: "./e2e-smoke",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: join(outDir, "report.json") }]],
  outputDir: join(outDir, "test-results"),
  use: { trace: "off", screenshot: "off" },
});
