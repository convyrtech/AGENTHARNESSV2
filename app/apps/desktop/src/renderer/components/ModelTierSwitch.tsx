/**
 * Casual model control: «Быстрее | Качественнее» in place of the raw model picker.
 * Tier → model id lives in lib/model-tiers.ts.
 */
import { t, type Locale } from "../lib/i18n.ts";
import {
  MODEL_TIER_ORDER,
  modelForTier,
  tierForModel,
  type ModelTier,
  type TierModelOption,
} from "../lib/model-tiers.ts";

const TIER_LABEL = { fast: "composer.tier.fast", quality: "composer.tier.quality" } as const;

export function ModelTierSwitch(props: {
  locale: Locale;
  modelValue: string;
  modelOptions: readonly TierModelOption[];
  disabled?: boolean;
  onModelChange: (provider: string, id: string) => void;
}) {
  const active = tierForModel(props.modelValue);

  function pick(tier: ModelTier) {
    if (tier === active) return;
    const model = modelForTier(tier, props.modelOptions);
    props.onModelChange(model.provider, model.id);
  }

  return (
    <div
      role="radiogroup"
      aria-label={t(props.locale, "composer.tier.label")}
      className="model-tier-switch"
      data-testid="model-tier-switch"
    >
      {MODEL_TIER_ORDER.map((tier) => (
        <button
          key={tier}
          type="button"
          role="radio"
          aria-checked={active === tier}
          data-active={active === tier ? "true" : "false"}
          data-testid={`model-tier-${tier}`}
          disabled={props.disabled}
          className="model-tier-option"
          onClick={() => pick(tier)}
        >
          {t(props.locale, TIER_LABEL[tier])}
        </button>
      ))}
    </div>
  );
}
