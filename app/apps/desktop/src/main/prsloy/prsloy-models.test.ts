/**
 * Models come from the gateway's `/v1/models`, not from a fixed list (2026-10-25: the live
 * gateway served neither DeepSeek nor Kimi). Presets take the first served model of their
 * preference list; a model that disappears mid-session is replaced quietly; an output
 * limit the gateway refuses steps down 128k → 64k → 32k.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { classifyModelError, createPixRuntime } from "@zeno/agent-runtime";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import {
  buildPrsloyModelsJsonProvider,
  isPrsloyChatModelId,
  prsloyFallbackModelId,
  prsloyMaxTokens,
  prsloyModelCost,
  prsloySpeedModelId,
  PRSLOY_MAX_TOKENS,
  PRSLOY_MODELS,
  PRSLOY_OUTPUT_LIMITS,
  PRSLOY_PROVIDER_ID,
} from "../../shared/prsloy-config.ts";
import { createPrsloyFetch, modelSwitchText } from "../../agent-host/prsloy-fetch.ts";
import { bootstrapPrsloy } from "./context.ts";
import { refreshPrsloyModels } from "./model-list.ts";

const LIVE = [
  "gpt-6.1-sol",
  "claude-opus-5-5",
  "claude-fable-5",
  "grok-4.7",
  "qwen3.8-max",
  "gpt-image-2",
  "gpt-image-2.5",
  "nano-banana-2.1",
  "nano-banana-pro",
];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function context() {
  return bootstrapPrsloy({
    userDataPath: tempDir("prsloy-models-ud-"),
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (buf) => buf.toString(),
    },
    env: {},
    platform: "linux",
  });
}
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("catalog and presets from the gateway's list", () => {
  it("image models never become chat models", () => {
    for (const id of ["gpt-image-2", "gpt-image-2.5", "nano-banana-2.1", "nano-banana-pro"]) {
      expect(isPrsloyChatModelId(id), id).toBe(false);
    }
    for (const id of ["gpt-6.1-sol", "qwen3.8-max", "grok-4.7", "claude-fable-5"]) {
      expect(isPrsloyChatModelId(id), id).toBe(true);
    }
  });

  it("no DeepSeek and Kimi on the gateway → both presets GPT-6.1 Sol, never Qwen or Grok", () => {
    expect(prsloySpeedModelId("fast", LIVE)).toBe("gpt-6.1-sol");
    expect(prsloySpeedModelId("quality", LIVE)).toBe("gpt-6.1-sol");
    // Only Kimi: it is «Быстрее» too, ahead of anything that drops our system message.
    expect(prsloySpeedModelId("fast", ["qwen3.8-max", "kimi-k3.1-pro"])).toBe("kimi-k3.1-pro");
    // Once the owner adds them, they win again.
    const full = [...LIVE, "deepseek-v4.1-flash-1017", "kimi-k3.1-pro"];
    expect(prsloySpeedModelId("fast", full)).toBe("deepseek-v4.1-flash-1017");
    expect(prsloySpeedModelId("quality", full)).toBe("kimi-k3.1-pro");
    // Not checked yet: the first choices.
    expect(prsloySpeedModelId("fast")).toBe("deepseek-v4.1-flash-1017");
  });

  it("a vanished model falls to the next served one of its preset", () => {
    expect(prsloyFallbackModelId("deepseek-v4.1-flash-1017", LIVE)).toBe("gpt-6.1-sol");
    expect(prsloyFallbackModelId("kimi-k3.1-pro", LIVE)).toBe("gpt-6.1-sol");
    expect(prsloyFallbackModelId("claude-opus-5-5", ["qwen3.8-max", "gpt-6.1-sol"])).toBe(
      "gpt-6.1-sol",
    );
    expect(prsloyFallbackModelId("something-old", LIVE)).toBe("gpt-6.1-sol");
    expect(prsloyFallbackModelId("qwen3.8-max", ["qwen3.8-max"])).toBeUndefined();
  });

  it("models.json lists only what the gateway serves; prices for the five text models", () => {
    const provider = buildPrsloyModelsJsonProvider("https://gw.example/v1", LIVE) as {
      models: { id: string; maxTokens: number; cost: { input: number } }[];
    };
    expect(provider.models.map((m) => m.id).sort()).toEqual(
      ["claude-fable-5", "claude-opus-5-5", "gpt-6.1-sol", "grok-4.7", "qwen3.8-max"].sort(),
    );
    expect(provider.models.every((m) => m.maxTokens === 128_000)).toBe(true);
    // #39: каждая модель каталога — в таблице лимитов вывода с источником; спрашиваем min(128k, свой).
    for (const m of PRSLOY_MODELS) {
      const own = PRSLOY_OUTPUT_LIMITS[m.id];
      expect(own?.source, m.id).toBeTruthy();
      expect(m.maxTokens, m.id).toBe(
        own?.tokens ? Math.min(PRSLOY_MAX_TOKENS, own.tokens) : PRSLOY_MAX_TOKENS,
      );
    }
    expect(prsloyMaxTokens("unknown-model")).toBe(PRSLOY_MAX_TOKENS);
    expect(prsloyModelCost("gpt-6.1-sol").input).toBeGreaterThan(0);
    expect(prsloyModelCost("qwen3.8-max").input).toBeGreaterThan(0);
    expect(prsloyModelCost("claude-opus-5-5").input).toBeGreaterThan(0);
    // The gateway's price list now covers these too (#52): priced in rubles.
    expect(prsloyModelCost("grok-4.7")).toEqual({
      input: 6,
      output: 18,
      cacheRead: 1.5,
      cacheWrite: 7.5,
    });
    expect(prsloyModelCost("claude-fable-5").input).toBeGreaterThan(0);
    // A chat model the catalog doesn't know yet is offered too.
    const withNew = buildPrsloyModelsJsonProvider("https://gw.example/v1", ["new-model-9"]) as {
      models: { id: string }[];
    };
    expect(withNew.models.map((m) => m.id)).toEqual(["new-model-9"]);
  });

  it("state keeps the list, models.json follows it, a vanished default moves on", async () => {
    const ctx = context();
    const settingsPath = join(ctx.agentDir, "settings.json");
    expect(readJson(settingsPath).defaultModel).toBe("deepseek-v4.1-flash-1017");
    expect(ctx.availableModels()).toBeUndefined();

    const server = new MockGatewayServer({ apiKey: "sk-m", modelIds: LIVE });
    await server.start();
    cleanups.push(() => server.stop());
    ctx.setBaseUrl(server.baseUrl);
    ctx.keyStore.write("sk-m");
    let changed = 0;
    const refresh = () =>
      refreshPrsloyModels({ ctx, fetch: fetch, onChanged: () => void (changed += 1) });
    expect(await refresh()).toBe(true);
    expect(changed).toBe(1);
    expect(ctx.availableModels()).toEqual(LIVE);
    const models = readJson(join(ctx.agentDir, "models.json")).providers.prsloy.models;
    expect(models.map((m: { id: string }) => m.id)).not.toContain("deepseek-v4.1-flash-1017");
    expect(models.map((m: { id: string }) => m.id)).not.toContain("gpt-image-2");
    expect(readJson(settingsPath).defaultModel).toBe("gpt-6.1-sol");
    // Same list again: nothing to reload.
    expect(await refresh()).toBe(false);
    expect(changed).toBe(1);
    // Kept across restarts.
    expect(
      JSON.parse(readFileSync(join(ctx.paths.stateDir, "state.json"), "utf8")).models.ids,
    ).toEqual(LIVE);
    // The owner adds DeepSeek: it is offered on the next refresh.
    server.modelIds = [...LIVE, "deepseek-v4.1-flash-1017"];
    expect(await refresh()).toBe(true);
    expect(
      readJson(join(ctx.agentDir, "models.json")).providers.prsloy.models.map(
        (m: { id: string }) => m.id,
      ),
    ).toContain("deepseek-v4.1-flash-1017");
  });

  it("offline or a gateway without /models keeps the last list", async () => {
    const ctx = context();
    ctx.setAvailableModels(LIVE);
    const server = new MockGatewayServer({ apiKey: "sk-m", noModelsEndpoint: true });
    await server.start();
    cleanups.push(() => server.stop());
    ctx.setBaseUrl(server.baseUrl);
    ctx.keyStore.write("sk-m");
    expect(await refreshPrsloyModels({ ctx, fetch })).toBe(false);
  });
});

describe("quiet recovery on the wire (real pi runtime, agent-host fetch wrapper)", () => {
  async function session(server: MockGatewayServer, model: string) {
    const ctx = context();
    ctx.setBaseUrl(server.baseUrl);
    ctx.setAvailableModels(server.modelIds);
    const workspace = tempDir("prsloy-models-ws-");
    writeFileSync(join(workspace, "a.txt"), "x\n");
    const switches: [string, string][] = [];
    const original = globalThis.fetch;
    globalThis.fetch = createPrsloyFetch({
      base: original.bind(globalThis),
      apiKey: "sk-w",
      listModels: async () => [...server.modelIds],
      onModelSwitch: (from, to) => switches.push([from, to]),
    });
    cleanups.push(() => {
      globalThis.fetch = original;
    });
    const handle = await createPixRuntime({
      cwd: workspace,
      agentDir: ctx.agentDir,
      tools: ["read"],
      runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: "sk-w" },
    });
    cleanups.push(() => handle.dispose());
    await handle.setModel(PRSLOY_PROVIDER_ID, model);
    return { handle, switches };
  }

  it("the model disappears mid-session → one quiet switch, the turn completes", async () => {
    const server = new MockGatewayServer({
      apiKey: "sk-w",
      modelIds: ["kimi-k3.1-pro", "claude-opus-5-5", "qwen3.8-max"],
      serveListedOnly: true,
      turns: [{ text: "Первый ответ." }, { text: "Ответ после перехода." }, { text: "Третий." }],
    });
    await server.start();
    cleanups.push(() => server.stop());
    const { handle, switches } = await session(server, "kimi-k3.1-pro");
    await handle.runtime.session.prompt("Привет");
    expect(server.requests.at(-1)!.body.model).toBe("kimi-k3.1-pro");

    server.modelIds = ["claude-opus-5-5", "qwen3.8-max"]; // Kimi is gone
    await handle.runtime.session.prompt("Ещё");
    const last = [...handle.runtime.session.messages].reverse().find((m) => m.role === "assistant");
    expect(JSON.stringify(last)).toContain("Ответ после перехода.");
    expect(switches).toEqual([["kimi-k3.1-pro", "claude-opus-5-5"]]);
    expect(modelSwitchText("kimi-k3.1-pro", "claude-opus-5-5")).toBe(
      "Модель Kimi K3.1 Pro недоступна, работаю на Claude Opus 5.5",
    );
    const bodies = server.requests.map((r) => r.body.model);
    expect(bodies.slice(-2)).toEqual(["kimi-k3.1-pro", "claude-opus-5-5"]);
    // Further requests go straight to the replacement.
    await handle.runtime.session.prompt("И ещё");
    expect(server.requests.at(-1)!.body.model).toBe("claude-opus-5-5");
    expect(switches).toHaveLength(1);
  }, 60_000);

  it("a gateway that refuses 128k output gets 64k, then 32k, quietly", async () => {
    const server = new MockGatewayServer({
      apiKey: "sk-w",
      modelIds: ["qwen3.8-max"],
      maxTokensLimit: 32_000,
      turns: [{ text: "Готово." }],
    });
    await server.start();
    cleanups.push(() => server.stop());
    const { handle } = await session(server, "qwen3.8-max");
    await handle.runtime.session.prompt("Привет");
    expect(server.requests.map((r) => r.body.max_tokens)).toEqual([128_000, 64_000, 32_000]);
    const last = [...handle.runtime.session.messages].reverse().find((m) => m.role === "assistant");
    expect(JSON.stringify(last)).toContain("Готово.");
  }, 60_000);

  it("a vendor that answers 402 to a big output reserve (kimi, 26.10): steps down to 16k, and the next request starts there", async () => {
    const server = new MockGatewayServer({
      apiKey: "sk-w",
      modelIds: ["qwen3.8-max"],
      maxTokensLimit: 16_000,
      maxTokensStatus: 402,
      turns: [{ text: "Готово." }, { text: "Ещё готово." }],
    });
    await server.start();
    cleanups.push(() => server.stop());
    const { handle } = await session(server, "qwen3.8-max");
    await handle.runtime.session.prompt("Привет");
    expect(server.requests.map((r) => r.body.max_tokens)).toEqual([
      128_000, 64_000, 32_000, 16_000,
    ]);
    await handle.runtime.session.prompt("Ещё");
    // Без новой лестницы: 16k для этой модели держится PRSLOY_CAP_TTL_MS.
    expect(server.requests.slice(4).map((r) => r.body.max_tokens)).toEqual([16_000]);
    const last = [...handle.runtime.session.messages].reverse().find((m) => m.role === "assistant");
    expect(JSON.stringify(last)).toContain("Ещё готово.");
  }, 60_000);

  it("a real empty balance stays 402 at every step and ends as no_balance", async () => {
    const server = new MockGatewayServer({
      apiKey: "sk-w",
      modelIds: ["qwen3.8-max"],
      maxTokensLimit: 1,
      maxTokensStatus: 402,
      turns: [{ text: "не дойдёт" }],
    });
    await server.start();
    cleanups.push(() => server.stop());
    const { handle } = await session(server, "qwen3.8-max");
    await handle.runtime.session.prompt("Привет");
    expect(server.requests.map((r) => r.body.max_tokens)).toEqual([
      128_000, 64_000, 32_000, 16_000, 8_000,
    ]);
    const last = [...handle.runtime.session.messages]
      .reverse()
      .find((m) => m.role === "assistant") as { stopReason?: string; errorMessage?: string };
    expect(last.stopReason).toBe("error");
    expect(classifyModelError(last.errorMessage, last.stopReason)).toBe("no_balance");
  }, 60_000);
});
