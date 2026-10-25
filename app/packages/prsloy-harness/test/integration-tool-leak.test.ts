// Сорванный вызов инструмента в настоящей сессии Pi: DeepSeek отдаёт вызов текстом (дубль рассуждения + теги DSML),
// харнесс возвращает модель, она делает настоящий вызов, ход доходит до конца.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { TOOL_LEAK_GAVE_UP, TOOL_LEAK_NOTE } from "../src/tool-leak.ts";
import { type Script, ScriptedOpenAiServer } from "./scripted-openai-server.ts";
import { LEAK_TEXT, LEAK_THINKING } from "./tool-leak-fixtures.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function startSession(script: Script) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-leak-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const server = new ScriptedOpenAiServer(script);
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
              id: "deepseek-v4.1-flash-1017",
              name: "DeepSeek",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 65536,
              maxTokens: 4096,
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
        reliabilityProviders: [],
      }),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: modelRuntime.getModel("mock", "deepseek-v4.1-flash-1017")!,
    thinkingLevel: "medium",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({});
  cleanup.push(async () => {
    session.dispose();
  });
  return { session, server, cwd };
}

const leak = { reasoning: LEAK_THINKING, text: LEAK_TEXT };

describe("integration: a tool call leaked as text does not end the turn", () => {
  it("DeepSeek leaks the call, is pushed back once, makes a real call, the turn completes", async () => {
    const { session, server, cwd } = await startSession(
      (_req, i) =>
        [
          leak,
          { toolCalls: [{ name: "write", arguments: { path: "motion.js", content: "// ok\n" } }] },
          { text: "Готово." },
        ][i] ?? { text: "?" },
    );
    await session.prompt("проверь motion.js");
    expect(server.requests).toHaveLength(3);
    const retry = JSON.stringify(server.requests[1]!.messages);
    expect(retry).toContain(TOOL_LEAK_NOTE);
    // Модель не видит свою простыню и теги — только рассуждение.
    expect(retry).not.toContain("DSML");
    expect(retry.split("Let me check motion.js").length - 1).toBeLessThanOrEqual(1);
    expect(await readFile(join(cwd, "motion.js"), "utf8")).toBe("// ok\n");
  }, 60_000);

  it("leaks every time: 2 push backs, then «Модель сбилась…» and the turn ends", async () => {
    const { session, server } = await startSession(() => leak);
    await session.prompt("проверь motion.js");
    expect(server.requests).toHaveLength(3);
    const cards = (
      session.messages as unknown as {
        role: string;
        customType?: string;
        display?: boolean;
        content?: unknown;
      }[]
    ).filter(
      (m) => m.role === "custom" && m.customType === "prsloy-harness.tool-leak" && m.display,
    );
    expect(cards.map((m) => m.content)).toEqual([TOOL_LEAK_GAVE_UP]);
  }, 60_000);

  it("the stop gate waits while the call is retried", async () => {
    const { session, server, cwd } = await startSession(
      (_req, i) =>
        [
          { toolCalls: [{ name: "write", arguments: { path: "a.js", content: "x\n" } }] },
          leak,
          { text: "Готово." },
          { text: "Исправлю." },
        ][i] ?? { text: "?" },
    );
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
    await session.prompt("сделай");
    // 2-й ответ — утечка: возврат tool-leak, гейт молчит; 3-й — «Готово»: красный гейт возвращает модель.
    const second = JSON.stringify(server.requests[2]!.messages);
    expect(second).toContain(TOOL_LEAK_NOTE);
    expect(second).not.toContain("Проверка проекта не прошла");
    expect(JSON.stringify(server.requests[3]!.messages)).toContain("Проверка проекта не прошла");
  }, 60_000);
});
