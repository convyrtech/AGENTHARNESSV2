/**
 * The money left on the key (#56): parsed from the gateway's billing routes, shown before a task.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { PrsloyBalance } from "@zeno/contracts";
import type { PrsloyBalanceContext } from "./balance.ts";
import {
  fetchPrsloyBalance,
  parsePrsloyBilling,
  prsloyBalanceIsLow,
  prsloyBillingUrls,
  startPrsloyBalanceRefresh,
} from "./balance.ts";

const BASE = "https://api.prsloy.online/v1";

function fakeFetch(body: Record<string, unknown>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | { url: string }, init?: RequestInit) => {
    const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(body);
      },
    };
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

describe("prsloyBillingUrls", () => {
  it("puts both routes under the same /v1 prefix as the chat", () => {
    expect(prsloyBillingUrls(BASE)).toEqual({
      subscription: `${BASE}/dashboard/billing/subscription`,
      usage: `${BASE}/dashboard/billing/usage`,
    });
    expect(prsloyBillingUrls(`${BASE}/`).subscription).toBe(
      `${BASE}/dashboard/billing/subscription`,
    );
  });
});

describe("parsePrsloyBilling", () => {
  it("subtracts what the key spent from what it was granted, in rubles", () => {
    const balance = parsePrsloyBilling(
      { hard_limit_usd: 4000, user_id: "7" },
      { total_usage: 224057 },
      new Date("2026-10-29T10:00:00.000Z"),
    );
    expect(balance).toEqual({
      remainingRub: 1759.43,
      usedRub: 2240.57,
      grantedRub: 4000,
      fetchedAt: "2026-10-29T10:00:00.000Z",
    });
  });

  it("never says the key owes money", () => {
    const balance = parsePrsloyBilling({ hard_limit_usd: 10 }, { total_usage: 1500 });
    expect(balance?.remainingRub).toBe(0);
    expect(balance?.usedRub).toBe(15);
  });

  it("is nothing without both numbers, or with a gateway error in a 200 body", () => {
    expect(parsePrsloyBilling({ error: { message: "no" } }, { total_usage: 100 })).toBeUndefined();
    expect(parsePrsloyBilling({ hard_limit_usd: 10 }, { error: "x" })).toBeUndefined();
    expect(parsePrsloyBilling({}, {})).toBeUndefined();
    expect(parsePrsloyBilling(null, null)).toBeUndefined();
    expect(parsePrsloyBilling({ hard_limit_usd: "10" }, { total_usage: 100 })).toBeUndefined();
    expect(parsePrsloyBilling({ hard_limit_usd: -1 }, { total_usage: 0 })).toBeUndefined();
  });

  it("accepts the older New API field names", () => {
    expect(
      parsePrsloyBilling({ system_hard_limit_usd: 300 }, { total_usage: 0 })?.remainingRub,
    ).toBe(300);
  });
});

describe("fetchPrsloyBalance", () => {
  it("asks both routes with the key it already uses for chat", async () => {
    const { fetchImpl, calls } = fakeFetch({ hard_limit_usd: 4000, total_usage: 224057 });
    const balance = await fetchPrsloyBalance({
      baseUrl: BASE,
      apiKey: "sk-test",
      fetch: fetchImpl,
    });
    expect(balance?.remainingRub).toBe(1759.43);
    expect(calls.map((c) => c.url).sort()).toEqual([
      `${BASE}/dashboard/billing/subscription`,
      `${BASE}/dashboard/billing/usage`,
    ]);
    expect(calls[0]?.headers.Authorization).toBe("Bearer sk-test");
  });

  it("gives up quietly when the gateway is not the real one or is silent", async () => {
    expect(
      await fetchPrsloyBalance({
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "sk",
        fetch: fakeFetch({}).fetchImpl,
      }),
    ).toBeUndefined();
    const broken = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await fetchPrsloyBalance({
        baseUrl: BASE,
        apiKey: "sk",
        fetch: broken as unknown as typeof globalThis.fetch,
      }),
    ).toBeUndefined();
  });
});

describe("prsloyBalanceIsLow", () => {
  it("warns below the line and stays quiet above it", () => {
    const at = (remainingRub: number) => ({
      remainingRub,
      usedRub: 0,
      grantedRub: 1000,
      fetchedAt: "2026-10-29T10:00:00.000Z",
    });
    expect(prsloyBalanceIsLow(at(50), 200)).toBe(true);
    expect(prsloyBalanceIsLow(at(200), 200)).toBe(false);
    expect(prsloyBalanceIsLow(at(200), 0)).toBe(false);
    expect(prsloyBalanceIsLow(undefined, 200)).toBe(false);
  });
});

describe("startPrsloyBalanceRefresh", () => {
  function fakeCtx(persisted?: PrsloyBalance) {
    const setBalance = vi.fn();
    const ctx: PrsloyBalanceContext = {
      getState: () => ({ baseUrl: BASE, ...(persisted ? { balance: persisted } : {}) }),
      setBalance,
      keyStore: { read: () => "sk-test" },
    };
    return { ctx, setBalance };
  }

  it("stores the answer and keeps the old number when the gateway goes silent", async () => {
    const { ctx, setBalance } = fakeCtx();
    let served = true;
    const fetchImpl = vi.fn(async () => ({
      ok: served,
      status: served ? 200 : 402,
      async text() {
        return served
          ? JSON.stringify({ hard_limit_usd: 4000, total_usage: 224057 })
          : '{"error":{}}';
      },
    })) as unknown as typeof globalThis.fetch;

    const worker = startPrsloyBalanceRefresh({ ctx, fetch: fetchImpl, intervalMs: 60_000 });
    await vi.waitFor(() => expect(setBalance).toHaveBeenCalledTimes(1));
    expect(setBalance.mock.calls[0]?.[0]).toMatchObject({ remainingRub: 1759.43 });

    served = false;
    expect(await worker.refresh(true)).toBe(false);
    expect(setBalance).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it("never writes an answer from a request superseded while it was in flight", async () => {
    const { ctx, setBalance } = fakeCtx();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      await gate;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ hard_limit_usd: 4000, total_usage: 100 });
        },
      };
    }) as unknown as typeof globalThis.fetch;
    const worker = startPrsloyBalanceRefresh({ ctx, fetch: fetchImpl, intervalMs: 60_000 });
    await vi.waitFor(() => expect(calls).toBe(2));
    // This is what saving a key does: the old request is still pending, a new one begins.
    const newer = worker.refresh(true);
    await vi.waitFor(() => expect(calls).toBe(4));
    release?.();
    expect(await newer).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(setBalance).toHaveBeenCalledTimes(1);
    expect(setBalance).toHaveBeenCalledWith(expect.objectContaining({ remainingRub: 3999 }));
    worker.stop();
  });

  it("drops an in-flight answer when the key is invalidated", async () => {
    const { ctx, setBalance } = fakeCtx();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl } = fakeFetch({ hard_limit_usd: 4000, total_usage: 100 });
    const gated = vi.fn(async (...args: Parameters<typeof fetchImpl>) => {
      await gate;
      return fetchImpl(...args);
    }) as unknown as typeof globalThis.fetch;
    const worker = startPrsloyBalanceRefresh({ ctx, fetch: gated, intervalMs: 60_000 });
    await Promise.resolve();
    worker.invalidate();
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(setBalance).not.toHaveBeenCalled();
    // The next read has no stale cached value and can use the newly saved key.
    expect(await worker.refresh(true)).toBe(true);
    expect(setBalance).toHaveBeenCalledTimes(1);
    worker.stop();
  });

  it("reads nothing without a key, and does not re-read a number that is still fresh", async () => {
    const { ctx: noKeyCtx } = fakeCtx();
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
    const noKey = startPrsloyBalanceRefresh({
      ctx: { ...noKeyCtx, keyStore: { read: () => undefined } },
      fetch: fetchImpl,
      intervalMs: 60_000,
    });

    expect(await noKey.refresh(true)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    noKey.stop();

    // Restart: state.json holds a number read a minute ago, so nothing goes to the network.
    const { ctx: fresh, setBalance: freshSet } = fakeCtx({
      remainingRub: 12,
      usedRub: 3988,
      grantedRub: 4000,
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const { fetchImpl: okFetch, calls } = fakeFetch({ hard_limit_usd: 4000, total_usage: 100 });
    const quiet = startPrsloyBalanceRefresh({ ctx: fresh, fetch: okFetch, intervalMs: 60_000 });
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(freshSet).not.toHaveBeenCalled();
    // The person asking for it now (a new key) does get a real answer.
    expect(await quiet.refresh(true)).toBe(true);
    expect(freshSet.mock.calls[0]?.[0]).toMatchObject({ remainingRub: 3999 });
    quiet.stop();

    // An hour-old number is not trusted: it is re-read at once.
    const { ctx: staleCtx, setBalance: staleSet } = fakeCtx({
      remainingRub: 12,
      usedRub: 3988,
      grantedRub: 4000,
      fetchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const { fetchImpl: staleFetch } = fakeFetch({ hard_limit_usd: 4000, total_usage: 200 });
    const worker = startPrsloyBalanceRefresh({
      ctx: staleCtx,
      fetch: staleFetch,
      intervalMs: 60_000,
    });
    await vi.waitFor(() => expect(staleSet).toHaveBeenCalled());
    expect(staleSet.mock.calls[0]?.[0]).toMatchObject({ remainingRub: 3998 });
    worker.stop();
  });
});
