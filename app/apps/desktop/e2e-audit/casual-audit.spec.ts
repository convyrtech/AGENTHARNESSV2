/**
 * Casual-owner audit: the whole path from first launch to a first result, every screen in
 * light and dark at Windows scale 100 %, 125 % and 150 % on a 1366×768 laptop screen.
 *
 *   pnpm --filter @zeno/desktop run build
 *   AUDIT_OUT=/some/dir xvfb-run -a pnpm --filter @zeno/desktop exec \
 *     playwright test -c playwright.audit.config.ts
 *
 * The real first run (no test bypass) against a local mock of the PRSLOY gateway. What the
 * mock does depends on the prompt: «сайт» writes a page (preview, undo), «денег» answers 402,
 * «ключ» 401, «модель» 404 model_not_found, «обрыв» cuts the stream after the first token,
 * «разметк» answers with a tool call leaked as text (the harness's «Модель сбилась» card).
 * Besides the shots, every screen is checked for Latin technical words and Chinese text.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.AUDIT_OUT ?? join(appDirectory, "test-results", "audit");
const GOOD_KEY = "sk-good-0000abcd";

/** Words a casual owner should never read (the guard test holds the locale to the same list). */
const TECH =
  /\b(token|provider|session|API|JSON|stderr|stdout|extension|Pi|Zeno|SDK|MCP|CLI|TUI)\b/u;

type Message = { role: string; content?: unknown };

function mockGateway(): Server {
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
      const { messages = [], model = "m" } = JSON.parse(body || "{}") as {
        messages?: Message[];
        model?: string;
      };
      const lastUser = messages.findLastIndex((m) => m.role === "user");
      const afterTool = messages.slice(lastUser + 1).some((m) => m.role === "tool");
      const prompt = JSON.stringify(messages[lastUser]?.content ?? "");
      const fail = (status: number, error: object) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error }));
      };
      if (!authorized || prompt.includes("ключ")) {
        fail(401, { message: "Invalid API key", type: "authentication_error" });
        return;
      }
      if (prompt.includes("денег")) {
        fail(402, { message: "Insufficient balance", type: "insufficient_quota" });
        return;
      }
      if (prompt.includes("модель")) {
        fail(404, { message: `The model \`${model}\` does not exist`, code: "model_not_found" });
        return;
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
      // The harness's retry note reaches the model as a user message: keep leaking all turn long.
      if (body.includes("сбой разметки")) {
        // DeepSeek sometimes sends its tool call as text; the harness retries, then shows a card.
        send({ content: '<｜DSML｜invoke name="write">\n<｜DSML｜parameter name="path">a.html' });
        send({}, "stop", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (prompt.includes("обрыв")) {
        send({ content: "Начинаю" });
        res.destroy();
        return;
      }
      if (prompt.includes("сайт") && !afterTool) {
        const content =
          "<!doctype html>\n<meta charset=utf-8>\n<title>Анна</title>\n<h1>Анна Смирнова — флорист</h1>\n";
        send({
          tool_calls: [
            {
              index: 0,
              id: "call-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "site/index.html", content }),
              },
            },
          ],
        });
        send({}, "tool_calls", { prompt_tokens: 2400, completion_tokens: 90, total_tokens: 2490 });
      } else {
        for (const part of "Готово: сделал страницу-визитку. Посмотрите превью.".split(" ")) {
          send({ content: `${part} ` });
        }
        send({}, "stop", { prompt_tokens: 2600, completion_tokens: 40, total_tokens: 2640 });
      }
      res.end("data: [DONE]\n\n");
    });
  });
}

/** Visible text of the window that reads as English tech or Chinese, for the audit log. */
async function leaks(page: Page): Promise<string[]> {
  const texts = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const text = node.textContent?.trim();
      if (!el || !text) continue;
      if (el.closest("[hidden], .hidden, .sr-only, pre, code, [data-testid=timeline] .markdown"))
        continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      out.push(text);
    }
    for (const el of document.querySelectorAll<HTMLElement>(
      "[placeholder], [title], [aria-label]",
    )) {
      for (const attr of ["placeholder", "title"]) {
        const value = el.getAttribute(attr);
        if (value && el.getBoundingClientRect().width > 0) out.push(value);
      }
    }
    return out;
  });
  return [...new Set(texts.filter((text) => TECH.test(text) || /\p{Script=Han}/u.test(text)))];
}

