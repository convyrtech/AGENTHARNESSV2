import { describe, expect, it } from "vite-plus/test";
import {
  cleanText,
  isInjectedContext,
  MAX_MESSAGE_CHARS,
  removeInvisible,
  scrub,
  stripControlWrappers,
  toolErrorNote,
  toolFile,
  toolNote,
} from "../src/clean.ts";

describe("clean", () => {
  it("removes service wrappers anywhere and unwraps a user query", () => {
    expect(stripControlWrappers("<system-reminder>скрыто</system-reminder>\nПривет")).toBe(
      "Привет",
    );
    expect(stripControlWrappers("а <ide_selection>x</ide_selection> б")).toBe("а  б");
    expect(stripControlWrappers("<user_query>сделай сайт</user_query>")).toBe("сделай сайт");
    expect(isInjectedContext("  <environment_context>…")).toBe(true);
    expect(isInjectedContext("обычный текст")).toBe(false);
  });

  it("drops zero-width, bidi and Unicode tag characters", () => {
    const hidden = `ок\u200b\u202e${String.fromCodePoint(0xe0041, 0xe0042)}`;
    expect(removeInvisible(hidden)).toBe("ок");
  });

  it("hides known key shapes and named secrets, keeping the name", () => {
    const key = `sk-${"z9".repeat(12)}`;
    expect(scrub(`ключ ${key}`)).toEqual({ text: "ключ [СКРЫТО: sk-ключ]", count: 1 });
    expect(scrub("API_KEY=abcdefgh12345").text).toBe("API_KEY=[СКРЫТО: секрет]");
    expect(scrub('"token": "qwertyuiop"').text).toBe('"token": "[СКРЫТО: секрет]"');
    expect(scrub("password: short").count).toBe(0);
  });

  it("cuts very long messages", () => {
    const { text } = cleanText("я".repeat(MAX_MESSAGE_CHARS + 50));
    expect(text).toHaveLength(MAX_MESSAGE_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });

  it("writes one-line tool notes and failed-tool errors", () => {
    expect(toolNote("Bash", { command: "npm\n  test" })).toBe("• Bash: npm test");
    expect(toolNote("WebFetch", {})).toBe("• WebFetch");
    expect(toolNote("Read", { file_path: "C:\\проект\\a.ts" })).toBe("• Read: C:\\проект\\a.ts");
    expect(toolFile({ path: " src/a.ts " })).toBe("src/a.ts");
    expect(toolFile("x")).toBeUndefined();
    expect(toolErrorNote("e".repeat(400))).toHaveLength("• ошибка инструмента: ".length + 300);
  });
});
