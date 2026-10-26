// H-1 в настоящей сессии Pi (research/22 §6.6, этап 1): модель правит старый тест под баг → страж гоняет исходный
// тест, красно → T2 → модель возвращает тест → T1 с report_blocker → блокер с цитатой из старого теста → карточка,
// возвратов больше нет. Флаги testGuard и honestExit включены файлом настроек, как в приложении.
import { TESTS_OUTDATED_CARD } from "../src/tests-outdated.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPrsloyHarness } from "../src/index.ts";
import { closeSharedProxy } from "../src/reliability.ts";
import {
  type ChatRequest,
  type ScriptedReply,
  ScriptedOpenAiServer,
} from "./scripted-openai-server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await closeSharedProxy();
});

const WRITER = "deepseek-v4.1-flash-1017";

async function startSession(
  flags: Record<string, unknown>,
  writer: (r: ChatRequest, i: number) => ScriptedReply,
) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-honesty-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  let turn = 0;
  const server = new ScriptedOpenAiServer((request) => writer(request, turn++));
  await server.start();
  cleanup.push(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const modelsPath = join(agentDir, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        prsloy: {
          baseUrl: server.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: WRITER,
              name: WRITER,
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 65536,
              maxTokens: 4096,
              compat: { supportsUsageInStreaming: true },
            },
          ],
        },
      },
    }),
  );
  const settingsPath = join(agentDir, "prsloy-harness.json");
  await writeFile(settingsPath, JSON.stringify({ secondOpinion: false, lessons: false, ...flags }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      createPrsloyHarness({ outputDir: join(root, "out"), profile: "code", settingsPath }),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: modelRuntime.getModel("prsloy", WRITER)!,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({});
  cleanup.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const cards = (type: string) =>
    (
      session.messages as unknown as {
        role: string;
        customType?: string;
        display?: boolean;
        content?: unknown;
        details?: unknown;
      }[]
    )
      .filter((m) => m.role === "custom" && m.customType === type && m.display)
      .map((m) => ({ content: String(m.content), details: m.details }));
  return { session, server, cwd, cards };
}

const TEST_JS =
  'const { finalPrice } = require("./price.js");\nconst got = finalPrice(200, 10);\nif (got !== 170) { console.error("FAIL: expected 170, got " + got); process.exit(1); }\nconsole.log("ok");\n';
const write = (path: string, content: string): ScriptedReply => ({
  toolCalls: [{ name: "write", arguments: { path, content } }],
});
const toolNames = (r: ChatRequest) =>
  ((r as unknown as { tools?: { function?: { name?: string } }[] }).tools ?? []).map(
    (t) => t.function?.name,
  );

describe("integration: H-1 test guard and report_blocker", () => {
  it("rewritten test → T2; test restored → T1 with report_blocker; blocker with a quote → card, no more push-backs", async () => {
    const t = await startSession(
      { testGuard: true, honestExit: true },
      (_r, i) =>
        [
          write("test.js", TEST_JS.replace("170", "190").replace("170", "190")),
          { text: "Готово, тест проходит." },
          write("test.js", TEST_JS),
          { text: "Вернул тест." },
          write(
            "price.js",
            "exports.finalPrice = (price, percent) => price - (price * percent) / 100;\n",
          ),
          {
            toolCalls: [
              {
                name: "report_blocker",
                arguments: {
                  what: "Старая проверка ждёт другую цену",
                  reason: "test_conflicts_request",
                  why: "Проверка ждёт 170 за скидку 10% от 200, а по вашей просьбе выходит 180",
                  need: "Скажите, исправить проверку или оставить так",
                  evidence: "if (got !== 170)",
                  options: ["Исправить проверку", "Оставить так"],
                },
              },
            ],
          },
          {
            text: "Сделал расчёт в процентах. Одна старая проверка ждёт другую цену — я её не трогал.",
          },
        ][i] ?? { text: "?" },
    );
    await writeFile(
      join(t.cwd, "package.json"),
      JSON.stringify({ name: "shop", scripts: { test: "node test.js" } }),
    );
    await writeFile(join(t.cwd, "test.js"), TEST_JS);
    await writeFile(
      join(t.cwd, "price.js"),
      "exports.finalPrice = (price, percent) => price - percent;\n",
    );
    await t.session.prompt(
      "Цена со скидкой считается неправильно: скидка в процентах. Почини, пожалуйста.",
    );
    const writer = t.server.requests.filter((r) => r.model === WRITER);
    expect(writer).toHaveLength(7);
    expect(toolNames(writer[0]!)).toContain("report_blocker");
    const t2 = JSON.stringify(writer[2]!.messages);
    expect(t2).toContain("Ты изменил проверки, которые были в проекте до этого хода");
    expect(t2).toContain("FAIL: expected 170, got 190");
    expect(JSON.stringify(writer[4]!.messages)).toContain("(или вызови report_blocker)");
    expect(JSON.stringify(writer[6]!.messages)).toContain("Записано, пользователь увидит карточку");
    expect(t.cards("prsloy-harness.blocker")).toEqual([
      {
        content: "Не получилось: Старая проверка ждёт другую цену",
        details: {
          what: "Старая проверка ждёт другую цену",
          why: "Проверка ждёт 170 за скидку 10% от 200, а по вашей просьбе выходит 180",
          need: "Скажите, исправить проверку или оставить так",
          reason: "test_conflicts_request",
          options: ["Исправить проверку", "Оставить так"],
        },
      },
    ]);
    expect(t.cards("prsloy-harness.stop-gate")).toEqual([]);
    // #25: принятый блокер «тест против просьбы» — ещё и предложение обновить тесты (одна карточка на сообщение).
    const prompt = "Цена со скидкой считается неправильно: скидка в процентах. Почини, пожалуйста.";
    expect(t.cards("prsloy-harness.tests-outdated")).toEqual([
      {
        content: TESTS_OUTDATED_CARD,
        details: {
          files: ["test.js"],
          quote: "if (got !== 170)",
          request: prompt,
          actions: [
            { label: "Обновить тесты", prompt: `Обнови тесты под новое правило: ${prompt}` },
            { label: "Оставить как есть" },
          ],
        },
      },
    ]);
  }, 90_000);

  it("defaults (#25): guard on, honestExit off — a rewritten old test is caught; restored and red → «tests outdated» card", async () => {
    const t = await startSession(
      {},
      (_r, i) =>
        [
          write(
            "price.js",
            "exports.finalPrice = (price, percent) => price - (price * percent) / 100;\n",
          ),
          write("test.js", TEST_JS.replace("170", "180").replace("170", "180")),
          { text: "Готово." },
          write("test.js", TEST_JS),
        ][i] ?? {
          text: "Старая проверка ждёт 170, а по вашей просьбе выходит 180 — я её не трогал.",
        },
    );
    await writeFile(
      join(t.cwd, "package.json"),
      JSON.stringify({ name: "shop", scripts: { test: "node test.js" } }),
    );
    await writeFile(join(t.cwd, "test.js"), TEST_JS);
    await writeFile(
      join(t.cwd, "price.js"),
      "exports.finalPrice = (price, percent) => price - percent;\n",
    );
    await t.session.prompt("Скидка теперь в процентах: 10 — это 10% от цены.");
    const writer = t.server.requests.filter((r) => r.model === WRITER);
    expect(toolNames(writer[0]!)).not.toContain("report_blocker");
    expect(JSON.stringify(writer[3]!.messages)).toContain(
      "Ты изменил проверки, которые были в проекте до этого хода",
    );
    expect(t.cards("prsloy-harness.tests-outdated")).toEqual([
      {
        content: TESTS_OUTDATED_CARD,
        details: {
          files: ["test.js"],
          quote:
            'if (got !== 170) { console.error("FAIL: expected 170, got " + got); process.exit(1); }',
          request: "Скидка теперь в процентах: 10 — это 10% от цены.",
          actions: [
            {
              label: "Обновить тесты",
              prompt:
                "Обнови тесты под новое правило: Скидка теперь в процентах: 10 — это 10% от цены.",
            },
            { label: "Оставить как есть" },
          ],
        },
      },
    ]);
  }, 90_000);
});

describe("integration: turn status card (H9, ui contract)", () => {
  const order = (t: Awaited<ReturnType<typeof startSession>>) =>
    (t.session.messages as unknown as { role: string; customType?: string; display?: boolean }[])
      .map((m) => (m.role === "custom" ? (m.customType ?? "custom") : m.role))
      .filter((r) => r !== "toolResult");
  const project = async (
    cwd: string,
    price = "exports.finalPrice = (price, percent) => price - percent;\n",
  ) => {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "shop", scripts: { test: "node test.js" } }),
    );
    await writeFile(join(cwd, "test.js"), TEST_JS.replaceAll("170", "180"));
    await writeFile(join(cwd, "price.js"), price);
  };
  const FIXED = "exports.finalPrice = (price, percent) => price - (price * percent) / 100;\n";

  it("green check → one card after the final reply: «Проверки прошли», facts [checks-pass]", async () => {
    const t = await startSession(
      {},
      (_r, i) =>
        [write("price.js", FIXED), { text: "Готово, считает в процентах." }][i] ?? { text: "?" },
    );
    await project(t.cwd);
    await t.session.prompt("Почини скидку.");
    expect(t.cards("prsloy-harness.turn-status")).toEqual([
      { content: "Проверки прошли", details: { facts: ["checks-pass"] } },
    ]);
    const seq = order(t);
    expect(seq.at(-1)).toBe("prsloy-harness.turn-status");
    expect(seq.at(-2)).toBe("assistant");
  }, 90_000);

  it("red after the cap → one card for the whole turn: «Проверки не прошли»", async () => {
    const WRONG = "exports.finalPrice = (price, percent) => price - percent * 1;\n";
    const t = await startSession(
      {},
      (_r, i) =>
        [
          write("price.js", WRONG),
          { text: "Готово." },
          write("price.js", WRONG),
          { text: "Готово." },
          write("price.js", WRONG),
          { text: "Не вышло." },
        ][i] ?? { text: "?" },
    );
    await project(t.cwd);
    await t.session.prompt("Почини скидку.");
    expect(t.cards("prsloy-harness.turn-status")).toEqual([
      { content: "Проверки не прошли", details: { facts: ["checks-fail"] } },
    ]);
  }, 90_000);

  it("a question without edits → no card", async () => {
    const t = await startSession({}, () => ({ text: "Это магазин: price.js считает цену." }));
    await project(t.cwd);
    await t.session.prompt("Что это за проект?");
    expect(t.cards("prsloy-harness.turn-status")).toEqual([]);
  }, 90_000);
});
