// Хост приложения собирает пакет в ESM-бандл (apps/desktop/vite.agent.config.ts), где нет `require`.
// CommonJS-зависимость, которая зовёт require("assert"), роняет хост при старте — так и было со
// signal-exit на этапе 2. Здесь пакет собирается так же и запускается в чистом Node.
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { build } from "vite-plus";
import { afterAll, describe, expect, it } from "vite-plus/test";

const pkg = resolve(import.meta.dirname, "..");
const outDir = join(pkg, "test", ".host-bundle");

afterAll(async () => {
  if (process.env.KEEP_BUNDLE) return;
  await rm(outDir, { recursive: true, force: true });
});

describe("harness inside the host's ESM bundle", () => {
  it("loads, installs every practice and checks CSS without crashing", async () => {
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        target: "node24",
        outDir,
        emptyOutDir: true,
        lib: {
          entry: join(pkg, "src", "index.ts"),
          formats: ["es"],
          fileName: () => "harness.mjs",
        },
        // Как в vite.agent.config.ts: внешние только Pi и встроенные модули Node.
        rollupOptions: {
          external: [
            "@earendil-works/pi-coding-agent",
            ...builtinModules,
            ...builtinModules.map((name) => `node:${name}`),
          ],
        },
      },
    });
    await mkdir(join(outDir, "work"), { recursive: true });
    const css = join(outDir, "work", "bad.css");
    await writeFile(css, "a { color: red;\n");
    const script = join(outDir, "run.mjs");
    await writeFile(
      script,
      `import { createPrsloyHarness, checkFile } from "./harness.mjs";
const handlers = [];
createPrsloyHarness({ outputDir: ${JSON.stringify(join(outDir, "out"))} })({
  on: (name) => handlers.push(name),
  registerTool: () => {},
  getActiveTools: () => [],
  getSettings: () => ({}),
});
const result = await checkFile(${JSON.stringify(css)}, "a { color: red;\\n");
console.log(JSON.stringify({ handlers: handlers.length, result }));
`,
    );
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", cwd: pkg });
    expect(run.stderr).not.toContain("Calling `require`");
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
    expect(out.handlers).toBeGreaterThan(10);
    expect(out.result.ok).toBe(false);
    expect(out.result.message).toMatch(/Unclosed block|не закрыта «\{»/);
  }, 60_000);
});
