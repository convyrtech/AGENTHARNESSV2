/**
 * Screenshots of the main PRSLOY screens in light and dark at 1280×800.
 *
 *   pnpm --filter @zeno/desktop run build
 *   pnpm --filter @zeno/desktop exec playwright test -c playwright.screens.config.ts
 *
 * Runs the dev bundle isolated (ZENO_ISOLATED=1, temp HOME and userData) against a local
 * OpenAI-compatible fake that answers in Russian, reads one file, and reports token usage
 * so the ruble cost shows. The two tier models are registered under the PRSLOY provider.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(appDirectory, "..", "..", "docs", "prsloy", "screens");

type Message = { role: string; content?: unknown };

function fakeModel(readmePath: string): Server {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += String(chunk)));
    req.on("end", () => {
      if (process.env.SCREENS_DEBUG) console.log("[fake]", req.method, req.url, body.slice(0, 300));
      const { messages = [], model = "fake" } = JSON.parse(body || "{}") as {
        messages?: Message[];
        model?: string;
      };
      const lastUser = messages.findLastIndex((m) => m.role === "user");
      const afterTool = messages.slice(lastUser + 1).some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish: string | null = null, usage?: object) =>
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      if (!afterTool) {
        send({
          tool_calls: [
            {
              index: 0,
              id: "call-read",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: readmePath }) },
            },
          ],
        });
        send({}, "tool_calls", { prompt_tokens: 2400, completion_tokens: 60, total_tokens: 2460 });
      } else {
        const text =
          "Это лендинг кофейни «Зерно»: одна страница с меню, адресом и формой брони.\n\n" +
          "Что можно сделать дальше:\n\n" +
          "1. Добавить фото зала в шапку.\n" +
          "2. Сделать меню карточками с ценами.\n" +
          "3. Подключить карту.\n\n" +
          "С чего начнём?";
        for (const part of text.split(" ")) send({ content: `${part} ` });
        send({}, "stop", { prompt_tokens: 2600, completion_tokens: 180, total_tokens: 2780 });
      }
      res.end("data: [DONE]\n\n");
    });
  });
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; server: Server }> {
  const root = await mkdtemp(join(tmpdir(), "prsloy-screens-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const workspace = join(root, "kofeynya-zerno");
  const userData = join(root, "userData");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  const readme = join(workspace, "README.md");
  await writeFile(readme, "# Кофейня «Зерно»\n\nЛендинг: меню, адрес, бронь столика.\n");
  await writeFile(join(workspace, "index.html"), "<!doctype html><title>Зерно</title>\n");

  const server = fakeModel(readme);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const model = (id: string, name: string) => ({
    id,
    name,
    reasoning: false,
    input: ["text"],
    // Dollar prices per million tokens, set so the demo turn costs a few rubles.
    cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    compat: { supportsUsageInStreaming: true },
  });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        prsloy: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            model("deepseek-v4.1-flash-1017", "DeepSeek V4.1 Flash"),
            model("kimi-k3.1-pro", "Kimi K3.1 Pro"),
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
    ZENO_WORKSPACE: workspace,
    ZENO_MODEL_PROVIDER: "prsloy",
    ZENO_MODEL_ID: "deepseek-v4.1-flash-1017",
    ZENO_TOOLS: "read",
    ZENO_PERSIST_SESSION: "0",
    ZENO_NO_AUTO_RESUME: "1",
    LANG: "ru_RU.UTF-8",
  });
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, `--user-data-dir=${userData}`, "--lang=ru"],
    cwd: appDirectory,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setContentSize(1280, 800);
    win?.center();
  });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  return { app, page, server };
}

async function setTheme(page: Page, mode: "light" | "dark") {
  await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), mode);
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  // Fonts are bundled; wait for them so headings are set in Piazzolla, not the fallback.
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
}

test("PRSLOY main screens, light and dark", async () => {
  await mkdir(outDir, { recursive: true });
  const { app, page, server } = await launch();
  try {
    for (const mode of ["light", "dark"] as const) {
      await setTheme(page, mode);

      await page.waitForTimeout(300);
      await page.getByTestId("start-host").click({ force: true });
      await expect(page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
        timeout: 60_000,
      });
      await expect(page.getByTestId("host-status").first()).toContainText(
        /Agent Host ready|Agent Host restarted/,
        { timeout: 45_000 },
      );
      await shot(page, `${mode}-1-home`);

      await page.getByTestId("prompt-input").fill("Посмотри проект и скажи, что тут");
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("timeline"))
        .toContainText("С чего начнём?", { timeout: 60_000 })
        .catch(async (error: unknown) => {
          await shot(page, `debug-${mode}`);
          throw error;
        });
      await expect(page.getByTestId("cost-turn")).toBeVisible();
      await page
        .getByText(/^Готово за/)
        .first()
        .click();
      await shot(page, `${mode}-2-chat`);

      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      await expect(page.getByTestId("settings-general")).toBeVisible();
      await shot(page, `${mode}-3-settings`);

      await page.getByTestId("settings-nav-appearance").click();
      await shot(page, `${mode}-4-appearance`);
      await page.getByTestId("settings-back").click();
    }
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
});
