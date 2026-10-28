/**
 * Prices come from the gateway, not from a table we hope is right (#52).
 *
 * `GET {site}/api/pricing` is New API's public price list — it needs no key, so the app never
 * sends one to read prices. The site root is not the API host: the gateway answers on
 * `api.prsloy.online` and the cabinet with the price list lives on `prsloy.online`, so a
 * leading `api.` is dropped when the first address has no `/api/pricing`.
 *
 * The list is read at startup and every hour (with the model list). Until it arrives — and if
 * the gateway is unreachable — the bundled snapshot is used, so a chat never shows dollars or
 * a guess.
 */
import {
  parsePrsloyPricing,
  prsloySnapshotPrices,
  type PrsloyPriceList,
} from "../../shared/prsloy-prices.ts";
import type { FetchLike } from "./gateway-check.ts";
import type { PrsloyContext } from "./context.ts";

/** The site root of a gateway URL: `https://api.prsloy.online/v1` → `https://api.prsloy.online`. */
export function prsloySiteOrigin(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export const PRSLOY_PRICES_TIMEOUT_MS = 8_000;
export const PRSLOY_PRICES_REFRESH_MS = 60 * 60 * 1000;

/** Where to look for the price list, most likely first. */
export function prsloyPricingUrls(baseUrl: string): string[] {
  const origin = prsloySiteOrigin(baseUrl);
  if (!origin) return [];
  const urls = [`${origin}/api/pricing`];
  const url = new URL(origin);
  if (url.hostname.startsWith("api.")) {
    url.hostname = url.hostname.slice("api.".length);
    urls.push(`${url.origin}/api/pricing`);
  }
  return urls;
}

async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      // No Authorization on purpose: the price list is public, the key is not for it.
      headers: { Accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The gateway's live price list, or undefined when no address answered with one. */
export async function fetchPrsloyPrices(options: {
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs?: number;
  now?: Date;
}): Promise<PrsloyPriceList | undefined> {
  const timeoutMs = options.timeoutMs ?? PRSLOY_PRICES_TIMEOUT_MS;
  for (const url of prsloyPricingUrls(options.baseUrl)) {
    const body = await getJson(options.fetch, url, timeoutMs);
    if (body === undefined) continue;
    const parsed = parsePrsloyPricing(body, options.now ? { now: options.now } : {});
    if (parsed.ok) return parsed.list;
  }
  return undefined;
}

export type PrsloyPricesReader = {
  /** Live prices when the gateway answers, otherwise the last known, otherwise the snapshot. */
  read(force?: boolean): Promise<PrsloyPriceList>;
  /** What the app would use right now, without touching the network. */
  last(): PrsloyPriceList;
};
export function createPrsloyPricesReader(options: {
  baseUrl: () => string;
  fetch: FetchLike;
  /** Prices restored from the state file (a previous run) — better than the bundled table. */
  fallback?: () => PrsloyPriceList | undefined;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}): PrsloyPricesReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PRSLOY_PRICES_REFRESH_MS;
  let current: PrsloyPriceList | undefined = options.fallback?.();
  let currentAt = 0;
  let inFlight: Promise<PrsloyPriceList> | undefined;

  const load = async (): Promise<PrsloyPriceList> => {
    const live = await fetchPrsloyPrices({
      baseUrl: options.baseUrl(),
      fetch: options.fetch,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    current = live ?? current ?? prsloySnapshotPrices();
    currentAt = now();
    return current;
  };

  return {
    last: () => current ?? prsloySnapshotPrices(),
    async read(force = false) {
      if (!force && current && now() - currentAt < ttlMs) return current;
      if (inFlight) return inFlight;
      inFlight = load().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

/**
 * Startup + hourly price refresh: the gateway's own list rewrites `models.json`, and the host
 * reloads its catalog, so a price change on the site reaches the ₽ chip without a restart.
 */
export function startPrsloyPricesRefresh(options: {
  ctx: Pick<PrsloyContext, "getState" | "setPrices">;
  fetch: FetchLike;
  onChanged?: () => Promise<void> | void;
  intervalMs?: number;
}): { stop(): void; refresh(force?: boolean): Promise<boolean> } {
  const persisted = options.ctx.getState().prices;
  const reader = createPrsloyPricesReader({
    baseUrl: () => options.ctx.getState().baseUrl,
    fetch: options.fetch,
    ...(persisted
      ? {
          fallback: () => ({
            prices: persisted.list,
            source: "gateway",
            fetchedAt: persisted.fetchedAt,
          }),
        }
      : {}),
  });
  const refresh = async (force = false): Promise<boolean> => {
    try {
      const list = await reader.read(force);
      if (list.source !== "gateway") return false;
      const changed = options.ctx.setPrices({ prices: { ...list.prices }, source: "gateway" });
      if (changed) await options.onChanged?.();
      return changed;
    } catch (error) {
      console.warn("[prsloy] price refresh failed:", error);
      return false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), options.intervalMs ?? PRSLOY_PRICES_REFRESH_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), refresh };
}
