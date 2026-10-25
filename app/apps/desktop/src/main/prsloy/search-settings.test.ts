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
  it("off by default; a provider is usable only with what it needs", () => {
    const { s } = settings();
    const st = s.state(false);
    expect(st.active).toBeNull();
    const byId = Object.fromEntries(st.providers.map((p) => [p.id, p.configured]));
    expect(byId).toMatchObject({
      prsloy: false,
      brave: false,
      yandex: false,
      searxng: false,
      model: true,
    });
    expect(st.providers.map((p) => p.id)).not.toContain("tavily");
    s.setKey("yandex", "AQVN-yandex-key");
    expect(s.state(false).providers.find((p) => p.id === "yandex")!.configured).toBe(false);
    s.setKey("yandex", "", { folderId: "b1g-folder" });
    expect(s.state(true).providers.find((p) => p.id === "yandex")).toMatchObject({
      configured: true,
      keyMask: "AQV…-key",
      fields: { folderId: "b1g-folder" },
    });
    expect(s.state(true).providers.find((p) => p.id === "prsloy")!.configured).toBe(true);
  });

  it("keys are encrypted at rest and never in search.json", () => {
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
    });
    s.clearKey("brave");
    expect(existsSync(join(dir, "search-key-brave.bin"))).toBe(false);
    expect(s.state(false).active).toBeNull();
  });

  it("handoff: the active provider's config, nothing when off, without a key, or the model's own search", () => {
    const { s } = settings();
    expect(s.handoff("https://gw/v1")).toBeUndefined();
    s.setActive("exa");
    expect(s.handoff("https://gw/v1")).toBeUndefined();
    s.setKey("exa", "exa-key");
    expect(JSON.parse(s.handoff("https://gw/v1")!)).toEqual({
      search: { provider: "exa", key: "exa-key" },
      gatewayUrl: "https://gw/v1",
    });
    s.setActive("prsloy");
    expect(JSON.parse(s.handoff("https://gw/v1")!)).toEqual({
      search: { provider: "prsloy", url: "https://gw/v1" },
      gatewayUrl: "https://gw/v1",
    });
    s.setActive("model");
    expect(s.handoff("https://gw/v1")).toBeUndefined();
    expect(() => s.setKey("prsloy", "x")).toThrow("ключ не нужен");
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
    expect(handoff.search).toEqual({
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
    expect(await call(SEARCH_IPC.check, "model")).toMatchObject({ ok: false, code: "no_channel" });
  });
});