/** Elements whose text is cut off (ellipsis or overflow) — candidates, reviewed by eye. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, label, span, p, h1, h2, h3, a, div")]
      .filter((el) => el.children.length === 0 && el.textContent?.trim())
      .filter((el) => {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2;
      })
      .filter((el) => getComputedStyle(el).overflow !== "visible")
      .map((el) => el.textContent!.trim().slice(0, 60)),
  );
}

const findings: string[] = [];

for (const scale of [1, 1.25, 1.5]) {
  for (const mode of ["light", "dark"] as const) {
    test(`casual path at ${scale * 100}% (${mode})`, async () => {
      const tag = `${Math.round(scale * 100)}-${mode}`;
      await mkdir(outDir, { recursive: true });
      const shot = async (page: Page, name: string) => {
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(350);
        await page.screenshot({ path: join(outDir, `${tag}-${name}.png`) });
        for (const text of await leaks(page)) findings.push(`${tag} ${name}: words «${text}»`);
        for (const text of await clipped(page)) findings.push(`${tag} ${name}: clipped «${text}»`);
      };

      const root = await mkdtemp(join(tmpdir(), `prsloy-audit-${tag}-`));
      const home = join(root, "home");
      const userData = join(root, "userData");
      const projects = await mkdtemp(join(homedir(), `.prsloy-audit-${tag}-`));
      const project = join(projects, "vizitka");
      await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(join(userData, "prsloy"), { recursive: true }),
        mkdir(project, { recursive: true }),
      ]);
      const server = mockGateway();
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
        // A build without the private design pipeline: the «Дизайн» tab's calm state.
        DESIGN_BUNDLE_DIR: join(root, "no-design-bundle"),
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
          "--password-store=basic",
          `--force-device-scale-factor=${scale}`,
        ],
        cwd: appDirectory,
        env,
        timeout: 60_000,
      });
      try {
        const page = await app.firstWindow({ timeout: 60_000 });
        // A 1366×768 screen: the window gets that many physical pixels (clamped to the min size).
        await app.evaluate(
          ({ BrowserWindow }, size) => {
            const win = BrowserWindow.getAllWindows()[0];
            win?.setContentSize(size.w, size.h);
            win?.center();
          },
          { w: Math.round(1366 / scale), h: Math.round(768 / scale) },
        );
        await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
        await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), mode);
        await page.reload();
        await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
        await shot(page, "01-first-run-key");
        const input = page.getByPlaceholder("sk-…");
        await input.fill("sk-wrong");
        await page.getByRole("button", { name: "Продолжить" }).click();
        await expect(page.getByRole("alert")).toBeVisible();
        await shot(page, "02-first-run-wrong-key");
        await input.fill(GOOD_KEY);
        await page.getByRole("button", { name: "Продолжить" }).click();
        // #23: «Разрешить агенту искать в интернете?» — «Не сейчас» (import has nothing to bring here)
        await expect(page.getByTestId("prsloy-first-run-search")).toBeVisible({ timeout: 60_000 });
        await page.getByTestId("first-run-search-skip").click();
        await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
        await shot(page, "03-first-run-folder");
        await app.evaluate(({ dialog }, folder) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [folder],
          })) as unknown as typeof dialog.showOpenDialog;
        }, project);
        await page.getByTestId("prsloy-folder-pick").click();
        await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
          timeout: 120_000,
        });
        await page.waitForTimeout(1500);
        await shot(page, "04-empty-chat");

        const send = async (text: string) => {
          await page.getByTestId("prompt-input").fill(text);
          await page.getByTestId("send-prompt").click();
        };
        await send("Сделай сайт-визитку для флориста");
        await expect(page.getByTestId("turn-preview-btn")).toBeVisible({ timeout: 90_000 });
        await shot(page, "05-turn-done");
        await page.getByTestId("turn-preview-btn").click();
        await expect(page.getByTestId("code-preview-frame")).toBeVisible();
        await shot(page, "06-preview");
        await page.getByTestId("code-preview-close").click();
        await page.getByTestId("turn-undo-btn").click();
        await shot(page, "07-undo-confirm");
        await page
          .getByTestId("turn-undo-confirm")
          .getByRole("button", { name: "Откатить" })
          .click();
        await expect(page.getByTestId("turn-undo-result")).toBeVisible();
        await shot(page, "08-undo-done");

        for (const [name, text] of [
          ["09-error-balance", "Проверим, хватит ли денег"],
          ["10-error-key", "Проверим ключ"],
          ["11-error-break", "Проверим обрыв связи"],
          ["12-error-model", "Проверим, что модель есть"],
        ] as const) {
          const failures = await page.getByTestId("model-failure").count();
          await send(text);
          await expect
            .poll(() => page.getByTestId("model-failure").count(), { timeout: 120_000 })
            .toBeGreaterThan(failures);
          // pi retries some failures; wait until the turn has settled.
          await expect(page.getByTestId("turn-progress")).toBeHidden({ timeout: 120_000 });
          await page.waitForTimeout(1500);
          await shot(page, name);
        }

        await send("Проверим сбой разметки");
        await expect(page.getByTestId("harness-card"))
          .toBeVisible({ timeout: 120_000 })
          .catch(async (error: unknown) => {
            await shot(page, "debug-harness-leak");
            throw error;
          });
        await expect(page.getByTestId("turn-progress")).toBeHidden({ timeout: 120_000 });
        await shot(page, "12b-harness-leak");

        await page.getByTestId("nav-design").click();
        await shot(page, "13-design");

        await page.keyboard.press("Control+,");
        await expect(page.getByTestId("settings-general")).toBeVisible();
        const sections = await page
          .locator('[data-testid^="settings-nav-"]')
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid") ?? ""));
        for (const id of sections) {
          await page.getByTestId(id).click();
          await shot(page, `14-${id.replace("settings-nav-", "settings-")}`);
        }
      } finally {
        await app.close().catch(() => undefined);
        server.close();
        await rm(projects, { recursive: true, force: true });
        await writeFile(join(outDir, "findings.txt"), `${findings.join("\n")}\n`);
      }
    });
  }
}
