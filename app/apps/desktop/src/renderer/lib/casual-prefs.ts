/**
 * Casual-mode shell prefs (localStorage — not pi settings).
 *
 * PRSLOY is built for people who do not program. Developer-heavy surfaces (terminal / TUI,
 * package catalog, MCP, provider and OAuth logins, the raw model picker) stay in the app but
 * are hidden until the user turns on «Для разработчиков». PRSLOY costs are already rubles
 * from the gateway's retail price list (#52); no user-set exchange rate is involved.
 */

import type { SettingsSection } from "../store/shell-store.ts";
import { SEARCH_READY } from "../../shared/search-ready.ts";

export type CasualPrefs = {
  /** Show developer surfaces. Off by default. */
  developerMode: boolean;
};

const KEY = "prsloy.casual.prefs.v1";
export const CASUAL_PREFS_CHANGED_EVENT = "prsloy-casual-prefs";

export const DEFAULT_CASUAL_PREFS: CasualPrefs = { developerMode: false };

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
  // pull / merge / force push / PR / branch prefix: a developer's Git, not a casual user's.
  "git",
]);

/** Shortcuts that open developer surfaces (packages, resources, the pi terminal). */
export const DEVELOPER_SHORTCUTS: ReadonlySet<string> = new Set([
  "packages",
  "resources",
  "toggle-content-mode",
]);

export function isShortcutVisible(id: string, developerMode: boolean): boolean {
  return developerMode || !DEVELOPER_SHORTCUTS.has(id);
}

export function isSettingsSectionVisible(
  section: SettingsSection,
  developerMode: boolean,
  searchReady: boolean = SEARCH_READY,
): boolean {
  // #23: «Поиск в интернете» is a developer's page until SEARCH_READY.
  if (section === "webSearch" && !searchReady) return developerMode;
  return developerMode || !DEVELOPER_SETTINGS_SECTIONS.has(section);
}

export function normalizeCasualPrefs(raw: Partial<CasualPrefs> | null | undefined): CasualPrefs {
  // Legacy `rubPerUsd` in localStorage is ignored on purpose (#52).
  return { developerMode: raw?.developerMode === true };
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
