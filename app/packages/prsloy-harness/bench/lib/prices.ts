// Цена замера в рублях по той же таблице шлюза, что и в приложении (#52). Нет цены у модели,
// по которой шли токены, — цена неизвестна (null), а не ноль: ноль выглядел бы как «бесплатно».
// Явный файл принимается для старых прогонов и тестов; отдельной пустой таблицы бенча больше нет.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenCount, TokenUsage } from "./meter.ts";
import { PRSLOY_PRICE_TABLE_SNAPSHOT } from "../../../../apps/desktop/src/shared/prsloy-prices-table.ts";

export interface ModelPrice {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export type PriceTable = Record<string, ModelPrice>;

/** The same retail snapshot that seeds the app before its live price refresh. */
export const PRICES_FILE = join(
  import.meta.dirname,
  "../../../../apps/desktop/src/shared/prsloy-prices-table.ts",
);

export function readPrices(path?: string): PriceTable {
  if (!path)
    return Object.fromEntries(
      Object.entries(PRSLOY_PRICE_TABLE_SNAPSHOT).map(([model, price]) => [
        model,
        {
          input: price.input,
          output: price.output,
          cacheRead: price.cacheRead,
          cacheWrite: price.cacheWrite,
        },
      ]),
    );
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    models?: Record<string, Partial<ModelPrice>>;
  };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const out: PriceTable = {};
  for (const [model, p] of Object.entries(raw.models ?? {}))
    out[model] = {
      input: n(p.input),
      output: n(p.output),
      cacheRead: n(p.cacheRead),
      cacheWrite: n(p.cacheWrite),
    };
  return out;
}

/** Цена одной модели: вход без кэша, кэш (чтение, запись), выход. null — нужной цены нет. */
export function countRub(count: TokenCount, price: ModelPrice | undefined): number | null {
  if (!price) return count.input || count.output ? null : 0;
  const fresh = Math.max(0, count.input - count.cacheRead - count.cacheWrite);
  const parts: [number, number | null][] = [
    [fresh, price.input],
    [count.cacheRead, price.cacheRead],
    [count.cacheWrite, price.cacheWrite],
    [count.output, price.output],
  ];
  let rub = 0;
  for (const [tokens, perMillion] of parts) {
    if (!tokens) continue;
    if (perMillion === null) return null;
    rub += (tokens * perMillion) / 1_000_000;
  }
  return rub;
}

/** Цена всех вызовов по моделям; null — хоть у одной модели с токенами цены нет. */
export function usageRub(usage: TokenUsage, prices: PriceTable): number | null {
  let rub = 0;
  for (const [model, count] of Object.entries(usage.byModel)) {
    const one = countRub(count, prices[model.replace(/^[^/]+\//, "")] ?? prices[model]);
    if (one === null) return null;
    rub += one;
  }
  return rub;
}
