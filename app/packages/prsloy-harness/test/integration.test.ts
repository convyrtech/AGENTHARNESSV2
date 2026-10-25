// Настоящая сессия Pi (createAgentSession) против локального мок-шлюза: практики срабатывают в живом цикле агента.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPrsloyHarness, type HarnessOptions } from "../src/index.ts";
import { PSEUDO_CALL_NOTE } from "../src/loop-detector.ts";
import { messageText, ScriptedOpenAiServer, type Script } from "./scripted-openai-server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface ToolResultMessage {
  role: "toolResult";
  toolName: string;
  isError: boolean;
  content: { type: string; text?: string }[];
}

async function startSession(script: Script, load: { factory?: HarnessOptions; path?: string }) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const server = new ScriptedOpenAiServer(script);
  await server.start();
  cleanup.push(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
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
              id: "mock",
              name: "Mock",
              reasoning: false,
              input: ["text"],
              cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0 },
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
  const model = modelRuntime.getModel("mock", "mock");
  if (!model) throw new Error("mock model not found");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    ...(load.factory
      ? {
          extensionFactories: [
            createPrsloyHarness({ outputDir: join(root, "out"), ...load.factory }),
          ],
        }
      : {}),
    ...(load.path ? { additionalExtensionPaths: [load.path] } : {}),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  cleanup.push(async () => {
    session.dispose();
  });
  const errors = resourceLoader.getExtensions().errors;
  expect(errors).toEqual([]);
  const toolResults = () =>
    (session.messages as unknown as { role: string }[]).filter(
      (m): m is ToolResultMessage => m.role === "toolResult",
    );
  const textOf = (m: ToolResultMessage) => m.content.map((c) => c.text ?? "").join("");
  return { session, server, cwd, toolResults, textOf };
}

describe("integration: real createAgentSession + mock gateway", () => {
  it("loop detector: 3rd identical call gets the note, 5th stops the task", async () => {
    const { session, server, toolResults, textOf } = await startSession(
      (_req, index) =>
        index < 10
          ? { toolCalls: [{ name: "bash", arguments: { command: "echo same" } }] }
          : { text: "сдаюсь" },
      { factory: {} },
    );
    await session.prompt("сделай что-нибудь");
    const results = toolResults();
    expect(results).toHaveLength(5);
    expect(textOf(results[0]!)).toMatch(/^\[exit 0 · .*\]\nsame$/);
    expect(results[1]!.isError).toBe(false);
    expect(results[2]!.isError).toBe(true);
    expect(textOf(results[2]!)).toContain(
      "Этот вызов уже был 2 раза с тем же результатом. Сделай другое:",
    );
    expect(textOf(results[3]!)).toContain("уже был 3 раза");
    expect(textOf(results[4]!)).toContain("Задача остановлена");
    // terminate: после 5-го вызова агент больше не ходит к модели.
    expect(server.requests).toHaveLength(5);
  }, 30_000);

  it("bash timeout: a hanging command is stopped and the model is told so", async () => {
    const started = Date.now();
    const { session, server, toolResults, textOf } = await startSession(
      (_req, index) =>
        index === 0
          ? {
              toolCalls: [
                { name: "bash", arguments: { command: "echo begin; sleep 30; echo never" } },
              ],
            }
          : { text: "понял" },
      { factory: { bashTimeoutSec: 1 } },
    );
    await session.prompt("запусти");
    const [result] = toolResults();
    expect(result?.isError).toBe(true);
    const text = textOf(result!);
    expect(text.startsWith("[таймаут · ")).toBe(true);
    expect(text).toContain("begin");
    expect(text).not.toContain("never");
    expect(text).toContain("[Процесс остановлен по таймауту 1 с.]");
    expect(Date.now() - started).toBeLessThan(15_000);
    // Модель увидела это в следующем запросе.
    expect(JSON.stringify(server.requests[1]?.messages)).toContain(
      "Процесс остановлен по таймауту",
    );
  }, 30_000);

  it("budget: at the limit tools stop and a Russian summary is appended", async () => {
    const { session, server, toolResults, textOf } = await startSession(
      (_req, index) => ({
        toolCalls: [{ name: "bash", arguments: { command: `echo step${index}` } }],
      }),
      { factory: { maxToolCalls: 2 } },
    );
    await session.prompt("делай");
    const results = toolResults();
    expect(results.map((r) => r.isError)).toEqual([false, false, true, true]);
    expect(textOf(results[2]!)).toContain("Бюджет задачи исчерпан");
    expect(server.requests).toHaveLength(4);
    const summary = (
      session.messages as unknown as { role: string; customType?: string; content?: unknown }[]
    ).find((m) => m.role === "custom" && m.customType === "prsloy-harness.budget");
    expect(String(summary?.content)).toContain(
      "Задача остановлена: исчерпан лимит вызовов тулов (2)",
    );
  }, 30_000);

  it("pseudo tool call written as text is not executed; the model is asked for a real call", async () => {
    const { session, server, toolResults } = await startSession(
      (_req, index) =>
        index === 0
          ? {
              text: 'Запускаю.\n<tool_call>{"name": "bash", "arguments": {"command": "touch hacked"}}</tool_call>',
            }
          : { text: "Готово." },
      { factory: {} },
    );
    await session.prompt("создай файл");
    expect(toolResults()).toHaveLength(0);
    expect(server.requests).toHaveLength(2);
    const last = server.requests[1]!.messages.at(-1);
    expect(messageText(last)).toContain(PSEUDO_CALL_NOTE);
  }, 30_000);

  it("loads from a file path like the agent host does: tools registered, post-edit check and secret scrub fire", async () => {
    const entry = resolve(import.meta.dirname, "../src/index.ts");
    const { session, server, cwd, toolResults, textOf } = await startSession(
      (_req, index) => {
        if (index === 0)
          return {
            toolCalls: [{ name: "write", arguments: { path: "data.json", content: '{"a": 1,}' } }],
          };
        if (index === 1) return { toolCalls: [{ name: "read", arguments: { path: ".env" } }] };
        return { text: "ok" };
      },
      { path: entry },
    );
    await writeFile(
      join(cwd, ".env"),
      "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n",
    );
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["bash", "bash_background", "process"]),
    );
    await session.prompt("запиши файл");
    const [write, read] = toolResults();
    expect(textOf(write!)).toContain("[Проверка синтаксиса (JSON.parse): ОШИБКА в data.json");
    expect(textOf(read!)).not.toContain("sk-proj-");
    expect(textOf(read!)).toContain("[СКРЫТО: sk-ключ]");
    // Раздел «поиск готового» (профиль «Код» по умолчанию) дошёл до шлюза в системном промпте.
    const system = server.requests[0]!.messages.find(
      (m) => m.role === "system" || m.role === "developer",
    );
    expect(messageText(system)).toContain("<prsloy_reuse_first>");
    expect(messageText(system)).toContain("well-established library");
  }, 30_000);

  it("loads as a Pi package directory (package.json pi.extensions)", async () => {
    const { session } = await startSession(() => ({ text: "ok" }), {
      path: resolve(import.meta.dirname, ".."),
    });
    expect(session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["bash_background", "process"]),
    );
  }, 30_000);
});
