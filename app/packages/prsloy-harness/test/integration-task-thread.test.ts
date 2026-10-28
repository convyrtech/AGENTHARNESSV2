// Нить задачи в настоящей сессии Pi (#64 п.1): окно маленькое, история сжимается посреди хода, и следующий запрос к
// модели несёт пересказ и сразу за ним блок фактов харнесса. Без флага — пересказ без блока.
// С 6c95a70 пересказ делает сам харнесс (src/continuation-guard.ts): Pi больше не зовёт модель за пересказом,
// поэтому запроса с «context summarization assistant» в сессии нет. Признак сжатия — локальный пересказ
// в следующем запросе. Что модель за пересказом не звали — проверяется отдельно: это и есть смысл правки.
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
import { type ChatRequest, messageText, ScriptedOpenAiServer } from "./scripted-openai-server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const SUMMARY = "## Goal\nFix the tests.\n## Progress\n- [x] ran echo one";
// Запрос пересказа к модели. С локальным сжатием его быть не должно; сервер отвечает на него на случай,
// если поведение вернётся к старому, — тогда тест падает на явной проверке ниже, а не на таймауте.
const isSummaryCall = (req: ChatRequest) =>
  req.messages.some((m) => messageText(m).includes("context summarization assistant"));
// Текст, которым continuation-guard заменяет пересказ модели.
const LOCAL_SUMMARY = "PRSLOY local compaction";
// Первый запрос, который видит сжатие: в его истории уже лежит пересказ.
const isCompactedRequest = (req: ChatRequest) =>
  req.messages.some((m) => messageText(m).includes("was compacted into the following summary"));

async function startSession(taskThread: boolean) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-thread-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const settingsPath = join(root, "prsloy-harness.json");
  await writeFile(settingsPath, JSON.stringify({ taskThread, secondOpinion: false }));
  let work = 0;
  const server = new ScriptedOpenAiServer((req) => {
    if (isSummaryCall(req)) return { text: SUMMARY };
    work += 1;
    // Две просьбы: первая — один вызов и ответ; во второй вызов сообщает большой вход, и перед следующим запросом
    // окно переполнено — Pi сжимает историю посреди хода.
    if (work === 1) return { toolCalls: [{ name: "bash", arguments: { command: "echo one" } }] };
    if (work === 2) return { text: "Первый шаг сделан." };
    // Pi сверяет порог по последнему сохранённому ответу — на шаг позже, поэтому большой вход дважды.
    const big = { prompt_tokens: 11500, completion_tokens: 20, total_tokens: 11520 };
    if (work === 3)
      return { toolCalls: [{ name: "bash", arguments: { command: "echo two" } }], usage: big };
    if (work === 4)
      return { toolCalls: [{ name: "bash", arguments: { command: "echo three" } }], usage: big };
    return { text: "Готово." };
  });
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
              contextWindow: 12000,
              maxTokens: 1000,
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
    compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 50 },
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

function afterCompaction(server: ScriptedOpenAiServer): string {
  const at = server.requests.findIndex(isCompactedRequest);
  expect(at).toBeGreaterThanOrEqual(0);
  return JSON.stringify(server.requests[at]!.messages);
}

/** Сжатие осталось локальным: за пересказом модель не звали — ни одного лишнего большого запроса. */
function expectNoModelSummary(server: ScriptedOpenAiServer): void {
  expect(server.requests.filter(isSummaryCall)).toHaveLength(0);
}

describe("integration: task thread after a compaction mid-turn", () => {
  it("flag on: the next request carries the summary and then the harness facts", async () => {
    const { session, server, sessionManager } = await startSession(true);
    await session.prompt("Почини тесты, задача #50");
    await session.prompt("Теперь дождись зелёного CI");
    const next = afterCompaction(server);
    expectNoModelSummary(server);
    expect(next).toContain(LOCAL_SUMMARY);
    expect(next).toContain("<task_thread>");
    expect(next).toContain("Do not start over");
    expect(next).toContain("[1] Почини тесты, задача #50");
    expect(next).toContain("[2] Теперь дождись зелёного CI");
    expect(next).toContain("[0] echo one");
    expect(next.indexOf(LOCAL_SUMMARY)).toBeLessThan(next.indexOf("<task_thread>"));
    // the block is stored with the session (a host restart brings it back)
    const stored = sessionManager
      .getEntries()
      .filter(
        (e) =>
          e.type === "custom" &&
          (e as { customType?: string }).customType === "prsloy-harness.task-thread",
      );
    expect(stored).toHaveLength(1);
  }, 60_000);

  it("flag off: local compaction still carries the session facts", async () => {
    const { session, server } = await startSession(false);
    await session.prompt("Почини тесты, задача #50");
    await session.prompt("Теперь дождись зелёного CI");
    const next = afterCompaction(server);
    expectNoModelSummary(server);
    expect(next).toContain(LOCAL_SUMMARY);
    expect(next).toContain("<task_thread>");
    expect(next).toContain("[1] Почини тесты, задача #50");
  }, 60_000);
});
