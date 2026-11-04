// Test-only pricing guard. The server applies group factors after these expressions;
// the caller must independently verify the test key uses the default group.
const EXPRESSIONS: Record<string, string> = {
  "deepseek-v4.1-flash-1017":
    'tier("guard", min(p * 1.04 + cr * 0.05 + cc * 1.3 + cc1h * 2.08 + c * 4.1, 3000000.0))',
  "gpt-6-luna":
    'tier("guard", min(p * 8.1 + cr * 0.81 + cc * 10.125 + cc1h * 16.2 + c * 41.0, 3000000.0))',
};

export function benchmarkPricingValid(model: string, pricing: unknown, status: unknown): boolean {
  if (!Object.hasOwn(EXPRESSIONS, model) || !isObject(pricing) || !isObject(status)) return false;
  const entries = pricing.data;
  const settings = status.data;
  const ratios = pricing.group_ratio;
  if (!Array.isArray(entries) || !isObject(settings) || !isObject(ratios)) return false;
  const matches = entries.filter((entry: unknown) => isObject(entry) && entry.model_name === model);
  if (matches.length !== 1) return false;
  const entry = matches[0];
  return (
    pricing.success === true &&
    status.success === true &&
    entry.billing_mode === "tiered_expr" &&
    entry.billing_expr === EXPRESSIONS[model] &&
    Array.isArray(entry.enable_groups) &&
    entry.enable_groups.length === 1 &&
    entry.enable_groups[0] === "default" &&
    ratios.default === 1 &&
    ratios.vip === 1 &&
    Object.keys(ratios).every((key) => key === "default" || key === "vip") &&
    settings.quota_per_unit === 500_000 &&
    settings.quota_display_type === "CUSTOM" &&
    settings.custom_currency_symbol === "₽" &&
    settings.custom_currency_exchange_rate === 1 &&
    settings.usd_exchange_rate === 1
  );
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateBenchmarkPricing(model: string): Promise<boolean> {
  if (!Object.hasOwn(EXPRESSIONS, model)) return false;
  try {
    const options = { redirect: "error" as const, signal: AbortSignal.timeout(10_000) };
    const [pricing, status] = await Promise.all([
      fetch("https://prsloy.online/api/pricing", options),
      fetch("https://prsloy.online/api/status", options),
    ]);
    if (!pricing.ok || !status.ok) return false;
    return benchmarkPricingValid(model, await pricing.json(), await status.json());
  } catch {
    return false;
  }
}
