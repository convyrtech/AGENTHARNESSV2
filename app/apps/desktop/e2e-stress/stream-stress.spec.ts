/**
 * Stress: a Kimi-like turn (long reasoning, thousands of tiny deltas, no pacing) must not
 * trip React's update-depth guard (#185), which the live acceptance run hit from the
 * preload IPC listener.
 *
 *   pnpm --filter @zeno/desktop run build
 *   xvfb-run -a pnpm --filter @zeno/desktop exec playwright test -c playwright.stress.config.ts
 */
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const DELTAS = Number(process.env.STRESS_DELTAS ?? 2000);

test("thousands of streamed deltas do not exceed React's update depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "prsloy-stress-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const workspace = join(root, "ws");
  const userData = join(root, "userData");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += String(chunk)));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish: string | null = null, usage?: object) =>
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stress",
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      for (let i = 0; i < DELTAS; i += 1) send({ reasoning_content: `шаг ${i}. ` });
      for (let i = 0; i < DELTAS; i += 1) send({ content: `слово${i} ` });
      send({}, "stop", { prompt_tokens: 1000, completion_tokens: DELTAS * 2, total_tokens: 5000 });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stress: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "stress",
              name: "Stress",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 64000,
              compat: { supportsUsageInStreaming: true, thinkingFormat: "deepseek" },
            },
          ],
        },
      },
    }),
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: agentDir,
    ZENO_ISOLATED: "1",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    ZENO_WORKSPACE: workspace,
    ZENO_MODEL_PROVIDER: "stress",
    ZENO_MODEL_ID: "stress",
    ZENO_TOOLS: "read",
    ZENO_PERSIST_SESSION: "0",
    ZENO_NO_AUTO_RESUME: "1",
  });
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, `--user-data-dir=${userData}`, "--lang=ru"],
    cwd: appDirectory,
    env,
    timeout: 60_000,
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    page.on("pageerror", (error) => errors.push(`${error.message}\n${error.stack ?? ""}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });
    await page.waitForTimeout(300);
    await page.getByTestId("start-host").click({ force: true });
    await expect(page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("host-status").first()).toContainText(
      /Agent Host ready|Agent Host restarted/,
      { timeout: 45_000 },
    );
    for (let turn = 0; turn < 3; turn += 1) {
      await page.getByTestId("prompt-input").fill(`ход ${turn}`);
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("timeline")).toContainText(`слово${DELTAS - 1}`, {
        timeout: 120_000,
      });
      await expect(page.getByTestId("host-status").first()).toContainText(/settled|ready/i, {
        timeout: 60_000,
      });
    }
    const depth = errors.filter((e) => /Maximum update depth|#185|Minified React error/i.test(e));
    expect(depth, depth.join("\n")).toEqual([]);
  } catch (error) {
    const page = app.windows()[0];
    if (page) await page.screenshot({ path: join(root, "failure.png") }).catch(() => undefined);
    console.log("[stress] errors:", errors.slice(0, 10).join("\n---\n"));
    console.log("[stress] screenshot:", join(root, "failure.png"));
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
});
