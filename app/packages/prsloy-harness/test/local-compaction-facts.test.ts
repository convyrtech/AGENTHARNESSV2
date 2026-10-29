// Бесплатный замер локального сжатия (#76): что модель реально видит после него. Сеть не нужна — ответы задаёт
// ScriptedOpenAiServer, но сжатие, записи сессии и события идут через настоящий Pi и настоящий харнесс.
// Считаем, сколько фактов задачи пережило сжатие: просьбы, запрет, правленый файл, упавшая команда, недоделка.
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
import {
  type ChatRequest,
  messageText,
  ScriptedOpenAiServer,
  type ScriptedReply,
} from "./scripted-openai-server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Факты задачи: выдуманный обезличенный проект, ничего из настоящих сессий. */
const FACTS = [
  { id: "project", needle: "Тик-так", what: "название проекта из первой просьбы" },
  { id: "constraint", needle: "styles/shared.css", what: "запрет трогать общий файл" },
  { id: "edited", needle: "site/index.html", what: "файл, который агент менял" },
  { id: "failed", needle: "npm test", what: "упавшая команда" },
  { id: "unfinished", needle: "форму заявки", what: "незаконченная часть задачи" },
];

const FIRST_PROMPT =
  "Сделай страницу-визитку для мастерской часов «Тик-так». Только не трогай styles/shared.css — он общий для всех страниц.";
const SECOND_PROMPT = "Осталось добавить форму заявки — доделай, потом прогони npm test.";

const LOCAL_MARK = "PRSLOY local compaction";
const isSummaryCall = (req: ChatRequest) =>
  req.messages.some((m) => messageText(m).includes("context summarization assistant"));

/** Большой вход: так Pi видит переполнение окна и сжимает историю посреди хода. */
const BIG = { prompt_tokens: 11_500, completion_tokens: 20, total_tokens: 11_520 };

/** Работа с фактами. Текст (конец хода) — только после сжатия: иначе ход закрывается и Pi сжимать не станет. */
const normalScript = (index: number): ScriptedReply => {
  switch (index) {
    case 0:
      return {
        toolCalls: [
          { name: "write", arguments: { path: "site/index.html", content: "<h1>Тик-так</h1>" } },
        ],
      };
    case 1:
      return { text: "Страница готова." };
    case 2:
      return { toolCalls: [{ name: "bash", arguments: { command: "npm test" } }] };
    case 3:
    case 4:
      return { toolCalls: [{ name: "bash", arguments: { command: "echo шаг" } }], usage: BIG };
    default:
      return { text: "Продолжаю." };
  }
};

/** Шторм: каждый ответ после начала работы снова переполняет окно и просит ещё шаг. */
const stormScript = (index: number): ScriptedReply => {
  if (index === 0)
    return {
      toolCalls: [
        { name: "write", arguments: { path: "site/index.html", content: "<h1>Тик-так</h1>" } },
      ],
      usage: BIG,
    };
  return { toolCalls: [{ name: "bash", arguments: { command: "echo шаг" } }], usage: BIG };
};

interface SessionOptions {
  taskThread?: boolean;
  /** Сколько последних токенов Pi оставляет дословно (по умолчанию в приложении — 20 000). */
  keepRecentTokens?: number;
  script?: (index: number) => ScriptedReply;
  prompt?: string;
}

async function startSession(opts: SessionOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-compact-facts-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const settingsPath = join(root, "prsloy-harness.json");
  await writeFile(
    settingsPath,
    JSON.stringify({ taskThread: opts.taskThread ?? false, secondOpinion: false }),
  );
  const script = opts.script ?? normalScript;
  const server = new ScriptedOpenAiServer((req, index) =>
    isSummaryCall(req) ? { text: "## Goal\nКраткий пересказ." } : script(index),
  );
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
        mock: {
          baseUrl: server.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k3.1-pro",
              name: "Kimi",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 12_000,
              maxTokens: 1_000,
              compat: { supportsUsageInStreaming: true },
            },
          ],
        },
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 2_000,
      keepRecentTokens: opts.keepRecentTokens ?? 50,
    },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      createPrsloyHarness({
        outputDir: join(root, "out"),
        profile: "code",
        reliabilityProviders: [],
        settingsPath,
      }),
    ],
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: modelRuntime.getModel("mock", "kimi-k3.1-pro")!,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  await session.bindExtensions({});
  cleanup.push(async () => {
    session.dispose();
  });
  return { session, server, sessionManager };
}

