/**
 * The app the screenshot specs drive: the dev bundle isolated (ZENO_ISOLATED=1, temp HOME and
 * userData) against a local OpenAI-compatible fake that answers in Russian, reads one file,
 * and reports token usage so the ruble cost shows. The two tier models are registered under a
 * demo provider.
 */
import type { Page } from "@playwright/test";
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
export const outDir = join(appDirectory, "..", "..", "docs", "prsloy", "screens");

type Message = { role: string; content?: unknown };

/** The page the fake agent writes for «Сделай сайт-визитку»: what a casual owner asks for. */
const VIZITKA = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Анна Смирнова — флорист</title>
<style>
  body { margin: 0; font-family: Georgia, serif; background: #f6efe6; color: #2f2419; }
  header { padding: 64px 24px 40px; text-align: center; background: #e9dccb; }
  h1 { margin: 0 0 8px; font-size: 40px; font-weight: normal; }
  header p { margin: 0; font-size: 18px; color: #6b5442; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 24px; display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
  section { background: #fffaf3; border: 1px solid #e3d5c3; border-radius: 12px; padding: 20px; }
  h2 { margin: 0 0 6px; font-size: 18px; }
  a.button { display: inline-block; margin-top: 8px; padding: 10px 18px; border-radius: 999px;
    background: #8c3f28; color: #fff; text-decoration: none; font-family: sans-serif; }
</style></head>
<body>
  <header><h1>Анна Смирнова</h1><p>Букеты к празднику и на каждый день · Казань</p></header>
  <main>
    <section><h2>Букеты</h2>Сезонные цветы, сборка за час, от 2 500 ₽.</section>
    <section><h2>Свадьбы</h2>Оформление зала и букет невесты под ваш стиль.</section>
    <section><h2>Связаться</h2>+7 900 000-00-00<br><a class="button" href="#">Написать</a></section>
  </main>
</body></html>
`;

function fakeModel(readmePath: string): Server {
  let breaks = 0;
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
      const userText = JSON.stringify(messages[lastUser]?.content ?? "");
      // «Запусти тесты»: `npm test`, which the demo project makes take 20 s.
      const slow = userText.includes("тесты");
      // «Обрыв»: the first attempt breaks mid-stream like the live DeepSeek run; a retry works.
      if (userText.includes("обрыв") && !afterTool) {
        breaks += 1;
        if (breaks % 2 === 1) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end("data: {not json\n\n");
          return;
        }
      }
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
      // «Визитка»: writes site/index.html, so the turn offers «Открыть превью».
      if (userText.includes("визитк")) {
        if (!afterTool) {
          send({
            tool_calls: [
              {
                index: 0,
                id: "call-write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: "site/index.html", content: VIZITKA }),
                },
              },
            ],
          });
          send({}, "tool_calls", {
            prompt_tokens: 2400,
            completion_tokens: 400,
            total_tokens: 2800,
          });
        } else {
          send({ content: "Готово: сайт-визитка в `site/index.html`. Откройте превью справа." });
          send({}, "stop", { prompt_tokens: 2900, completion_tokens: 30, total_tokens: 2930 });
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      // «Цена»: English reasoning, then a price split into deltas that repeat the tail.
      if (userText.includes("Цена")) {
        send({ reasoning_content: "Let me look at the working directory first." });
        for (const part of ["Итого: 1", "0", "0", "0 ₽, было 800", "0 ₽."]) send({ content: part });
        send({}, "stop", { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (slow) {
        if (!afterTool) {
          send({
            tool_calls: [
              {
                index: 0,
                id: "call-bash",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "npm test" }) },
              },
            ],
          });
          send({}, "tool_calls", {
            prompt_tokens: 2400,
            completion_tokens: 30,
            total_tokens: 2430,
          });
          res.end("data: [DONE]\n\n");
        } else {
          send({ content: "Тесты прошли." });
          send({}, "stop", { prompt_tokens: 2500, completion_tokens: 20, total_tokens: 2520 });
          res.end("data: [DONE]\n\n");
        }
        return;
      }
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

export async function launch(): Promise<{ app: ElectronApplication; page: Page; server: Server }> {
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
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify({ name: "zerno", private: true, scripts: { test: "sleep 20 && echo ok" } }),
  );

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
        // Not `prsloy`: core owns that provider and supplies its key at runtime.
        "prsloy-demo": {
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
    // Core honors PI_CODING_AGENT_DIR (this fake provider) only in test mode, which also
    // skips the first-run screens; first-run.spec.ts covers those.
    ZENO_ENABLE_TEST_COMMANDS: "1",
    ZENO_WORKSPACE: workspace,
    ZENO_MODEL_PROVIDER: "prsloy-demo",
    ZENO_MODEL_ID: "deepseek-v4.1-flash-1017",
    ZENO_TOOLS: "read,bash,write",
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

export async function setTheme(page: Page, mode: "light" | "dark") {
  await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), mode);
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  // Fonts are bundled; wait for them so text is set in Geist (and the wordmark in Piazzolla).
  await page.evaluate(() => document.fonts.ready);
}

export async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
}
