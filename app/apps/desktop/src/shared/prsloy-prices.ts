/**
 * What the user actually pays: the PRSLOY gateway's retail prices in rubles per 1M tokens.
 *
 * Two sources, one shape (#52):
 * - live — `GET {site}/api/pricing` (New API, public, no key), read at startup and every hour
 *   by `main/prsloy/prices.ts`; this is the price the gateway bills by;
 * - snapshot — `prsloy-prices-table.ts`, used when the live list is unreachable.
 *
 * The app used to hold *vendor cost* in dollars (`PRSLOY_PRICES_USD_PER_M`) and multiply it by
 * a made-up dollar rate, so a chat that really cost 52 ₽ showed 4,28 ₽ (DIARY, 26.10). No more
 * conversion: the numbers below are rubles, and they are the ones the gateway charges.
 */
import { PRSLOY_PRICE_TABLE_SNAPSHOT } from "./prsloy-prices-table.ts";

/** Rubles per 1M tokens, by token kind. `cacheWrite` is what a fresh cache write costs. */
export type RubPricePerM = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export type PrsloyPriceList = {
  /** Model id → rubles per 1M tokens. Models the gateway bills per call are absent. */
  prices: Readonly<Record<string, RubPricePerM>>;
  /** `gateway` — read from `/api/pricing` now; `snapshot` — the bundled table. */
  source: "gateway" | "snapshot";
  /** ISO time the gateway answered (`gateway` only). */
  fetchedAt?: string;
};

export type PrsloyPriceParseFailure = {
  ok: false;
  /** `not_json` — the body is not the pricing document; `no_prices` — it is, but has no per-token price. */
  reason: "not_json" | "no_prices";
};

export type PrsloyPriceParseResult = { ok: true; list: PrsloyPriceList } | PrsloyPriceParseFailure;

/**
 * New API's `quota_per_unit` (from `GET /api/status`; 500 000 on the owner's gateway): how many
 * quota units make one unit of the site's currency. The price of 1M tokens is therefore
 * `1e6 × model_ratio × group_ratio / quota_per_unit`.
 */
export const PRSLOY_QUOTA_PER_UNIT = 500_000;

/** The group a plain key belongs to; `group_ratio` for it is usually 1. */
export const PRSLOY_PRICE_GROUP = "default";

/** The bundled snapshot as a price list (first launch, offline gateway). */
export function prsloySnapshotPrices(): PrsloyPriceList {
  return { prices: PRSLOY_PRICE_TABLE_SNAPSHOT, source: "snapshot" };
}

/** Rubles per 1M tokens for a model, or undefined — no price known, so no money is shown. */
export function prsloyPriceFor(
  modelId: string,
  prices: Readonly<Record<string, RubPricePerM>> = PRSLOY_PRICE_TABLE_SNAPSHOT,
): RubPricePerM | undefined {
  const price = prices[modelId];
  if (!price) return undefined;
  return Number.isFinite(price.input) && price.input > 0 ? price : undefined;
}

/** pi's `cost` block for `models.json`: the same four numbers, rubles per 1M. */
export function prsloyModelCostRub(
  modelId: string,
  prices?: Readonly<Record<string, RubPricePerM>>,
): RubPricePerM {
  const price = prsloyPriceFor(modelId, prices);
  // No price known: pi counts the model as free and the UI hides the ruble cost, rather than
  // showing a number nobody can check.
  if (!price) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return {
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead,
    cacheWrite: price.cacheWrite,
  };
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** `p * 26.0 + cr * 6.5 + …` → the coefficient of one token kind (rubles per 1M). */
function expressionPrice(expression: unknown, token: string): number | undefined {
  if (typeof expression !== "string") return undefined;
  const hit = new RegExp(`(?:^|[^a-z0-9_])${token} \\* ([0-9.]+)`, "u").exec(expression);
  return hit ? positive(Number(hit[1])) : undefined;
}

/**
 * Read `GET /api/pricing`. New API gives two routes to the same price and they agree to the
 * last digit on every model we checked (2026-10-27): `model_ratio` × `group_ratio`, and the
 * coefficients of `billing_expr` (`p`, `cr`, `cc`, `c`). The expression is what the gateway
 * actually bills by, so it wins when both are there; a row with neither is skipped.
 */
export function parsePrsloyPricing(
  body: unknown,
  options: { quotaPerUnit?: number; group?: string; now?: Date } = {},
): PrsloyPriceParseResult {
  if (!body || typeof body !== "object") return { ok: false, reason: "not_json" };
  const root = body as { data?: unknown; group_ratio?: unknown };
  if (!Array.isArray(root.data)) return { ok: false, reason: "not_json" };
  const quotaPerUnit = positive(options.quotaPerUnit) ?? PRSLOY_QUOTA_PER_UNIT;
  const group = options.group ?? PRSLOY_PRICE_GROUP;
  const ratios =
    root.group_ratio && typeof root.group_ratio === "object"
      ? (root.group_ratio as Record<string, unknown>)
      : {};
  const groupRatio = positive(ratios[group]) ?? 1;
  const prices: Record<string, RubPricePerM> = {};
  for (const row of root.data) {
    if (!row || typeof row !== "object") continue;
    const model = row as Record<string, unknown>;
    const id = typeof model.model_name === "string" ? model.model_name.trim() : "";
    // `quota_type: 1` — a per-call price (image models): not rubles per 1M tokens.
    if (!id || model.quota_type === 1) continue;
    const fromRatio =
      typeof model.model_ratio === "number" && Number.isFinite(model.model_ratio)
        ? (1e6 * model.model_ratio * groupRatio) / quotaPerUnit
        : undefined;
    const input = expressionPrice(model.billing_expr, "p") ?? positive(fromRatio);
    if (!input) continue;
    const cacheRead =
      expressionPrice(model.billing_expr, "cr") ??
      (typeof model.cache_ratio === "number" ? input * model.cache_ratio : input);
    const output =
      expressionPrice(model.billing_expr, "c") ??
      (typeof model.completion_ratio === "number" ? input * model.completion_ratio : input);
    const cacheWrite = expressionPrice(model.billing_expr, "cc") ?? input;
    prices[id] = {
      input,
      cacheRead: cacheRead > 0 ? cacheRead : input,
      cacheWrite: cacheWrite > 0 ? cacheWrite : input,
      output: output > 0 ? output : input,
    };
  }
  if (Object.keys(prices).length === 0) return { ok: false, reason: "no_prices" };
  const fetchedAt = (options.now ?? new Date()).toISOString();
  return { ok: true, list: { prices, source: "gateway", fetchedAt } };
}

/**
 * `quota_per_unit` from `GET /api/status`, when the gateway publishes it. The default holds
 * for a stock New API; a gateway that changed it would otherwise scale every price.
 */
export function parsePrsloyQuotaPerUnit(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  return positive((data as { quota_per_unit?: unknown }).quota_per_unit);
}