/** Сообщения первого запроса, который несёт текст локального пересказа (то есть после сжатия). */
function afterCompaction(server: ScriptedOpenAiServer): string {
  const at = server.requests.findIndex((r) => JSON.stringify(r.messages).includes(LOCAL_MARK));
  expect(at).toBeGreaterThanOrEqual(0);
  return JSON.stringify(server.requests[at]!.messages);
}

const compactionsOf = (entries: readonly unknown[]) =>
  entries.filter((e) => (e as { type?: string }).type === "compaction").length;

async function measure(opts: SessionOptions): Promise<{
  facts: { what: string; kept: boolean }[];
  kept: number;
  requests: number;
  summaryRequests: number;
  compactions: number;
}> {
  const { session, server, sessionManager } = await startSession(opts);
  await session.prompt(FIRST_PROMPT);
  await session.prompt(SECOND_PROMPT);
  const seen = afterCompaction(server);
  const facts = FACTS.map((f) => ({ what: f.what, kept: seen.includes(f.needle) }));
  return {
    facts,
    kept: facts.filter((f) => f.kept).length,
    requests: server.requests.length,
    summaryRequests: server.requests.filter(isSummaryCall).length,
    compactions: compactionsOf(sessionManager.getEntries()),
  };
}

function report(tag: string, r: Awaited<ReturnType<typeof measure>>): void {
  console.log(
    `[${tag}] факты ${r.kept}/${FACTS.length}, запросов ${r.requests}, сжатий ${r.compactions}, запросов пересказа ${r.summaryRequests}`,
  );
  for (const f of r.facts) console.log(`[${tag}] ${f.kept ? "ЕСТЬ" : "НЕТ "} ${f.what}`);
}

describe("local compaction: which task facts survive (#76)", () => {
  it("flag off, worst case (only the summary, no retained tail)", async () => {
    const r = await measure({ taskThread: false, keepRecentTokens: 50 });
    report("local", r);
    // Сжатие проходит без единого запроса к активной модели: пересказ детерминированный.
    expect(r.summaryRequests).toBe(0);
    expect(r.compactions).toBe(1);
  }, 60_000);

  it("flag on, worst case: the harness task thread brings the facts back", async () => {
    const r = await measure({ taskThread: true, keepRecentTokens: 50 });
    report("thread", r);
    expect(r.summaryRequests).toBe(0);
    expect(r.compactions).toBe(1);
    expect(r.kept).toBe(FACTS.length);
  }, 60_000);

  it("flag off, a retained tail (300 tokens kept verbatim)", async () => {
    const r = await measure({ taskThread: false, keepRecentTokens: 300 });
    report("local-tail", r);
    expect(r.summaryRequests).toBe(0);
  }, 60_000);

  it("a compaction storm stops: one compaction, no new requests after the guard", async () => {
    const { session, server, sessionManager } = await startSession({ script: stormScript });
    await session.prompt(FIRST_PROMPT);
    const requests = server.requests.length;
    const compactions = compactionsOf(sessionManager.getEntries());
    // Ход закончился сам, без новых сообщений пользователя: после стража клиент молчит.
    const settled = server.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log(`[storm] запросов ${requests}, сжатий ${compactions}, после хода ${settled}`);
    expect(compactions).toBe(1);
    expect(settled).toBe(requests);
    expect(server.requests.filter(isSummaryCall)).toHaveLength(0);
    expect(requests).toBeLessThanOrEqual(12);
  }, 60_000);
});
