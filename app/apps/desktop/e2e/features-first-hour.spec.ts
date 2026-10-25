import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOOD_KEY, scriptedGateway, type ScriptRule } from "./first-hour-gateway.ts";
import { shot } from "./features-helpers.ts";

/**
 * A novice's first hour, live-like: the real first run (key → folder), the real PRSLOY provider and
 * harness, and a gateway that answers by script the way real models do (tool calls, then a short reply).
 * One journey per test, each ending in a screenshot (docs/prsloy/screens/features-first-hour-*.png).
 * What a person who never programmed trips over is written down in STATUS-features.md.
 */
const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

type Novice = {
  app: ElectronApplication;
  page: Page;
  project: string;
  agentDir: string;
  bodies: string[];
  close: () => Promise<void>;
};

/** A fresh computer: no key, no project. `flags` go to the harness flags file before the start. */
async function launchNovice(rules: ScriptRule[], flags: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-first-hour-"));
  const home = join(root, "home");
  const userData = join(root, "userData");
  // Main points PI_CODING_AGENT_DIR at userData/agent before ready (prsloy/agent-home.ts).
  const agentDir = join(userData, "agent");
  // Projects outside tmp: main never treats a /tmp folder as a project.
  const projects = await mkdtemp(join(homedir(), ".prsloy-first-hour-"));
  const project = join(projects, "Мой сайт");
  await Promise.all([
    mkdir(join(userData, "prsloy"), { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(project, { recursive: true }),
  ]);
  if (Object.keys(flags).length) {
    await writeFile(join(agentDir, "prsloy-harness.json"), JSON.stringify(flags));
  }
  const bodies: string[] = [];
  const server = scriptedGateway(rules, bodies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await writeFile(
    join(userData, "prsloy", "state.json"),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1` }),
  );
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    ZENO_ISOLATED: "1",
    ZENO_NO_AUTO_RESUME: "1",
    LANG: "ru_RU.UTF-8",
  });
  for (const name of ["ELECTRON_RUN_AS_NODE", "ZENO_ENABLE_TEST_COMMANDS", "PI_CODING_AGENT_DIR"]) {
    delete env[name];
  }
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [APP, `--user-data-dir=${userData}`, "--lang=ru", "--password-store=basic"],
    cwd: APP,
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.setViewportSize({ width: 1280, height: 820 });
  const close = async () => {
    await app.close().catch(() => undefined);
    server.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(projects, { recursive: true, force: true }).catch(() => undefined);
  };
  return { app, page, project, agentDir, bodies, close } satisfies Novice;
}

/** First run as a person does it: the key from the site, then «Выбрать папку». */
async function firstRun(n: Novice) {
  const { page, app } = n;
  await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
  await page.getByPlaceholder("sk-…").fill(GOOD_KEY);
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as unknown as typeof dialog.showOpenDialog;
  }, n.project);
  await page.getByTestId("prsloy-folder-pick").click();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
}

/** Sends a request and waits for the model's closing words (the end of the scripted turn). */
async function ask(page: Page, text: string, reply: string) {
  await page.getByTestId("prompt-input").fill(text);
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("timeline")).toContainText(reply, { timeout: 90_000 });
  await page.waitForTimeout(800);
}

const LIGHT = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Анна Смирнова — фотограф</title>
<style>body { background: #ffffff; color: #222; font-family: sans-serif; margin: 3rem; }</style>
</head><body>
<h1>Анна Смирнова</h1>
<p>Фотограф. Свадьбы, портреты, семейные съёмки в Казани.</p>
<p>Телефон: +7 900 000-00-00</p>
</body></html>
`;

test("1 · first run → «Сделай сайт-визитку» → preview → «Сделай фон тёмным» → «Откатить ход» → «Что дальше»", async () => {
  test.setTimeout(300_000);
  const n = await launchNovice([
    {
      when: "сайт-визитку",
      steps: [
        { tools: [{ name: "write", args: { path: "index.html", content: LIGHT } }] },
        {
          text: "Готово: сделал страницу-визитку для Анны — имя, чем занимается и телефон. Откройте превью, чтобы посмотреть.",
        },
      ],
    },
    {
      when: "фон тёмным",
      steps: [
        {
          tools: [
            {
              name: "edit",
              args: {
                path: "index.html",
                edits: [
                  {
                    oldText: "background: #ffffff; color: #222;",
                    newText: "background: #1b1b1f; color: #f2f2f2;",
                  },
                ],
              },
            },
          ],
        },
        { text: "Сделал фон тёмным, а текст светлым, чтобы читался." },
      ],
    },
  ]);
  const page = n.page;
  const site = join(n.project, "index.html");
  try {
    await firstRun(n);
    await shot(page, "first-hour-1-empty");

    await ask(
      page,
      "Сделай сайт-визитку для фотографа Анны Смирновой из Казани",
      "Откройте превью, чтобы посмотреть.",
    );
    expect(readFileSync(site, "utf8")).toContain("#ffffff");
    await page.getByTestId("turn-preview-btn").last().click();
    await expect(page.getByTestId("code-preview-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.frameLocator('[data-testid="code-preview-frame"]').locator("h1")).toHaveText(
      "Анна Смирнова",
      { timeout: 30_000 },
    );
    await shot(page, "first-hour-2-preview");

    await ask(page, "Сделай фон тёмным", "чтобы читался.");
    expect(readFileSync(site, "utf8")).toContain("#1b1b1f");
    // The open preview shows the change by itself, without «Обновить».
    const background = () =>
      page
        .frameLocator('[data-testid="code-preview-frame"]')
        .locator("body")
        .evaluate((body) => getComputedStyle(body).backgroundColor);
    await expect.poll(background, { timeout: 30_000 }).toBe("rgb(27, 27, 31)");
    await shot(page, "first-hour-3-dark");

    await page.getByTestId("turn-undo-btn").last().click();
    await page.getByTestId("turn-undo-confirm").getByRole("button", { name: "Откатить" }).click();
    await expect(page.getByTestId("turn-undo-result").last()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => readFileSync(site, "utf8")).toContain("#ffffff");
    await expect.poll(background, { timeout: 30_000 }).toBe("rgb(255, 255, 255)");
    await shot(page, "first-hour-4-undone");

    const steps = page.getByTestId("next-steps").last();
    await expect(steps).toContainText("Что дальше:");
    await steps.getByTestId("next-step").first().click();
    await expect(page.getByTestId("prompt-input")).not.toHaveValue("");
    await shot(page, "first-hour-5-next");
    expect(existsSync(site)).toBe(true);
  } finally {
    await n.close();
  }
});

test("2 · «Запомни: я не программист» → new chat → «Память» shows it → «Забыть» → «Вернуть»", async () => {
  test.setTimeout(240_000);
  const n = await launchNovice(
    [
      {
        when: "я не программист",
        steps: [
          {
            tools: [
              {
                name: "memory",
                args: {
                  action: "remember",
                  scope: "user",
                  text: "Не программист: объяснять просто, без терминов",
                  quote: "я не программист, объясняй просто, без терминов",
                },
              },
            ],
          },
          { text: "Запомнил. Буду объяснять простыми словами." },
        ],
      },
    ],
    { memory: true },
  );
  const page = n.page;
  try {
    await firstRun(n);
    await ask(
      page,
      "Запомни: я не программист, объясняй просто, без терминов",
      "Буду объяснять простыми словами.",
    );
    await expect(page.getByTestId("memory-card")).toContainText(
      "Запомнил: Не программист: объяснять просто, без терминов",
    );
    await shot(page, "first-hour-6-remembered");

    await page.getByText("Новый чат").first().click();
    await expect(page.getByText("Начните разговор")).toBeVisible({ timeout: 30_000 });
    await shot(page, "first-hour-7-new-chat");
    // «Новый чат» finishes its switch a few seconds later and pulls the view back to the chat: going to
    // Settings right away lands back in the chat (reported to ui). Wait it out like a person would.
    await page.waitForTimeout(6000);
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-memory").click();
    const user = page.getByTestId("memory-user");
    await expect(user).toContainText("Не программист: объяснять просто, без терминов");
    await shot(page, "first-hour-8-memory");
    await page
      .getByTestId("settings-memory")
      .getByRole("button", { name: "Забыть", exact: true })
      .first()
      .click();
    const forgotten = page.getByTestId("memory-forgotten");
    await expect(forgotten).toContainText("Не программист");
    await page.getByTestId("memory-forgotten-restore").first().click();
    await expect(user).toContainText("Не программист: объяснять просто, без терминов");
    await shot(page, "first-hour-9-restored");
  } finally {
    await n.close();
  }
});

const TOKEN = "7712345678:AAE-first-hour-secret-token";
const BOT = `import time

print("Бот запущен, жду сообщений", flush=True)
while True:
    print("бот: отвечаю «Привет»", flush=True)
    time.sleep(0.5)
`;

test("3 · a Telegram bot: the token by a form → the bot runs → «Бот работает · Остановить · Журнал»", async () => {
  test.skip(process.platform === "win32", "python3 stand-in bot");
  test.setTimeout(240_000);
  const n = await launchNovice([
    {
      when: "телеграм",
      steps: [
        {
          tools: [
            {
              name: "request_secret",
              args: {
                name: "TELEGRAM_BOT_TOKEN",
                reason: "Токен бота — его выдаёт @BotFather в Telegram",
              },
            },
          ],
        },
        { tools: [{ name: "write", args: { path: "bot.py", content: BOT } }] },
        {
          tools: [
            { name: "bash_background", args: { command: "python3 bot.py", wait_seconds: 1 } },
          ],
        },
        { text: "Бот запущен и отвечает «Привет». Остановить его можно кнопкой под чатом." },
      ],
    },
  ]);
  const page = n.page;
  try {
    await firstRun(n);
    await page.getByTestId("prompt-input").fill("Сделай телеграм-бота, который отвечает «Привет»");
    await page.getByTestId("send-prompt").click();
    const field = page.getByTestId("extension-ui-input-field");
    await expect(field).toBeVisible({ timeout: 90_000 });
    // A key is typed into a hidden, empty field and the form says where it goes.
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toHaveValue("");
    await expect(page.getByTestId("extension-ui-secret-note")).toContainText(".env");
    await shot(page, "first-hour-10-token");
    await field.fill(TOKEN);
    await page.getByTestId("extension-ui-input-confirm").click();
    await expect(page.getByTestId("timeline")).toContainText("Бот запущен и отвечает", {
      timeout: 90_000,
    });
    const row = page.getByTestId("agent-proc");
    await expect(row).toContainText("Бот Telegram");
    await expect(row.getByTestId("agent-proc-status")).toContainText("работает");
    await row.getByTestId("agent-proc-log-toggle").click();
    await expect(row.getByTestId("agent-proc-log")).toContainText("отвечаю «Привет»");
    await shot(page, "first-hour-11-bot");
    // The token is in the project's .env, never in what went to the model.
    expect(readFileSync(join(n.project, ".env"), "utf8")).toContain(TOKEN);
    expect(n.bodies.join("\n")).not.toContain(TOKEN);
    await row.getByTestId("agent-proc-stop").click();
    await expect(row.getByTestId("agent-proc-status")).toHaveText("остановлен");
    await shot(page, "first-hour-12-stopped");
  } finally {
    await n.close();
  }
});

test("4 · the agent hits a wall: «Не получилось: …» with ready answers (honestExit on)", async () => {
  test.setTimeout(240_000);
  const n = await launchNovice(
    [
      {
        when: "оплату",
        steps: [
          { tools: [{ name: "read", args: { path: "оплата.txt" } }] },
          {
            tools: [
              {
                name: "report_blocker",
                args: {
                  what: "подключить оплату",
                  reason: "missing_file",
                  why: "в папке проекта нет файла оплата.txt с данными магазина",
                  need: "положите файл оплата.txt в папку проекта или напишите данные магазина",
                  evidence: "оплата.txt",
                  options: ["Положил файл, попробуй снова", "Сделай пока без оплаты"],
                },
              },
            ],
          },
          { text: "Не нашёл файл с данными для оплаты — подробности в карточке выше." },
        ],
      },
      {
        when: "без оплаты",
        steps: [{ text: "Хорошо, делаю страницу без оплаты." }],
      },
    ],
    { honestExit: true },
  );
  const page = n.page;
  try {
    await firstRun(n);
    await ask(
      page,
      "Подключи оплату на сайте, данные магазина в файле оплата.txt",
      "подробности в карточке выше.",
    );
    const card = page.getByTestId("blocker-card");
    await expect(card).toContainText("Не получилось: подключить оплату");
    await expect(card.getByTestId("blocker-why")).toContainText("нет файла оплата.txt");
    await shot(page, "first-hour-13-blocker");
    await card.getByRole("button", { name: "Сделай пока без оплаты" }).click();
    await expect(page.getByTestId("timeline")).toContainText("делаю страницу без оплаты", {
      timeout: 90_000,
    });
    await shot(page, "first-hour-14-answered");
  } finally {
    await n.close();
  }
});
