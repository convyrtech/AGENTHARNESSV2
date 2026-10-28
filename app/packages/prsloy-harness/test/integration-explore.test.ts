// Разведчик в настоящей сессии Pi (#47): писатель просит «explore», ребёнок ходит в шлюз отдельными запросами —
// только с инструментами чтения, и его стоимость видна в статистике сессии.
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
import { EXPLORE_LINE, EXPLORE_MARKER } from "../src/explore.ts";
import { closeSharedProxy } from "../src/reliability.ts";
import {
  type ChatRequest,
  messageText,
  type ScriptedReply,
  ScriptedOpenAiServer,
} from "./scripted-openai-server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await closeSharedProxy();
});

const WRITER = "deepseek-v4.1-flash-1017";

const model = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 4096,
  compat: { supportsUsageInStreaming: true },
});

/** Запрос разведчика: в системном сообщении наш маркер. */
function isChild(request: ChatRequest): boolean {
  return request.messages.some(
    (m) => m.role === "system" && messageText(m).includes(EXPLORE_MARKER),
  );
}

async function startSession(
  writer: (request: ChatRequest, index: number) => ScriptedReply,
  child: (request: ChatRequest, index: number) => ScriptedReply,
  flags: Record<string, unknown> | undefined,
) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-explore-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "sum.js"),
    "function sum(a, b) {\n  return a + b;\n}\nmodule.exports = { sum };\n",
  );
  let writerTurn = 0;
  let childTurn = 0;
  const server = new ScriptedOpenAiServer((request) =>
    isChild(request) ? child(request, childTurn++) : writer(request, writerTurn++),
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
        prsloy: {
          baseUrl: server.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [model(WRITER)],
        },
      },
    }),
  );
  const settingsPath = join(agentDir, "prsloy-harness.json");
  if (flags) await writeFile(settingsPath, JSON.stringify(flags));
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
      createPrsloyHarness({
        outputDir: join(root, "out"),
        profile: "code",
        settingsPath,
        // Второе мнение в этих тестах не проверяем: оно ходило бы к той же модели.
        disable: { secondOpinion: true, memory: true, lessons: true, autoMemory: true },
      }),
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
  return { session, server, cwd };
}

describe("integration: разведчик в сессии", () => {
  it("писатель зовёт explore, ребёнок ходит только с чтением, его токены в стоимости сессии", async () => {
    const t = await startSession(
      (_r, i) =>
        [
          { toolCalls: [{ name: "explore", arguments: { question: "где sum?" } }] },
          { text: "Готово." },
        ][i] ?? { text: "?" },
      (_r, i) =>
        [
          { toolCalls: [{ name: "grep", arguments: { pattern: "sum" } }] },
          { text: "sum объявлена в sum.js, строка 1." },
        ][i] ?? { text: "?" },
      { explore: "same" },
    );
    await t.session.prompt("где функция sum?");

    const childRequests = t.server.requests.filter(isChild);
    const writerRequests = t.server.requests.filter((r) => !isChild(r));
    expect(childRequests).toHaveLength(2);
    expect(writerRequests).toHaveLength(2);
    // У ребёнка в запросе только чтение — ни write, ни edit, ни bash.
    const childTools = childRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(childTools.sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(childTools).not.toContain("write");
    expect(childTools).not.toContain("edit");
    expect(childTools).not.toContain("bash");
    // Подсказка «когда звать» доехала до системного промпта писателя (в замере #47 её не было).
    const system = writerRequests[0]?.messages.find((m) => m.role === "system");
    expect(messageText(system!)).toContain(EXPLORE_LINE);
    // Родитель получил ответ разведчика в результате инструмента.
    expect(JSON.stringify(writerRequests[1]?.messages)).toContain("sum объявлена в sum.js");
    // 2 ответа писателя и 2 ребёнка, по 100 входных и 20 выходных по $1/$2 за миллион.
    expect(t.session.getSessionStats().cost).toBeCloseTo((4 * (100 * 1 + 20 * 2)) / 1e6, 9);
  }, 60_000);

  it("флаг explore выключен по умолчанию: инструмента у писателя нет", async () => {
    const t = await startSession(
      (_r, i) => [{ text: "Готово." }][i] ?? { text: "?" },
      (_r, i) => [{ text: "не должно быть" }][i] ?? { text: "?" },
      undefined,
    );
    await t.session.prompt("где функция sum?");
    const writerRequests = t.server.requests.filter((r) => !isChild(r));
    expect(writerRequests).toHaveLength(1);
    const names = writerRequests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(names).not.toContain("explore");
    const system = writerRequests[0]?.messages.find((m) => m.role === "system");
    expect(messageText(system!)).not.toContain(EXPLORE_LINE);
    expect(t.server.requests.filter(isChild)).toHaveLength(0);
  }, 60_000);
});
