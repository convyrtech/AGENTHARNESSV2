// Настоящая сессия Pi с провайдером `prsloy` (как в приложении: models.json + ключ рантайма) и мок-шлюзом,
// который сбоит как a6: прокси надёжности подключается расширением сам.
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
import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";
import { createPrsloyHarness } from "../src/index.ts";
import { closeSharedProxy } from "../src/reliability.ts";
import { STREAM_INTERRUPTED_MESSAGE } from "../src/reliability-proxy.ts";
import { type Behaviour, FakeGateway } from "./fake-gateway.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
afterAll(async () => {
  await closeSharedProxy();
});

interface Assistant {
  role: "assistant";
  stopReason: string;
  errorMessage?: string;
  content: { type: string; text?: string }[];
}

async function session(script: (i: number) => Behaviour) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-rel-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const out = join(root, "out");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const gateway = new FakeGateway(script);
  await gateway.start();
  cleanup.push(async () => {
    await gateway.stop();
    await rm(root, { recursive: true, force: true });
  });
  const modelsPath = join(agentDir, "models.json");
  // Как buildPrsloyModelsJsonProvider: ключа в models.json нет, он — ключ рантайма.
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        prsloy: {
          baseUrl: gateway.baseUrl,
          api: "openai-completions",
          models: [
            {
              id: "deepseek-v4.1-flash",
              name: "DeepSeek",
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
  await modelRuntime.setRuntimeApiKey("prsloy", "rk-runtime-key");
  const model = modelRuntime.getModel("prsloy", "deepseek-v4.1-flash");
  if (!model) throw new Error("no model");
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
        outputDir: out,
        reliability: { ttftMs: 1_500, pingMs: 200, idleMs: 1_500, backoffMs: () => 0 },
      }),
    ],
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
  await session.bindExtensions({});
  cleanup.push(async () => session.dispose());
  const last = () =>
    (session.messages as unknown as { role: string }[])
      .filter((m): m is Assistant => m.role === "assistant")
      .at(-1);
  const text = (m: Assistant | undefined) => (m?.content ?? []).map((c) => c.text ?? "").join("");
  return { session, gateway, last, text, out, cwd };
}

describe("integration: reliability proxy in a real session (provider prsloy)", () => {
  it("an in-stream gateway error is retried: the user sees a normal answer", async () => {
    const s = await session((i) =>
      i === 0 ? { kind: "stream-error" } : { kind: "ok", text: "Готово, всё работает." },
    );
    await s.session.prompt("сделай");
    expect(s.last()?.stopReason).toBe("stop");
    expect(s.text(s.last())).toBe("Готово, всё работает. ");
    expect(s.gateway.requests).toHaveLength(2);
    // Ключ рантайма дошёл до шлюза через прокси; прокси его не хранит.
    expect(s.gateway.requests[1]?.headers.authorization).toBe("Bearer rk-runtime-key");
  }, 30_000);

  it("a supplier stall before the first token is retried", async () => {
    const s = await session((i) =>
      i === 0 ? { kind: "stall", ms: 5_000 } : { kind: "ok", text: "Успел." },
    );
    await s.session.prompt("сделай");
    expect(s.text(s.last())).toBe("Успел. ");
    expect(s.gateway.requests).toHaveLength(2);
  }, 30_000);

  it("chunks split mid-JSON reach Pi as a whole answer", async () => {
    const s = await session(() => ({ kind: "split", text: "длинный разрезанный ответ" }));
    await s.session.prompt("сделай");
    expect(s.text(s.last())).toBe("длинный разрезанный ответ");
  }, 30_000);

  it("a drop after the first token ends the turn with «Связь с моделью оборвалась»", async () => {
    const s = await session(() => ({ kind: "drop-after-first", text: "Начинаю отвечать" }));
    await s.session.prompt("сделай");
    expect(s.last()?.stopReason).toBe("error");
    expect(s.last()?.errorMessage).toContain(STREAM_INTERRUPTED_MESSAGE);
    expect(s.gateway.requests).toHaveLength(1);
  }, 30_000);

  it("writes per-call metrics (model, attempts, ttft, tokens) to the session log dir", async () => {
    const s = await session((i) => (i === 0 ? { kind: "status", status: 502 } : { kind: "ok" }));
    await s.session.prompt("сделай");
    const dir = s.session.sessionManager.getSessionDir();
    let text = "";
    for (let i = 0; i < 50 && !text; i++) {
      text = await readFile(join(dir || s.out, "prsloy-proxy.jsonl"), "utf8").catch(() => "");
      if (!text) await new Promise((r) => setTimeout(r, 20));
    }
    const line = JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({
      model: "deepseek-v4.1-flash",
      outcome: "ok",
      prompt: 120,
      cached: 100,
    });
    expect((line.attempts as unknown[]).length).toBe(2);
  }, 30_000);
});
