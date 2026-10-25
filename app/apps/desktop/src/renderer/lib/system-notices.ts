/**
 * Timeline system notes carry English titles from the projection ("Response failed",
 * "Retry", …). Known ones map to i18n keys here; anything else is shown as it came.
 */
import { t, type Locale, type MessageKey } from "./i18n.ts";

/** The projection's title for a model turn that failed (not stopped by the user). */
export const RESPONSE_FAILED_TITLE = "Response failed";

const TITLE_KEYS: Readonly<Record<string, MessageKey>> = {
  [RESPONSE_FAILED_TITLE]: "system.responseFailed",
  "Response stopped": "system.responseStopped",
  "Response pending": "system.responsePending",
  "Response deferred": "system.responseDeferred",
  Retry: "system.retry",
  "Agent Host crashed": "system.hostCrashed",
};

export function localizedSystemTitle(locale: Locale, title: string): string {
  const key = TITLE_KEYS[title];
  return key ? t(locale, key) : title;
}

export function isModelFailure(item: { title?: string; tone?: string }): boolean {
  return item.tone === "error" && item.title === RESPONSE_FAILED_TITLE;
}

/**
 * Session notes written for the model, not the reader: core's «Файлы хода N откатены…»
 * after an undo (the transcript already shows «Ход откачен: …»).
 */
const MODEL_ONLY_CUSTOM_TYPES: ReadonlySet<string> = new Set(["prsloy.undo"]);

export function isModelOnlyNote(item: { extension?: boolean; title?: string }): boolean {
  return (
    item.extension === true && item.title !== undefined && MODEL_ONLY_CUSTOM_TYPES.has(item.title)
  );
}
