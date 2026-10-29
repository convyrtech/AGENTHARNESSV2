/**
 * How much money is left on the key (#56).
 *
 * The app already shows what a chat costs in rubles; what it did not show was what is left,
 * so a key ran out in the middle of a task (HTTP 402). The gateway answers the two OpenAI-style
 * billing routes with the key the app already uses for chat:
 *
 *   GET {base}/v1/dashboard/billing/subscription → hard_limit_usd  (everything ever granted)
 *   GET {base}/v1/dashboard/billing/usage        → total_usage     (spent, hundredths)
 *
 * Both numbers come out of the same internal quota, so they are in the same rubles as the
 * retail price list (`/api/pricing`) — no exchange rate anywhere in the app. Left = granted
 * minus used. Read at startup and once an hour, next to the price refresh; the last answer is
 * persisted, so an offline start still shows a number (with its age).
 *
 * The key is sent only to the gateway address the user chose, and never logged.
 */
import type { PrsloyBalance } from "@zeno/contracts";
import { prsloyBalanceWarnRub } from "../../shared/prsloy-config.ts";
import { prsloySiteOrigin } from "./prices.ts";
import type { FetchLike } from "./gateway-check.ts";
export const PRSLOY_BALANCE_TIMEOUT_MS = 8_000;
export const PRSLOY_BALANCE_REFRESH_MS = 60 * 60 * 1000;

