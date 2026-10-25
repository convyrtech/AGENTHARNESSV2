/**
 * The Agent Host ships as an ESM bundle (vite.agent.config.ts). Bundled CommonJS
 * dependencies that `require` Node builtins (signal-exit → "assert", postcss → "fs") used
 * to crash the host at start: rolldown's `require` shim throws in ESM. This builds the
 * real config plus a probe entry with such a dependency and runs it in plain Node.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite-plus";
import { afterAll, describe, expect, it } from "vite-plus/test";

const desktop = resolve(import.meta.dirname, "..", "..");
const outDir = mkdtempSync(join(tmpdir(), "agent-bundle-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("agent host bundle", () => {
  it("bundled CommonJS deps can require Node builtins", async () => {
    await build({
      configFile: join(desktop, "vite.agent.config.ts"),
      logLevel: "silent",
      build: {
        outDir,
        sourcemap: false,
        lib: {
          entry: {
            "agent-host-app": join(desktop, "src/agent-host/index.ts"),
            "cjs-probe": join(import.meta.dirname, "test-fixtures/cjs-probe/index.ts"),
          },
          formats: ["es"],
          fileName: (_format: string, name: string) => `${name}.mjs`,
        },
      },
    });

    const run = spawnSync(process.execPath, [join(outDir, "cjs-probe.mjs")], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("cjs-require-ok");

    // No chunk of the real host keeps the throwing shim.
    for (const name of readdirSync(outDir).filter((n) => /\.m?js$/.test(n))) {
      expect(readFileSync(join(outDir, name), "utf8"), name).not.toContain(
        "environment that doesn't expose",
      );
    }
  }, 120_000);
});
