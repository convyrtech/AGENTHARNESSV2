import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { fetchPrsloyPrices, prsloyPricingUrls, startPrsloyPricesRefresh } from "./prices.ts";
import { bootstrapPrsloy } from "./context.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const PRICING = {
  auto_groups: ["default"],
  group_ratio: { default: 1 },
  data: [
    {
      model_name: "kimi-k3.1-pro",
      quota_type: 0,
      model_ratio: 13,
      completion_ratio: 5,
      cache_ratio: 0.25,
      billing_expr: 'tier("guard", min(p * 26.0 + cr * 6.5 + cc * 32.5 + c * 130.0, 100000000.0))',
    },
  ],
};

function stubFetch(reply: (url: string) => { status?: number; body?: unknown }) {
  const calls: string[] = [];
  const fetch = async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const out = reply(url);
    const body = typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? {});
    return new Response(body, { status: out.status ?? 200, headers: {} }) as Response;
    // init unused beyond caching discipline
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

describe("prsloyPricingUrls", () => {
  it("asks the API host first, then the site without api.", () => {
    expect(prsloyPricingUrls("https://api.prsloy.online/v1")).toEqual([
      "https://api.prsloy.online/api/pricing",
      "https://prsloy.online/api/pricing",
    ]);
    expect(prsloyPricingUrls("http://127.0.0.1:3000/v1")).toEqual([
      "http://127.0.0.1:3000/api/pricing",
    ]);
    expect(prsloyPricingUrls("nope")).toEqual([]);
  });
});

describe("fetchPrsloyPrices", () => {
  it("takes the price list from the site host when the API host has none", async () => {
    const { fetch } = stubFetch((url) =>
      url === "https://api.gw.example/api/pricing"
        ? { status: 404, body: "<html>404</html>" }
        : { body: PRICING },
    );
    const list = await fetchPrsloyPrices({ baseUrl: "https://api.gw.example/v1", fetch });
    expect(list?.source).toBe("gateway");
    expect(list?.prices["kimi-k3.1-pro"]?.input).toBe(26);
  });

  it("undefined when nothing answers with prices — the caller falls back", async () => {
    const { fetch } = stubFetch(() => ({ status: 404, body: "<html>404</html>" }));
    expect(
      await fetchPrsloyPrices({ baseUrl: "https://api.gw.example/v1", fetch }),
    ).toBeUndefined();
    // HTML with a 200 is not a price list either.
    const html = stubFetch(() => ({ status: 200, body: "<html>welcome</html>" }));
    expect(
      await fetchPrsloyPrices({ baseUrl: "https://gw.example/v1", fetch: html.fetch }),
    ).toBeUndefined();
  });
});

describe("startPrsloyPricesRefresh", () => {
  function makeCtx() {
    const userData = mkdtempSync(join(tmpdir(), "prsloy-prices-ud-"));
    cleanups.push(() => rmSync(userData, { recursive: true, force: true }));
    const ctx = bootstrapPrsloy({
      userDataPath: userData,
      cipher: {
        isEncryptionAvailable: () => true,
        encryptString: (t) => Buffer.from(t),
        decryptString: (b) => b.toString(),
      },
      env: {},
      platform: "linux",
    });
    return ctx;
  }

  it("the gateway's price rewrites models.json and persists to state", async () => {
    const ctx = makeCtx();
    const { fetch } = stubFetch(() => ({ body: PRICING }));
    let changed = 0;
    const refresh = startPrsloyPricesRefresh({
      ctx,
      fetch,
      onChanged: () => {
        changed += 1;
      },
    });
    cleanups.push(() => refresh.stop());
    await refresh.refresh(true);
    const models = JSON.parse(readFileSync(join(ctx.agentDir, "models.json"), "utf8")) as {
      providers: { prsloy: { models: { id: string; cost: { input: number } }[] } };
    };
    const kimi = models.providers.prsloy.models.find((m) => m.id === "kimi-k3.1-pro");
    expect(kimi?.cost.input).toBe(26);
    expect(ctx.getState().prices?.source).toBe("gateway");
    expect(changed).toBe(1);
    // Same prices again: no rewrite, no reload.
    await refresh.refresh(true);
    expect(changed).toBe(1);
  });

  it("keeps working offline: models.json gets the bundled snapshot", async () => {
    const ctx = makeCtx();
    const { fetch } = stubFetch(() => ({ status: 503, body: "down" }));
    const refresh = startPrsloyPricesRefresh({ ctx, fetch });
    cleanups.push(() => refresh.stop());
    await refresh.refresh(true);
    const models = JSON.parse(readFileSync(join(ctx.agentDir, "models.json"), "utf8")) as {
      providers: { prsloy: { models: { id: string; cost: { input: number } }[] } };
    };
    const kimi = models.providers.prsloy.models.find((m) => m.id === "kimi-k3.1-pro");
    expect(kimi?.cost.input).toBe(26);
    // The snapshot is not claimed to be the gateway's word.
    expect(ctx.getState().prices).toBeUndefined();
  });
});
