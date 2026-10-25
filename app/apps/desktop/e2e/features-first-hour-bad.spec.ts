import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:net";
import { ask, firstRun, launchNovice, LIGHT, shot } from "./first-hour-helpers.ts";

/**
 * The unhappy first hour: the same live-like first run and scripted gateway as features-first-hour.spec.ts,
 * and one thing going wrong per pass — the balance runs out, the internet drops, the model is slow, the
 * preview port is taken, a script crashes, npm cannot reach its registry. What a novice must see: one clear
 * card in plain Russian with one action, no raw stack trace in the chat, and no agent loop.
 */
/** No raw machinery in the chat a person reads: stack traces, npm's error lines. */
async function noRawErrors(page: Page) {
  const text = (await page.getByTestId("timeline").innerText()).replace(/\s+/gu, " ");
  expect(text).not.toMatch(
    /Traceback \(most recent call last\)|npm ERR!|npm error|EADDRINUSE|Errno/u,
  );
}

/** The one failure card with its one action. */
async function failureCard(page: Page, title: RegExp, action: string) {
  const card = page.locator(".model-failure").filter({ hasText: title }).last();
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card.getByRole("button", { name: action })).toBeVisible();
}

test("6 · the balance runs out mid-turn (402) → «Пополнить»", async () => {
  test.setTimeout(240_000);
  const n = await launchNovice([
    {
      when: "сайт-визитку",
      steps: [
        { tools: [{ name: "write", args: { path: "index.html", content: LIGHT } }] },
        {
          fail: {
            status: 402,
            error: { message: "Insufficient balance", type: "insufficient_quota" },
          },
        },
      ],
    },
  ]);
  try {
    await firstRun(n);
    await n.page.getByTestId("prompt-input").fill("Сделай сайт-визитку для фотографа");
    await n.page.getByTestId("send-prompt").click();
    await expect(n.page.getByTestId("timeline")).toContainText(/баланс|Пополнить/u, {
      timeout: 90_000,
    });
    await n.page.waitForTimeout(1500);
    await shot(n.page, "first-hour-bad-1-balance");
  } finally {
    await n.close();
  }
});

test("7 · no internet mid-turn → «Повторить»", async () => {
  test.setTimeout(240_000);
  const n = await launchNovice([
    {
      when: "сайт-визитку",
      steps: [
        { tools: [{ name: "write", args: { path: "index.html", content: LIGHT } }] },
        { drop: true },
      ],
    },
  ]);
  try {
    await firstRun(n);
    await n.page.getByTestId("prompt-input").fill("Сделай сайт-визитку для фотографа");
    await n.page.getByTestId("send-prompt").click();
    await failureCard(n.page, /Связь с моделью/u, "Повторить");
    await noRawErrors(n.page);
    await shot(n.page, "first-hour-bad-2-offline");
  } finally {
    await n.close();
  }
});

test("8 · the model is slow (>60 s to the first token)", async () => {
  test.setTimeout(300_000);
  const n = await launchNovice([
    { when: "сайт-визитку", steps: [{ slow: { afterMs: 70_000, text: "Готово, вот страница." } }] },
  ]);
  try {
    await firstRun(n);
    await n.page.getByTestId("prompt-input").fill("Сделай сайт-визитку для фотографа");
    await n.page.getByTestId("send-prompt").click();
    await n.page.waitForTimeout(20_000);
    await shot(n.page, "first-hour-bad-3-slow-20s");
    await n.page.waitForTimeout(45_000);
    // Still waiting, and the person can stop it.
    await expect(n.page.getByRole("button", { name: "Остановить" }).first()).toBeVisible();
    await shot(n.page, "first-hour-bad-4-slow-65s");
    // The app gives up before the first token and says so with «Повторить» (core calls it «Связь с
    // моделью оборвалась» today, not «модель долго не отвечала» — reported).
    await failureCard(n.page, /Связь с моделью|долго|не ответила/u, "Повторить");
    await noRawErrors(n.page);
    await shot(n.page, "first-hour-bad-5-slow-end");
  } finally {
    await n.close();
  }
});

test("9 · the preview port is taken", async () => {
  test.setTimeout(240_000);
  const busy: Server = createServer();
  await new Promise<void>((resolve) => busy.listen(8000, "127.0.0.1", resolve));
  const n = await launchNovice([
    {
      when: "запусти сайт",
      steps: [
        { tools: [{ name: "write", args: { path: "index.html", content: LIGHT } }] },
        {
          tools: [
            {
              name: "bash_background",
              args: { command: "python3 -m http.server 8000 --bind 127.0.0.1", wait_seconds: 2 },
            },
          ],
        },
        { text: "Запустил сайт: http://127.0.0.1:8000" },
      ],
    },
  ]);
  try {
    await firstRun(n);
    await ask(n.page, "Сделай страницу и запусти сайт, чтобы я посмотрел", "Запустил сайт");
    // The server died on the taken port and the model was told so…
    expect(n.bodies.join("\n")).toMatch(/Address already in use|Errno 98/u);
    await noRawErrors(n.page);
    // …but the turn's status still says «Программу запускал — работает» (reported to harness).
    await shot(n.page, "first-hour-bad-6-port");
  } finally {
    await n.close();
    busy.close();
  }
});

const BROKEN = `prices = {"хлеб": 50, "батон": 45}
print("Цена круассана:", prices["круассан"])
`;

test("10 · a Python script crashes with a traceback; the agent tries the same thing again", async () => {
  test.setTimeout(240_000);
  const run = { tools: [{ name: "bash", args: { command: "python3 prices.py" } }] };
  const n = await launchNovice([
    {
      when: "посчитай цены",
      steps: [
        { tools: [{ name: "write", args: { path: "prices.py", content: BROKEN } }] },
        run,
        run,
        run,
        run,
        { text: "Скрипт падает: в списке цен нет круассана." },
      ],
    },
  ]);
  try {
    await firstRun(n);
    await ask(n.page, "Напиши скрипт и посчитай цены", "нет круассана");
    await noRawErrors(n.page);
    // The harness tells the model a repeat will not help; «Что дальше» offers to fix it.
    expect(n.bodies.join("\n")).toContain("Повтор не поможет");
    await expect(n.page.getByTestId("next-steps")).toContainText("Почини ошибку и запусти снова");
    await shot(n.page, "first-hour-bad-7-traceback");
  } finally {
    await n.close();
  }
});

test("11 · npm install cannot reach its registry", async () => {
  test.setTimeout(240_000);
  const n = await launchNovice(
    [
      {
        when: "сервер на node",
        steps: [
          { tools: [{ name: "bash", args: { command: "npm install express" } }] },
          { text: "Не смог скачать пакеты: нет связи с сервером npm." },
        ],
      },
    ],
    {},
    undefined,
    {
      npm_config_registry: "http://127.0.0.1:9/",
      npm_config_fetch_retries: "0",
      npm_config_fetch_timeout: "3000",
    },
  );
  try {
    await firstRun(n);
    await ask(n.page, "Сделай простой сервер на node с express", "нет связи с сервером npm");
    await noRawErrors(n.page);
    await expect(n.page.getByTestId("next-steps")).toContainText("Почини ошибку и запусти снова");
    await shot(n.page, "first-hour-bad-8-npm");
  } finally {
    await n.close();
  }
});
