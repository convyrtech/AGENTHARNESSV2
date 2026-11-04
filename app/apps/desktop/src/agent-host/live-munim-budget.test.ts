import { describe, expect, it } from "vite-plus/test";
import { benchmarkPricingValid } from "../../e2e/live-munim-budget";

const model = "gpt-6-luna";
const expression =
  'tier("guard", min(p * 8.1 + cr * 0.81 + cc * 10.125 + cc1h * 16.2 + c * 41.0, 3000000.0))';
function sample() {
  return {
    pricing: {
      success: true,
      group_ratio: { default: 1, vip: 1 },
      data: [
        {
          model_name: model,
          billing_mode: "tiered_expr",
          billing_expr: expression,
          enable_groups: ["default"],
        },
      ],
    },
    status: {
      success: true,
      data: {
        quota_per_unit: 500_000,
        quota_display_type: "CUSTOM",
        custom_currency_symbol: "₽",
        custom_currency_exchange_rate: 1,
        usd_exchange_rate: 1,
      },
    },
  };
}

describe("benchmark pricing preflight", () => {
  it("accepts only the pinned model, tariff and currency", () => {
    const { pricing, status } = sample();
    expect(benchmarkPricingValid(model, pricing, status)).toBe(true);
    expect(benchmarkPricingValid("other-model", pricing, status)).toBe(false);
  });
  it("fails closed if the cap, group or conversion changes", () => {
    const a = sample();
    a.pricing.data[0]!.billing_expr = expression.replace("3000000.0", "100000000.0");
    expect(benchmarkPricingValid(model, a.pricing, a.status)).toBe(false);
    const b = sample();
    b.pricing.group_ratio.default = 2;
    expect(benchmarkPricingValid(model, b.pricing, b.status)).toBe(false);
    const c = sample();
    c.status.data.custom_currency_exchange_rate = 2;
    expect(benchmarkPricingValid(model, c.pricing, c.status)).toBe(false);
    const changedUsd = sample();
    changedUsd.status.data.usd_exchange_rate = 2;
    expect(benchmarkPricingValid(model, changedUsd.pricing, changedUsd.status)).toBe(false);
    const d = sample();
    d.pricing.data.push(d.pricing.data[0]!);
    expect(benchmarkPricingValid(model, d.pricing, d.status)).toBe(false);
  });
  it("fails closed on missing or malformed pricing", () => {
    expect(benchmarkPricingValid(model, {}, {})).toBe(false);
    expect(benchmarkPricingValid(model, null, null)).toBe(false);
  });
});
