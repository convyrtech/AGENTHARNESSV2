/**
 * First run → undo → account, in light and dark, against a local mock of the PRSLOY gateway.
 *
 *   pnpm --filter @zeno/desktop run build
 *   xvfb-run -a pnpm --filter @zeno/desktop exec playwright test -c playwright.screens.config.ts
 *
 * Fresh isolated profile per theme (ZENO_ISOLATED=1, temp HOME and userData). The gateway
 * address is pre-seeded to the mock (loopback http is allowed); `GET /v1/models` accepts only
 * `sk-good`, so a wrong key shows core's `invalid_key` in Russian. The model writes one file,
 * which gives the turn its «Откатить».
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(appDirectory, "..", "..", "docs", "prsloy", "screens");
const GOOD_KEY = "sk-good-0000abcd";

type Message = { role: string };

function mockGateway(pagePath: string): Server {
  return createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${GOOD_KEY}`;
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          authorized
            ? { data: [{ id: "deepseek-v4.1-flash-1017" }, { id: "kimi-k3.1-pro" }] }
            : { error: { message: "bad key" } },
        ),
      );
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += String(chunk)));
    req.on("end", () => {
      if (!authorized) {
        res.writeHead(401).end();
        return;
      }
      const { messages = [], model = "m" } = JSON.parse(body || "{}") as {
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
        const content = "<!doctype html>\n<title>Зерно</title>\n<h1>Кофейня «Зерно»</h1>\n";
        send({
          tool_calls: [
            {
              index: 0,
              id: "call-write",
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: pagePath, content }) },
            },
          ],
        });
        send({}, "tool_calls", { prompt_tokens: 2400, completion_tokens: 90, total_tokens: 2490 });
      } else {
        for (const part of "Готово: сделал страницу кофейни с заголовком. Открыть превью?".split(
          " ",
        ))
          send({ content: `${part} ` });
        send({}, "stop", { prompt_tokens: 2600, completion_tokens: 40, total_tokens: 2640 });
      }
      res.end("data: [DONE]\n\n");
    });
  });
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
}

for (const mode of ["light", "dark"] as const) {
  test(`first run, undo and account (${mode})`, async () => {
    await mkdir(outDir, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), `prsloy-first-run-${mode}-`));
    const home = join(root, "home");
    const userData = join(root, "userData");
    // Projects live outside tmp: main treats /tmp paths as throwaway, never as a recent project.
    const projects = await mkdtemp(join(homedir(), `.prsloy-screens-${mode}-`));
    const zerno = join(projects, "kofeynya-zerno");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(join(userData, "prsloy"), { recursive: true }),
      mkdir(zerno, { recursive: true }),
    ]);
    const pagePath = join(zerno, "index.html");
    await writeFile(join(zerno, "README.md"), "# Кофейня «Зерно»\n");

    const server = mockGateway(pagePath);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    await writeFile(
      join(userData, "prsloy", "state.json"),
      JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1` }),
    );

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      ZENO_ISOLATED: "1",
      ZENO_NO_AUTO_RESUME: "1",
      LANG: "ru_RU.UTF-8",
    });
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ZENO_ENABLE_TEST_COMMANDS;
    delete env.PI_CODING_AGENT_DIR;

    const app = await electron.launch({
      executablePath: electronBinary,
      args: [
        appDirectory,
        `--user-data-dir=${userData}`,
        "--lang=ru",
        // Linux CI has no keyring; basic store lets safeStorage encrypt like DPAPI would.
        "--password-store=basic",
      ],
      cwd: appDirectory,
      env,
      timeout: 60_000,
    });
    try {
      const page = await app.firstWindow({ timeout: 60_000 });
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.setContentSize(1280, 800);
        win?.center();
      });
      await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
      // Pin the app's own theme preference (main overrides an OS-level switch).
      await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), mode);
      await page.reload();

      // Key: a wrong key first, so the screenshot shows core's code in plain Russian.
      await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
      const input = page.getByPlaceholder("sk-…");
      await input.fill("sk-wrong");
      await page.getByRole("button", { name: "Продолжить" }).click();
      await expect(page.getByRole("alert")).toContainText("Ключ не подошёл");
      await shot(page, `${mode}-first-run-key`);
      // «Другой сервер» reveals the address, prefilled with the current one.
      await page.getByTestId("prsloy-server-link").click();
      await expect(page.getByTestId("prsloy-server-input")).toHaveValue(/127\.0\.0\.1/);
      await shot(page, `${mode}-first-run-server`);

      await input.fill(GOOD_KEY);
      await page.getByRole("button", { name: "Продолжить" }).click();
      await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
      await shot(page, `${mode}-first-run-folder`);

      // The native folder dialog cannot be driven; answer it with the demo project.
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [folder],
        })) as unknown as typeof dialog.showOpenDialog;
      }, zerno);
      await page.getByTestId("prsloy-folder-pick").click();
      await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
        timeout: 120_000,
      });

      await page.getByTestId("prompt-input").fill("Сделай главную страницу кофейни");
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("timeline")).toContainText("Открыть превью?", {
        timeout: 90_000,
      });
      expect(existsSync(pagePath)).toBe(true);
      const undo = page.getByTestId("turn-undo-btn");
      await expect(undo).toBeEnabled({ timeout: 30_000 });
      await undo.click();
      await expect(page.getByTestId("turn-undo-confirm")).toBeVisible();
      await shot(page, `${mode}-undo`);
      await page.getByTestId("turn-undo-confirm").getByRole("button", { name: "Откатить" }).click();
      await expect(page.getByTestId("turn-undo-result")).toHaveText("Ход откачен: вернул 1 файл");
      expect(existsSync(pagePath)).toBe(false);
      await shot(page, `${mode}-undo-done`);

      await page.keyboard.press("Control+,");
      // Casual mode: no Git page in settings (pull / force push / PR are developer tools).
      await expect(page.getByTestId("settings-nav-git")).toHaveCount(0);
      await page.getByTestId("settings-nav-account").click();
      await expect(page.getByTestId("settings-account-masked")).toContainText("abcd");
      await shot(page, `${mode}-account`);
    } finally {
      await app.close().catch(() => undefined);
      server.close();
      await rm(projects, { recursive: true, force: true });
    }
  });
}
