import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { takePrsloyHandoff } from "../../agent-host/prsloy-handoff.ts";
import { sanitizedEnv } from "@prsloy/harness";
import { buildPrsloyHostEnv, SEARCH_HANDOFF_ENV } from "./agent-env.ts";
import type { SecretCipher } from "./key-store.ts";
import { registerPrsloySearchIpc, SEARCH_IPC } from "./search-ipc.ts";
import { SearchSettings } from "./search-settings.ts";

function fakeCipher(): SecretCipher {
  const xor = (buf: Buffer) => Buffer.from(buf.map((b) => b ^ 0x5a));
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => xor(Buffer.from(`enc:${text}`, "utf8")),
    decryptString: (buf) => xor(buf).toString("utf8").slice(4),
  };
}

const settings = () => {
  const dir = mkdtempSync(join(tmpdir(), "search-"));
  return { dir, s: new SearchSettings(dir, fakeCipher()) };
};

describe("search settings", () => {
  it("free by default; a provider is usable only with what it needs; screen order", () => {
    const { s } = settings();
    const st = s.state(false);
    expect(st.active).toBe("free");
    expect(st.providers.map((p) => p.id)).toEqual([
      "free",
      "deepseek",
      "yandex",
      "searxng",
      "brave",
      "exa",
      "firecrawl",
      "jina",
      "github",
      "prsloy",
      "model",
    ]);
    const byId = Object.fromEntries(st.providers.map((p) => [p.id, p.configured]));
    expect(byId).toMatchObject({
      free: true,
      prsloy: false,
      brave: false,
      yandex: false,
      searxng: false,
      model: false,
    });
    s.setKey("yandex", "AQVN-yandex-key");
    expect(s.state(false).providers.find((p) => p.id === "yandex")!.configured).toBe(false);
    s.setKey("yandex", "AQVN-yandex-key", { folderId: "b1g-folder" });
    expect(s.state(true).providers.find((p) => p.id === "yandex")).toMatchObject({
      configured: true,
      keyMask: "AQV…-key",
      fields: { folderId: "b1g-folder" },
    });
    expect(s.state(true).providers.find((p) => p.id === "prsloy")!.configured).toBe(true);
    expect(s.state(true).providers.find((p) => p.id === "model")!.configured).toBe(true);
  });

  it("a blank key is an error; SearXNG needs an address, not a key; free, prsloy, model take none", () => {
    const { s } = settings();
    expect(() => s.setKey("brave", "")).toThrow("Ключ пустой");
    expect(() => s.setKey("brave", "   ")).toThrow("Ключ пустой");
    expect(() => s.setKey("searxng", "")).toThrow("адрес");
    s.setKey("searxng", "", { url: "https://sx.example" });
    expect(s.state(false).providers.find((p) => p.id === "searxng")!.configured).toBe(true);
    for (const id of ["free", "prsloy", "model"] as const)
      expect(() => s.setKey(id, "x")).toThrow("ключ не нужен");
  });

  it("keys are encrypted at rest and never in search.json; removing the active key falls back to free", () => {
    const { dir, s } = settings();
    s.setKey("brave", "BSA-very-secret-1234");
    s.setKey("searxng", "", { url: "https://sx.example" });
    s.setActive("brave");
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name)).toString("utf8"), name).not.toContain(
        "BSA-very-secret-1234",
      );
    }
    expect(JSON.parse(readFileSync(join(dir, "search.json"), "utf8"))).toEqual({
      active: "brave",
      fields: { brave: {}, searxng: { url: "https://sx.example" } },
      checks: {},
    });
    s.clearKey("brave");
    expect(existsSync(join(dir, "search-key-brave.bin"))).toBe(false);
    expect(s.state(false).active).toBe("free");
  });

  it("the last «Проверить» is kept per provider until its key changes", () => {
    const { s } = settings();
    s.setKey("brave", "BSA-1");
    s.recordCheck(
      "brave",
      { ok: false, code: "limit", error: "лимит" },
      new Date("2026-10-25T10:00:00Z"),
    );
    expect(s.state(false).providers.find((p) => p.id === "brave")!.lastCheck).toEqual({
      at: "2026-10-25T10:00:00.000Z",
      ok: false,
      code: "limit",
    });
    s.recordCheck("free", { ok: true, latencyMs: 5, dated: true, firstUrl: "https://x" });
    expect(s.state(false).providers.find((p) => p.id === "free")!.lastCheck).toMatchObject({
      ok: true,
    });
    s.setKey("brave", "BSA-2");
    expect(s.state(false).providers.find((p) => p.id === "brave")!.lastCheck).toBeUndefined();
  });

  it("handoff: always set — the active provider's config, or free when it is not set up", () => {
    const { s } = settings();
    const gw = "https://gw/v1";
    expect(JSON.parse(s.handoff(gw))).toEqual({
      search: { provider: "free" },
      gatewayUrl: gw,
      modelSearch: ["gpt-6.1-sol"],
    });
    s.setActive("exa");
    expect(JSON.parse(s.handoff(gw)).search).toEqual({ provider: "free" });
    s.setKey("exa", "exa-key");
    expect(JSON.parse(s.handoff(gw))).toMatchObject({
      search: { provider: "exa", key: "exa-key" },
      gatewayUrl: gw,
    });
    s.setActive("prsloy");
    expect(JSON.parse(s.handoff(gw)).search).toEqual({ provider: "prsloy", url: gw });
    s.setActive("model");
    expect(JSON.parse(s.handoff(gw)).search).toEqual({
      provider: "model",
      url: gw,
      models: ["gpt-6.1-sol"],
    });
    s.setActive(null);
    expect(JSON.parse(s.handoff(gw)).search).toEqual({ provider: "free" });
  });

  it("GitHub token (optional): kept like a key, handed to the host for the free search too", () => {
    const { dir, s } = settings();
    s.setKey("github", "ghp_secret_token_1234");
    for (const name of readdirSync(dir))
      expect(readFileSync(join(dir, name)).toString("utf8")).not.toContain("ghp_secret_token_1234");
    expect(s.state(false).providers.find((p) => p.id === "github")).toMatchObject({
      configured: true,
      keyMask: expect.stringContaining("…"),
    });
    // free stays active: the token goes along anyway
    expect(JSON.parse(s.handoff(undefined))).toMatchObject({
      search: { provider: "free" },
      githubToken: "ghp_secret_token_1234",
    });
    s.setActive("github");
    expect(JSON.parse(s.handoff(undefined)).search).toEqual({
      provider: "github",
      key: "ghp_secret_token_1234",
    });
    s.clearKey("github");
    expect(JSON.parse(s.handoff(undefined)).githubToken).toBeUndefined();
  });

  it("the model's search: a list of models from the gateway's catalog, in order", () => {
    const { s } = settings();
    expect(s.state(true).providers.find((p) => p.id === "model")!.fields).toEqual({
      models: ["gpt-6.1-sol"],
    });
    s.setModels(["gpt-5.4", " grok-4.20-multi-agent-0309 ", "gpt-5.4"]);
    expect(JSON.parse(s.handoff("https://gw/v1")).modelSearch).toEqual([
      "gpt-5.4",
      "grok-4.20-multi-agent-0309",
    ]);
    expect(() => s.setModels([])).toThrow("хотя бы одна");
    expect(() => s.setModels(["bad model; rm -rf"])).toThrow("Неверный");
  });
});

