/**
 * «Быстрее / Качественнее»: the casual model switch.
 *
 * Casual users pick a speed/quality trade-off, not a model id. Ids and provider come from
 * the core stream's `shared/prsloy-config.ts` (single source of truth).
 */
import {
  PRSLOY_PROVIDER_ID,
  PRSLOY_SPEED_MODES,
  prsloySpeedModelId,
  type PrsloySpeedMode,
} from "../../shared/prsloy-config.ts";

export type ModelTier = PrsloySpeedMode;

/** Each tier's first choice; the one actually used depends on what the gateway serves. */
export const MODEL_TIERS: Readonly<Record<ModelTier, string>> = {
  fast: PRSLOY_SPEED_MODES.fast.modelId,
  quality: PRSLOY_SPEED_MODES.quality.modelId,
};

/** Provider used when a tier's model is not in the host's model list yet. */
export const MODEL_TIER_PROVIDER = PRSLOY_PROVIDER_ID;
export const MODEL_TIER_ORDER: readonly ModelTier[] = ["fast", "quality"];

export type TierModelOption = { provider: string; id: string };

/**
 * The tier's model for the host's model list: the first of its preference list the
 * PRSLOY provider offers (the host lists only what the gateway serves). Without PRSLOY
 * entries, the tier's first choice.
 */
export function tierModelId(tier: ModelTier, options: readonly TierModelOption[] = []): string {
  const served = options.filter((o) => o.provider === MODEL_TIER_PROVIDER).map((o) => o.id);
  return prsloySpeedModelId(tier, served.length ? served : undefined);
}

/** Which tier the active `provider/id` model belongs to, if any. */
export function tierForModel(
  modelValue: string,
  options: readonly TierModelOption[] = [],
): ModelTier | undefined {
  const id = modelValue.slice(modelValue.indexOf("/") + 1);
  return MODEL_TIER_ORDER.find((tier) => tierModelId(tier, options) === id);
}

/**
 * The model to switch to for a tier: the host's own entry for that id (preferring the
 * PRSLOY provider when several providers list it), else the PRSLOY provider by default.
 */
export function modelForTier(
  tier: ModelTier,
  options: readonly TierModelOption[],
): TierModelOption {
  const id = tierModelId(tier, options);
  const matches = options.filter((option) => option.id === id);
  return (
    matches.find((option) => option.provider === MODEL_TIER_PROVIDER) ??
    matches[0] ?? { provider: MODEL_TIER_PROVIDER, id }
  );
}
