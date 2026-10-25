import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CASUAL_PREFS,
  DEFAULT_RUB_PER_USD,
  DEVELOPER_SETTINGS_SECTIONS,
  isSettingsSectionVisible,
  isShortcutVisible,
  loadCasualPrefs,
  normalizeCasualPrefs,
  normalizeRubPerUsd,
  saveCasualPrefs,
} from "./casual-prefs.ts";

describe("casual-prefs", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });
  });

  it("starts in casual mode at 95 ₽ per dollar", () => {
    expect(DEFAULT_CASUAL_PREFS).toEqual({ developerMode: false, rubPerUsd: 95 });
    expect(loadCasualPrefs()).toEqual(DEFAULT_CASUAL_PREFS);
  });

  it("persists and merges patches", () => {
    saveCasualPrefs({ developerMode: true });
    expect(loadCasualPrefs()).toEqual({ developerMode: true, rubPerUsd: 95 });
    saveCasualPrefs({ rubPerUsd: 101.5 });
    expect(loadCasualPrefs()).toEqual({ developerMode: true, rubPerUsd: 101.5 });
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("prsloy.casual.prefs.v1", "{not json");
    expect(loadCasualPrefs()).toEqual(DEFAULT_CASUAL_PREFS);
  });

  it("only turns developer mode on for a literal true", () => {
    expect(normalizeCasualPrefs({ developerMode: "yes" as unknown as boolean }).developerMode).toBe(
      false,
    );
    expect(normalizeCasualPrefs(null)).toEqual(DEFAULT_CASUAL_PREFS);
  });

  it("clamps and parses the ruble rate, accepting a decimal comma", () => {
    expect(normalizeRubPerUsd("92,5")).toBe(92.5);
    expect(normalizeRubPerUsd(0)).toBe(1);
    expect(normalizeRubPerUsd(5000)).toBe(1000);
    expect(normalizeRubPerUsd("abc")).toBe(DEFAULT_RUB_PER_USD);
    expect(normalizeRubPerUsd(Number.NaN)).toBe(DEFAULT_RUB_PER_USD);
    expect(normalizeRubPerUsd(94.999)).toBe(95);
  });

  it("hides developer settings pages until developer mode is on", () => {
    for (const section of ["terminal", "models", "pi", "proxy", "usage", "git"] as const) {
      expect(DEVELOPER_SETTINGS_SECTIONS.has(section)).toBe(true);
      expect(isSettingsSectionVisible(section, false)).toBe(false);
      expect(isSettingsSectionVisible(section, true)).toBe(true);
    }
    for (const section of ["general", "appearance", "notifications", "archived"] as const) {
      expect(isSettingsSectionVisible(section, false)).toBe(true);
    }
  });

  it("shows «Поиск в интернете» to everyone only once SEARCH_READY (#23)", () => {
    // alpha.2: SEARCH_READY is true, so the default shows it
    expect(isSettingsSectionVisible("webSearch", false)).toBe(true);
    expect(isSettingsSectionVisible("webSearch", false, false)).toBe(false);
    expect(isSettingsSectionVisible("webSearch", true, false)).toBe(true);
    expect(isSettingsSectionVisible("webSearch", false, true)).toBe(true);
    expect(isSettingsSectionVisible("memory", false, false)).toBe(true);
  });

  it("hides shortcuts to developer surfaces until developer mode is on", () => {
    for (const id of ["packages", "resources", "toggle-content-mode"]) {
      expect(isShortcutVisible(id, false)).toBe(false);
      expect(isShortcutVisible(id, true)).toBe(true);
    }
    expect(isShortcutVisible("new-thread", false)).toBe(true);
  });
});
