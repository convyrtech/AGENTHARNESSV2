/**
 * Guard: the Russian interface never shows a casual owner the machinery's words. Every
 * string of the ru table is checked against a stop list of Latin technical words.
 */
import { describe, expect, it } from "vite-plus/test";
import { PRSLOY_MODELS } from "../../../shared/prsloy-config.ts";
import { ru } from "./ru.ts";

const STOP_WORDS =
  /\b(tokens?|providers?|sessions?|API|JSON|stderr|stdout|extensions?|[Pp]i|Zeno|Agent Host)\b/u;

/** Names that are the product's own words, not machinery: the brand and the model names. */
const NAMES = ["PRSLOY", ...PRSLOY_MODELS.map((model) => model.name)];

/**
 * Strings shown only with «Для разработчиков» on, where the technical name is what a
 * developer looks for: installing the pi CLI, its settings and docs (`enabledModels`,
 * settings.json), the custom model form.
 */
const DEVELOPER_ONLY = new Set([
  "section.pi",
  "settings.group.pi",
  "pi.checking",
  "pi.installing",
  "pi.progress",
  "pi.complete",
  "pi.completeInstalled",
  "pi.error",
  "pi.skipped",
  "piSdk.config.sessions",
  "piSettings.agentDirHint",
  "piSettings.installTelemetryHint",
  "piSettings.analyticsHint",
  "session.parity.importHint",
  "models.scopeToggleHelpDocs",
  "models.wildcardHelpDocs",
  "models.wildcardHelpDocsUsage",
  "models.customBaseUrl",
  "models.customApi",
  "models.customModelCatalogLocked",
  "models.scopedPatternsPh",
  "models.scopeToggleHelpP1",
  "models.wildcardHelp",
  "models.wildcardHelpP1",
  "models.wildcardHelpP2",
  "piSettings.thinkingBudgetsEmpty",
]);

function plain(text: string): string {
  // `{provider}` and the like are template slots, filled with plain words at runtime.
  let out = text.replace(/\{[^}]*\}/gu, "");
  for (const name of NAMES) out = out.split(name).join("");
  return out;
}

describe("ru locale: plain words only", () => {
  it("has no technical Latin word outside the developer-only strings", () => {
    const offenders = Object.entries(ru as Record<string, string>)
      .filter(([key]) => !DEVELOPER_ONLY.has(key))
      .filter(([, text]) => STOP_WORDS.test(plain(text)))
      .map(([key, text]) => `${key}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the developer-only list honest (every key exists and still needs it)", () => {
    for (const key of DEVELOPER_ONLY) {
      const text = (ru as Record<string, string>)[key];
      expect(text, key).toBeTypeOf("string");
      expect(STOP_WORDS.test(plain(text ?? "")), key).toBe(true);
    }
  });

  it("catches the words it is meant to catch", () => {
    for (const text of ["Ошибка API", "Новая session", "Agent Host упал", "терминал pi"]) {
      expect(STOP_WORDS.test(plain(text)), text).toBe(true);
    }
    for (const text of [
      "Ключ PRSLOY",
      "Вход в {provider}",
      "Бот для Telegram",
      "Таблица в Excel",
    ]) {
      expect(STOP_WORDS.test(plain(text)), text).toBe(false);
    }
  });
});
