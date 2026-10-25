// Второе мнение в настоящей сессии Pi: писатель DeepSeek, проверяющий Kimi — оба у мок-шлюза, одна сессия.
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
import { closeSharedProxy } from "../src/reliability.ts";
import { REVIEW_PASS_CARD } from "../src/second-opinion.ts";
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
const REVIEWER = "kimi-k3.1-pro";

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

type Writer = (request: ChatRequest, index: number) => ScriptedReply;

async function startSession(writer: Writer, review: (prompt: string) => string) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-review-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const reviews: string[] = [];
  let turn = 0;
  const server = new ScriptedOpenAiServer((request) => {
    if (request.model === REVIEWER) {
      const prompt = messageText(request.messages.at(-1));
      reviews.push(prompt);
      return { text: review(prompt) };
    }
    return writer(request, turn++);
  });
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
        prsloy: {
          baseUrl: server.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [model(WRITER), model(REVIEWER)],
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
    extensionFactories: [createPrsloyHarness({ outputDir: join(root, "out"), profile: "code" })],
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
  // Как хост приложения: bindExtensions шлёт session_start, и прокси надёжности встаёт перед шлюзом.
  await session.bindExtensions({});
  cleanup.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const cards = () =>
    (
      session.messages as unknown as {
        role: string;
        customType?: string;
        display?: boolean;
        content?: unknown;
      }[]
    )
      .filter(
        (m) => m.role === "custom" && m.customType === "prsloy-harness.second-opinion" && m.display,
      )
      .map((m) => String(m.content));
  return { session, server, cwd, reviews, cards, root };
}

const BUGGY =
  "function sum(a, b) {\n  return a - b;\n}\nfunction mul(a, b) {\n  return a * b;\n}\nmodule.exports = { sum, mul };\n";
const FIXED = BUGGY.replace("a - b", "a + b");
const write = (content: string): ScriptedReply => ({
  toolCalls: [{ name: "write", arguments: { path: "sum.js", content } }],
});
const verdict = (evidence: string) =>
  JSON.stringify({
    verdict: "FAIL",
    items: [{ file: "sum.js", line: 2, problem: "sum вычитает", evidence }],
  });

describe("integration: second opinion of another family", () => {
  it("FAIL with real evidence: one push back, the writer fixes it, the review cost is in the session cost", async () => {
    const t = await startSession(
      (_r, i) =>
        [write(BUGGY), { text: "Готово." }, write(FIXED), { text: "Исправил." }][i] ?? {
          text: "?",
        },
      () => verdict("return a - b;"),
    );
    await t.session.prompt("сделай функцию sum");
    expect(t.reviews).toHaveLength(1);
    expect(t.reviews[0]).toContain("сделай функцию sum");
    expect(t.reviews[0]).toContain("+  return a - b;");
    expect(t.cards()).toEqual(["Вторая модель нашла 1 замечание — исправляю"]);
    expect(await readFile(join(t.cwd, "sum.js"), "utf8")).toBe(FIXED);
    const writerRequests = t.server.requests.filter((r) => r.model === WRITER);
    expect(writerRequests).toHaveLength(4);
    expect(JSON.stringify(writerRequests[2]!.messages)).toContain(
      "Вторая модель другого семейства",
    );
    // 4 ответа писателя и 1 ответ проверяющего, по 100 входных и 20 выходных токенов по $1/$2 за миллион.
    expect(t.session.getSessionStats().cost).toBeCloseTo((5 * (100 * 1 + 20 * 2)) / 1e6, 9);
    // Проверяющий шёл через тот же прокси надёжности, что и писатель.
    const dir = t.session.sessionManager.getSessionDir() || join(t.root, "out");
    let text = "";
    for (let i = 0; i < 50 && !text.includes(REVIEWER); i++) {
      text = await readFile(join(dir, "prsloy-proxy.jsonl"), "utf8").catch(() => "");
      if (!text.includes(REVIEWER)) await new Promise((r) => setTimeout(r, 20));
    }
    const metrics = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { model: string; outcome: string });
    expect(metrics.filter((m) => m.model === REVIEWER)).toHaveLength(1);
  }, 60_000);

  it("FAIL with a made-up quote is a PASS: card «замечаний нет», no push back", async () => {
    const t = await startSession(
      (_r, i) => [write(BUGGY), { text: "Готово." }][i] ?? { text: "?" },
      () => verdict("return a + b + 1;"),
    );
    await t.session.prompt("сделай функцию sum");
    expect(t.cards()).toEqual([REVIEW_PASS_CARD]);
    expect(t.server.requests.filter((r) => r.model === WRITER)).toHaveLength(2);
  }, 60_000);

  it("a bash-only edit (sed -i, no edit/write call) is still seen by the gate and the reviewer", async () => {
    const t = await startSession(
      (_r, i) =>
        [
          {
            toolCalls: [
              {
                name: "bash",
                arguments: {
                  command:
                    "printf 'const a = 1;\\nconst b = 2;\\nconst c = 3;\\nconst d = 4;\\nconst e = 5;\\nconst f = 6;\\n' > nums.js && sed -i 's/= 6/= 66/' nums.js",
                },
              },
            ],
          },
          { text: "Готово." },
        ][i] ?? { text: "?" },
      () => '{"verdict":"PASS","items":[]}',
    );
    await t.session.prompt("создай nums.js");
    expect(t.reviews).toHaveLength(1);
    expect(t.reviews[0]).toContain("+const f = 66;");
    expect(t.cards()).toEqual([REVIEW_PASS_CARD]);
  }, 60_000);
});
