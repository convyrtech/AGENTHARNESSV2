/**
 * Casual-mode shell prefs (localStorage — not pi settings).
 *
 * PRSLOY is built for people who do not program. Developer-heavy surfaces (terminal / TUI,
 * package catalog, MCP, provider and OAuth logins, the raw model picker) stay in the app but
 * are hidden until the user turns on «Для разработчиков». Costs are shown in rubles at a
 * user-set rate, since pi reports them in dollars.
 */

import type { SettingsSection } from "../store/shell-store.ts";

export type CasualPrefs = {
  /** Show developer surfaces. Off by default. */
  developerMode: boolean;
  /** Rubles per US dollar for cost display. */
  rubPerUsd: number;
};

const KEY = "prsloy.casual.prefs.v1";
export const CASUAL_PREFS_CHANGED_EVENT = "prsloy-casual-prefs";

export const DEFAULT_RUB_PER_USD = 95;
export const RUB_PER_USD_MIN = 1;
export const RUB_PER_USD_MAX = 1000;

export const DEFAULT_CASUAL_PREFS: CasualPrefs = {
  developerMode: false,
  rubPerUsd: DEFAULT_RUB_PER_USD,
};

/** Settings pages that only make sense to someone who knows what a provider or a PTY is. */
export const DEVELOPER_SETTINGS_SECTIONS: ReadonlySet<SettingsSection> = new Set<SettingsSection>([
  "pi",
  "piSettings",
  "models",
  "usage",
  "environment",
  "terminal",
  "worktree",
  "runtimes",
  "proxy",
]);

export function isSettingsSectionVisible(
  section: SettingsSection,
  developerMode: boolean,
): boolean {
  return developerMode || !DEVELOPER_SETTINGS_SECTIONS.has(section);
}

export function normalizeRubPerUsd(value: unknown): number {
  const n = typeof value === "string" ? Number(value.replace(",", ".")) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_RUB_PER_USD;
  return Math.min(RUB_PER_USD_MAX, Math.max(RUB_PER_USD_MIN, Math.round(n * 100) / 100));
}

export function normalizeCasualPrefs(raw: Partial<CasualPrefs> | null | undefined): CasualPrefs {
  return {
    developerMode: raw?.developerMode === true,
    rubPerUsd: normalizeRubPerUsd(raw?.rubPerUsd),
  };
}

export function loadCasualPrefs(): CasualPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw
      ? normalizeCasualPrefs(JSON.parse(raw) as Partial<CasualPrefs>)
      : { ...DEFAULT_CASUAL_PREFS };
  } catch {
    return { ...DEFAULT_CASUAL_PREFS };
  }
}

export function saveCasualPrefs(patch: Partial<CasualPrefs>): CasualPrefs {
  const next = normalizeCasualPrefs({ ...loadCasualPrefs(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // LocalStorage is unavailable in a few embedded test surfaces.
  }
  try {
    window.dispatchEvent(new CustomEvent(CASUAL_PREFS_CHANGED_EVENT));
  } catch {
    // No window in node tests.
  }
  return next;
}
