export type Locale = "ru" | "zh" | "en";

import { en } from "./locales/en.ts";
import { ru } from "./locales/ru.ts";
import { zh } from "./locales/zh.ts";

export const messages = {
  zh,
  en,
  ru,
} as const;

export type MessageKey = keyof (typeof messages)["zh"];

export const DEFAULT_LOCALE: Locale = "ru";

/**
 * What the user picked in settings. `auto` defers to environment detection
 * (see lib/locale-detect.ts); the resolved `Locale` is what `t()` consumes.
 */
export type LocalePreference = "auto" | Locale;

export function isLocale(value: unknown): value is Locale {
  return value === "ru" || value === "zh" || value === "en";
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "auto" || isLocale(value);
}

/** BCP 47 tag for `Intl` formatting. */
export function localeTag(locale: Locale): string {
  if (locale === "ru") return "ru-RU";
  if (locale === "zh") return "zh-CN";
  return "en-US";
}

export function t(locale: Locale, key: MessageKey, vars?: Record<string, string>): string {
  const table = messages[locale] ?? messages[DEFAULT_LOCALE];
  let text: string = table[key] ?? messages.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, value);
    }
  }
  return text;
}

const THINKING_LEVEL_KEYS: Record<string, MessageKey> = {
  off: "piSettings.thinking.off",
  minimal: "piSettings.thinking.minimal",
  low: "piSettings.thinking.low",
  medium: "piSettings.thinking.medium",
  high: "piSettings.thinking.high",
  xhigh: "piSettings.thinking.xhigh",
  max: "piSettings.thinking.max",
};

/** Localized label for pi thinking levels (settings + composer). */
export function thinkingLevelLabel(locale: Locale, level: string): string {
  const key = THINKING_LEVEL_KEYS[level.trim().toLowerCase()];
  return key ? t(locale, key) : level;
}
