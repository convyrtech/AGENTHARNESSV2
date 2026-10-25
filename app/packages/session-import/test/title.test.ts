import { describe, expect, it } from "vite-plus/test";
import { FALLBACK_TITLE, pickTitle, TITLE_MAX_CHARS } from "../src/title.ts";

describe("pickTitle", () => {
  it("prefers the owner's name, then the agent's, then the first request line", () => {
    expect(pickTitle({ customTitle: " Мой  чат ", aiTitle: "ИИ", firstRequest: "x" })).toBe(
      "Мой чат",
    );
    expect(pickTitle({ aiTitle: "Цвет кнопки", firstRequest: "x" })).toBe("Цвет кнопки");
    expect(
      pickTitle({ firstRequest: "<command-name>/x</command-name>\n\n  Сделай сайт\nподробно" }),
    ).toBe("Сделай сайт");
    expect(pickTitle({})).toBe(FALLBACK_TITLE);
  });

  it("is at most 120 characters", () => {
    expect(pickTitle({ firstRequest: "ж".repeat(300) })).toHaveLength(TITLE_MAX_CHARS);
  });
});