describe("0 keys in the agent's env (issue #23)", () => {
  it("main → host env → host takes the handoff → the agent's env has no search key", () => {
    const { s } = settings();
    s.setKey("brave", "BSA-brave-secret-9999");
    s.setActive("brave");
    const hostEnv = buildPrsloyHostEnv(
      { PATH: "/usr/bin", BRAVE_API_KEY: "user-own", [SEARCH_HANDOFF_ENV]: "stale" },
      {
        agentDir: "/a",
        sessionDir: "/s",
        shimsDir: "/sh",
        gatewayKey: "sk-gw",
        searchHandoff: s.handoff("https://gw/v1"),
        platform: "linux",
      },
    );
    expect(hostEnv.BRAVE_API_KEY).toBeUndefined();
    const env: NodeJS.ProcessEnv = { ...hostEnv };
    const handoff = takePrsloyHandoff(env);
    expect(handoff.search).toMatchObject({
      search: { provider: "brave", key: "BSA-brave-secret-9999" },
      gatewayUrl: "https://gw/v1",
    });
    // what bash and background processes of the agent inherit
    const agentEnv = JSON.stringify([env, sanitizedEnv(env)]);
    expect(agentEnv).not.toContain("BSA-brave-secret-9999");
    expect(agentEnv).not.toContain("sk-gw");
    expect(agentEnv).not.toContain(SEARCH_HANDOFF_ENV);
  });

  it("a stale handoff in the user's own env is dropped when search is off", () => {
    const env = buildPrsloyHostEnv(
      { PATH: "/usr/bin", [SEARCH_HANDOFF_ENV]: '{"search":{"provider":"brave","key":"x"}}' },
      { agentDir: "/a", sessionDir: "/s", shimsDir: "/sh", platform: "linux" },
    );
    expect(env[SEARCH_HANDOFF_ENV]).toBeUndefined();
  });
});

