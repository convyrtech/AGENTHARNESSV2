import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask, firstRun, launchNovice, LIGHT, shot } from "./first-hour-helpers.ts";

/**
 * A novice's first hour, live-like: the real first run (key → folder), the real PRSLOY provider and
 * harness, and a gateway that answers by script the way real models do (tool calls, then a short reply).
 * One journey per test, each ending in a screenshot (docs/prsloy/screens/features-first-hour-*.png).
 * What a person who never programmed trips over is written down in STATUS-features.md.
 */
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
    // «Запомнил: …» (alpha.1) or «Запомнил «…»» (core's novice texts): the words are what matter.
    const saved = page.getByTestId("memory-card");
    await expect(saved).toContainText("Запомнил");
    await expect(saved).toContainText("Не программист: объяснять просто, без терминов");
    await shot(page, "first-hour-6-remembered");

    await page.getByText("Новый чат").first().click();
    // A new chat stays in the open project (ui, first-hour pass), not a project-less conversation.
    await expect(page.getByTestId("empty-hero")).toContainText("Что делаем?", { timeout: 30_000 });
    await shot(page, "first-hour-7-new-chat");
    // «Настройки» right away: the new chat finishing its switch no longer pulls the view back.
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

test("5 · defaults on (memory, «замечать само», turn status): a liking said in passing: «Заметил и запомнил» in the new chat, «заметил сам» in «Память»", async () => {
  test.setTimeout(300_000);
  const said = "без анимаций — терпеть не могу, когда всё прыгает";
  const n = await launchNovice(
    [
      {
        when: "сайт для пекарни",
        steps: [
          { tools: [{ name: "write", args: { path: "index.html", content: LIGHT } }] },
          { text: "Готово: сделал страницу пекарни, без анимаций." },
        ],
      },
    ],
    {},
    {
      ops: [
        {
          op: "add",
          scope: "user",
          kind: "preference",
          text: "Сайты делать без анимаций",
          quote: said,
        },
      ],
    },
  );
  const page = n.page;
  try {
    await firstRun(n);
    await ask(page, `Сделай сайт для пекарни, только ${said}`, "без анимаций.");
    await shot(page, "first-hour-15-defaults-turn");
    await page.getByText("Новый чат").first().click();
    // Leaving the chat runs the extractor (core's M-3b): the liking is written to the memory and its
    // «Заметил и запомнил» card comes into the new chat.
    const card = page.getByTestId("memory-card");
    await expect(card.first()).toContainText("Сайты делать без анимаций", { timeout: 30_000 });
    await shot(page, "first-hour-16-new-chat");
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-memory").click();
    const user = page.getByTestId("memory-user");
    await expect(user).toContainText("Сайты делать без анимаций", { timeout: 60_000 });
    await expect(user).toContainText("заметил сам");
    await expect(page.getByTestId("memory-hint")).toContainText("сам замечает важное");
    await shot(page, "first-hour-17-noticed-in-settings");
  } finally {
    await n.close();
  }
});
