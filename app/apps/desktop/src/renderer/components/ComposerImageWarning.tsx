/**
 * Pictures attached to a model that cannot take them (#75): pi would swap them for
 * «(image omitted: model does not support images)» without a word, so say it here and
 * offer the model that can. Lives outside Composer.tsx to keep it inside its line budget.
 */
import { useMemo } from "react";
import { ImageOff } from "lucide-react";
import { t, type Locale } from "../lib/i18n.ts";
import { findModel, imageWarning } from "../lib/model-images.ts";
import type { ComposerModelOption } from "./Composer.tsx";

export interface ComposerImageWarningProps {
  locale: Locale;
  /** `provider/id` of the chosen model. */
  modelValue: string;
  modelOptions: readonly ComposerModelOption[];
  attachments: readonly string[];
  onModelChange: (provider: string, id: string) => void;
}

export function ComposerImageWarning(props: ComposerImageWarningProps) {
  const pictureLoss = useMemo(
    () =>
      imageWarning({
        model: findModel(props.modelOptions, props.modelValue),
        attachments: props.attachments,
        models: props.modelOptions,
      }),
    [props.modelOptions, props.modelValue, props.attachments],
  );
  if (!pictureLoss) return null;
  const switchTo = pictureLoss.switchTo;

  return (
    <div
      className="flex items-start gap-2 px-3.5 pt-2 text-xs text-amber-600 dark:text-amber-400"
      data-testid="composer-image-warning"
      role="status"
    >
      <ImageOff className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {t(props.locale, "composer.imageWarning", { model: pictureLoss.modelName })}
      </span>
      {switchTo ? (
        <button
          type="button"
          className="shrink-0 rounded-md px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-amber-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          data-testid="composer-image-warning-switch"
          onClick={() => props.onModelChange(switchTo.provider, switchTo.id)}
        >
          {t(props.locale, "composer.imageWarning.switch", { model: switchTo.name })}
        </button>
      ) : null}
    </div>
  );
}