describe("search IPC", () => {
  function ipc(busy = false) {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const { s } = settings();
    const restarts: number[] = [];
    const calls: { url: string; init?: RequestInit }[] = [];
    registerPrsloySearchIpc(
      { handle: (ch, fn) => handlers.set(ch, fn) },
      {
        settings: s,
        gatewayKey: () => "sk-gw",
        gatewayUrl: () => "https://gw.example/v1",
        isAgentBusy: () => busy,
        restartHost: async () => void restarts.push(1),
        fetch: (async (url: string, init?: RequestInit) => {
          calls.push({ url, ...(init ? { init } : {}) });
          return new Response(
            JSON.stringify({
              results: [
                {
                  url: "https://ru.wikipedia.org/wiki/Пушкин",
                  title: "Пушкин",
                  date: "2026-01-01",
                },
              ],
            }),
          );
        }) as typeof fetch,
      },
    );
    const call = (ch: string, ...a: unknown[]) => Promise.resolve(handlers.get(ch)!({}, ...a));
    return { call, restarts, calls };
  }

  it("validates input: known providers only, http(s) addresses, string keys", async () => {
    const { call } = ipc();
    await expect(call(SEARCH_IPC.setKey, "tavily", "k")).rejects.toThrow("Неизвестный поиск");
    await expect(call(SEARCH_IPC.setKey, "searxng", "", { url: "file:///etc" })).rejects.toThrow(
      "http",
    );
    await expect(call(SEARCH_IPC.setKey, "brave", 42)).rejects.toThrow("Неверный ключ");
    await expect(call(SEARCH_IPC.setActive, "nope")).rejects.toThrow("Неизвестный поиск");
    await expect(call(SEARCH_IPC.setModels, "gpt-5.4")).rejects.toThrow("Неверный список");
    await expect(call(SEARCH_IPC.setModels, [1])).rejects.toThrow("Неверный список");
    await expect(call(SEARCH_IPC.setModels, ["gpt-5.4"])).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ id: "model", fields: { models: ["gpt-5.4"] } }),
      ]),
    });
  });

  it("a change restarts an idle host, not a busy one; the state never carries a key", async () => {
    const idle = ipc();
    const st = (await idle.call(SEARCH_IPC.setKey, "brave", "BSA-secret-0000")) as {
      providers: unknown[];
    };
    expect(JSON.stringify(st)).not.toContain("BSA-secret-0000");
    await idle.call(SEARCH_IPC.setActive, "brave");
    expect(idle.restarts).toHaveLength(2);
    const busy = ipc(true);
    await busy.call(SEARCH_IPC.setActive, "prsloy");
    expect(busy.restarts).toHaveLength(0);
  });

  it("«Проверить»: the gateway with the PRSLOY key from main; no key — a plain answer", async () => {
    const { call, calls } = ipc();
    expect(await call(SEARCH_IPC.check, "prsloy")).toMatchObject({
      ok: true,
      dated: true,
      firstUrl: "https://ru.wikipedia.org/wiki/Пушкин",
    });
    expect(calls[0]!.url).toBe("https://gw.example/v1/tools/search");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-gw");
    expect(await call(SEARCH_IPC.check, "exa")).toEqual({
      ok: false,
      code: "no_key",
      error: "Сначала введите ключ",
    });
    // the model's search: the gateway's chat completions with web_search_options, the PRSLOY key
    expect(await call(SEARCH_IPC.check, "model")).toMatchObject({ ok: false, code: "format" });
    expect(calls.at(-1)!.url).toBe("https://gw.example/v1/chat/completions");
    expect(JSON.parse(calls.at(-1)!.init!.body as string)).toMatchObject({
      model: "gpt-6.1-sol",
      web_search_options: {},
    });
    const st = (await call(SEARCH_IPC.getState)) as {
      providers: { id: string; lastCheck?: unknown }[];
    };
    expect(st.providers.find((p) => p.id === "prsloy")!.lastCheck).toMatchObject({ ok: true });
    expect(st.providers.find((p) => p.id === "exa")!.lastCheck).toMatchObject({
      ok: false,
      code: "no_key",
    });
  });
});