/** Where to ask for the two billing numbers; both live under the same `/v1` prefix. */
export function prsloyBillingUrls(baseUrl: string): { subscription: string; usage: string } {
  const root = baseUrl.replace(/\/+$/u, "");
  return {
    subscription: `${root}/dashboard/billing/subscription`,
    usage: `${root}/dashboard/billing/usage`,
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The New API route can answer 200 with `{"error": …}`; those fields simply are not there. */
function grantedRub(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const row = body as Record<string, unknown>;
  return num(row.hard_limit_usd) ?? num(row.soft_limit_usd) ?? num(row.system_hard_limit_usd);
}

function usedRub(body: unknown): number | undefined {
  const cents = num(
    body && typeof body === "object" ? (body as Record<string, unknown>).total_usage : undefined,
  );
  return cents === undefined ? undefined : cents / 100;
}

/** The two answers → the money on the key, or undefined when either number is missing. */
export function parsePrsloyBilling(
  subscription: unknown,
  usage: unknown,
  now: Date = new Date(),
): PrsloyBalance | undefined {
  const granted = grantedRub(subscription);
  const spent = usedRub(usage);
  if (granted === undefined || spent === undefined || granted < 0 || spent < 0) return undefined;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    remainingRub: round(Math.max(0, granted - spent)),
    usedRub: round(spent),
    grantedRub: round(granted),
    fetchedAt: now.toISOString(),
  };
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
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

/** The money left on this key, or undefined when the gateway gave no usable answer. */
export async function fetchPrsloyBalance(options: {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs?: number;
  now?: Date;
}): Promise<PrsloyBalance | undefined> {
  if (!prsloySiteOrigin(options.baseUrl)) return undefined;
  const timeoutMs = options.timeoutMs ?? PRSLOY_BALANCE_TIMEOUT_MS;
  const urls = prsloyBillingUrls(options.baseUrl);
  const [subscription, usage] = await Promise.all([
    getJson(options.fetch, urls.subscription, options.apiKey, timeoutMs),
    getJson(options.fetch, urls.usage, options.apiKey, timeoutMs),
  ]);
  return parsePrsloyBilling(subscription, usage, options.now ?? new Date());
}

export type PrsloyBalanceReader = {
  /** What we know now, without touching the network. */
  last(): PrsloyBalance | undefined;
  /** Fresh value when the key is set and the gateway answers, otherwise the last known. */
  read(force?: boolean): Promise<PrsloyBalance | undefined>;
};

export function createPrsloyBalanceReader(options: {
  baseUrl: () => string;
  apiKey: () => string | undefined;
  fetch: FetchLike;
  /** Balance from the state file: better than showing nothing while the gateway is silent. */
  fallback?: () => PrsloyBalance | undefined;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}): PrsloyBalanceReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PRSLOY_BALANCE_REFRESH_MS;
  let current = options.fallback?.();
  // A number read a minute ago (from state.json after a restart) is fresh enough to show;
  // only an older one is re-read at once.
  let currentAt = current ? Date.parse(current.fetchedAt) || 0 : 0;
  let inFlight: Promise<PrsloyBalance | undefined> | undefined;

  const load = async (): Promise<PrsloyBalance | undefined> => {
    const apiKey = options.apiKey();
    if (!apiKey) return current;
    const live = await fetchPrsloyBalance({
      baseUrl: options.baseUrl(),
      apiKey,
      fetch: options.fetch,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    // Silent gateway: keep the last number rather than drop the person to nothing.
    if (live) {
      current = live;
      currentAt = now();
    }
    return current;
  };

  return {
    last: () => current,
    async read(force = false) {
      if (!force && current && now() - currentAt < ttlMs) return current;
      // A forced read belongs to a newly saved key: do not join the old key's request.
      if (inFlight && !force) return inFlight;
      const own = load().finally(() => {
        if (inFlight === own) inFlight = undefined;
      });
      inFlight = own;
      return own;
    },
  };
}

/**
 * Startup + hourly balance refresh. Written into the app state (and `state.json`), so the
 * ₽ chip next to the composer and Settings → «Аккаунт» show the same number.
 *
 * The context is named by what this actually uses, not by the whole `PrsloyContext`: it reads
 * the key, and puts one number back.
 */
export type PrsloyBalanceContext = {
  getState(): { baseUrl: string; balance?: PrsloyBalance };
  setBalance(balance: PrsloyBalance | undefined): void;
  keyStore: { read(): string | undefined };
};

export function startPrsloyBalanceRefresh(options: {
  ctx: PrsloyBalanceContext;
  fetch: FetchLike;
  onRefreshed?: (balance: PrsloyBalance) => Promise<void> | void;
  intervalMs?: number;
}): {
  stop(): void;
  refresh(force?: boolean): Promise<boolean>;
  /** Invalidate every request in flight before a key is changed or removed. */
  invalidate(): void;
} {
  const persisted = options.ctx.getState().balance;
  let request = 0;
  let reader = makeReader();
  function makeReader(): PrsloyBalanceReader {
    return createPrsloyBalanceReader({
      baseUrl: () => options.ctx.getState().baseUrl,
      apiKey: () => options.ctx.keyStore.read(),
      fetch: options.fetch,
      ...(persisted ? { fallback: () => persisted } : {}),
    });
  }
  const refresh = async (force = false): Promise<boolean> => {
    const own = ++request;
    try {
      // True only when the gateway gave a number we did not already have. A silent one keeps
      // the old figure on screen (the reader holds it) — honest, the chip says how old it is.
      const before = reader.last()?.fetchedAt;
      const balance = await reader.read(force);
      if (!balance || balance.fetchedAt === before || own !== request) return false;
      options.ctx.setBalance(balance);
      await options.onRefreshed?.(balance);
      return true;
    } catch (error) {
      console.warn("[prsloy] balance refresh failed:", error);
      return false;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), options.intervalMs ?? PRSLOY_BALANCE_REFRESH_MS);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    refresh,
    invalidate() {
      // An old reader may still resolve, but its refresh sequence no longer matches and its
      // cached answer is unreachable. A subsequent read starts with the current key only.
      request += 1;
      reader = makeReader();
    },
  };
}

/** True when what is left is small enough to warn about before starting another task. */
export function prsloyBalanceIsLow(
  balance: PrsloyBalance | undefined,
  warnRub = prsloyBalanceWarnRub(),
): boolean {
  if (!balance || warnRub <= 0) return false;
  return balance.remainingRub < warnRub;
}
