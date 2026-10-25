/**
 * «Быстрее / Качественнее»: the casual model switch.
 *
 * Casual users pick a speed/quality trade-off, not a model id. The two tiers map to model
 * ids through this one constant; the core stream owns which ids and provider are current.
 */

export const MODEL_TIERS = {
  fast: "deepseek-v4.1-flash-1017",
  quality: "kimi-k3.1-pro",
} as const;

/** Provider used when a tier's model is not in the host's model list yet. */
export const MODEL_TIER_PROVIDER = "prsloy";

export type ModelTier = keyof typeof MODEL_TIERS;
export const MODEL_TIER_ORDER: readonly ModelTier[] = ["fast", "quality"];

export type TierModelOption = { provider: string; id: string };

/** Which tier the active `provider/id` model belongs to, if any. */
export function tierForModel(modelValue: string): ModelTier | undefined {
  const id = modelValue.slice(modelValue.indexOf("/") + 1);
  return MODEL_TIER_ORDER.find((tier) => MODEL_TIERS[tier] === id);
}

/**
 * The model to switch to for a tier: the host's own entry for that id (preferring the
 * PRSLOY provider when several providers list it), else the PRSLOY provider by default.
 */
export function modelForTier(
  tier: ModelTier,
  options: readonly TierModelOption[],
): TierModelOption {
  const id = MODEL_TIERS[tier];
  const matches = options.filter((option) => option.id === id);
  return (
    matches.find((option) => option.provider === MODEL_TIER_PROVIDER) ??
    matches[0] ?? { provider: MODEL_TIER_PROVIDER, id }
  );
}
