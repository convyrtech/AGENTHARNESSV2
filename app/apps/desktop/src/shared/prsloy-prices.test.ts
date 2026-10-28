import { describe, expect, it } from "vite-plus/test";
import {
  parsePrsloyPricing,
  prsloyModelCostRub,
  prsloyPriceFor,
  prsloySnapshotPrices,
  PRSLOY_QUOTA_PER_UNIT,
} from "./prsloy-prices.ts";

/** The shape New API's `/api/pricing` answers with (captured 2026-10-27, trimmed). */
const GATEWAY_PRICING = {
  auto_groups: ["default"],
  group_ratio: { default: 1, vip: 1 },
  usable_group: { default: "Default group" },
  data: [
    {
      model_name: "kimi-k3.1-pro",
      quota_type: 0,
      model_ratio: 13,
      completion_ratio: 5,
      cache_ratio: 0.25,
      enable_groups: ["default"],
      billing_mode: "tiered_expr",
      billing_expr:
        'tier("guard", min(p * 26.0 + cr * 6.5 + cc * 32.5 + cc1h * 52.0 + c * 130.0, 100000000.0))',
    },
    {
      model_name: "deepseek-v4.1-flash-1017",
      quota_type: 0,
      model_ratio: 0.52,
      completion_ratio: 3.942308,
      cache_ratio: 0.048077,
      enable_groups: ["default"],
      billing_mode: "tiered_expr",
      billing_expr:
        'tier("guard", min(p * 1.04 + cr * 0.05 + cc * 1.3 + cc1h * 2.08 + c * 4.1, 100000000.0))',
    },
    {
      model_name: "nano-banana-pro",
      quota_type: 1,
      model_price: 3.6,
    },
  ],
};

describe("parsePrsloyPricing", () => {
  it("reads the billing expression, the route the gateway actually bills by", () => {
    const parsed = parsePrsloyPricing(GATEWAY_PRICING, { now: new Date("2026-10-27T12:00:00Z") });
    expect(parsed).toMatchObject({ ok: true, list: { source: "gateway" } });
    if (!parsed.ok) return;
    expect(parsed.list.fetchedAt).toBe("2026-10-27T12:00:00.000Z");
    // The owner's own numbers (DIARY, 26.10): 26 ₽ вход, 6,5 ₽ кэш.
    expect(parsed.list.prices["kimi-k3.1-pro"]).toEqual({
      input: 26,
      cacheRead: 6.5,
      cacheWrite: 32.5,
      output: 130,
    });
    expect(parsed.list.prices["deepseek-v4.1-flash-1017"]).toEqual({
      input: 1.04,
      cacheRead: 0.05,
      cacheWrite: 1.3,
      output: 4.1,
    });
  });

  it("derives the same price from model_ratio when there is no expression", () => {
    const body = {
      data: [
        {
          model_name: "plain-model",
          quota_type: 0,
          model_ratio: 13,
          completion_ratio: 5,
          cache_ratio: 0.25,
        },
      ],
      group_ratio: { default: 1 },
    };
    const parsed = parsePrsloyPricing(body);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    // 1e6 × ratio × group / quota_per_unit (500 000) = 26 ₽ per 1M — same as the expression.
    expect(parsed.list.prices["plain-model"]).toEqual({
      input: 26,
      cacheRead: 6.5,
      cacheWrite: 26,
      output: 130,
    });
  });

  it("respects quota_per_unit: a gateway that redefines it scales ratio-only prices", () => {
    const body = {
      data: [{ model_name: "m", quota_type: 0, model_ratio: 1 }],
      group_ratio: { default: 1 },
    };
    const half = parsePrsloyPricing(body, { quotaPerUnit: 1_000_000 });
    const normal = parsePrsloyPricing(body);
    expect(half.ok && normal.ok).toBe(true);
    if (!half.ok || !normal.ok) return;
    expect(normalHalf(half)).toBe(1);
    expect(normalHalf(normal)).toBe(2);
    function normalHalf(r: { ok: true; list: { prices: Record<string, { input: number }> } }) {
      return r.list.prices["m"]!.input;
    }
  });

  it("skips per-call models and models without a price instead of guessing", () => {
    const parsed = parsePrsloyPricing(GATEWAY_PRICING);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.list.prices["nano-banana-pro"]).toBeUndefined();
  });

  it("refuses non-pricing bodies instead of parsing zeros", () => {
    expect(parsePrsloyPricing(null).ok).toBe(false);
    expect(parsePrsloyPricing("<html>404</html>").ok).toBe(false);
    expect(parsePrsloyPricing({ success: true, data: "nope" }).ok).toBe(false);
    expect(parsePrsloyPricing({ data: [] })).toEqual({ ok: false, reason: "no_prices" });
  });

  it("a changed group ratio scales the ratio-derived price", () => {
    const body = {
      data: [{ model_name: "m", quota_type: 0, model_ratio: 1 }],
      group_ratio: { default: 2 },
    };
    const parsed = parsePrsloyPricing(body);
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.list.prices["m"]!.input).toBe(4);
  });
});

describe("prsloyPriceFor / prsloyModelCostRub", () => {
  it("knows the bundled prices", () => {
    expect(prsloyPriceFor("kimi-k3.1-pro")).toEqual({
      input: 26,
      cacheRead: 6.5,
      cacheWrite: 32.5,
      output: 130,
    });
    expect(prsloyPriceFor("unknown-model")).toBeUndefined();
  });

  it("returns a cost block in the shape models.json expects; unpriced stays zeroed", () => {
    expect(prsloyModelCostRub("kimi-k3.1-pro")).toEqual({
      input: 26,
      output: 130,
      cacheRead: 6.5,
      cacheWrite: 32.5,
    });
    expect(prsloyModelCostRub("unknown-model")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("a passed table wins over the snapshot", () => {
    expect(
      prsloyModelCostRub("m", { m: { input: 2, cacheRead: 1, cacheWrite: 2, output: 8 } }),
    ).toEqual({
      input: 2,
      output: 8,
      cacheRead: 1,
      cacheWrite: 2,
    });
  });

  it("the snapshot is what an offline launch falls back to", () => {
    expect(prsloySnapshotPrices().source).toBe("snapshot");
    expect(prsloySnapshotPrices().prices["kimi-k3.1-pro"]).toBeDefined();
  });
});

it("documents the quota the gateway counts in", () => {
  expect(PRSLOY_QUOTA_PER_UNIT).toBe(500_000);
});
