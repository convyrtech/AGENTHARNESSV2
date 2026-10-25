import { describe, expect, it } from "vite-plus/test";
import { graphemes, MAX_NAME, safeName, withSuffix } from "./safe-name.ts";

const safe = (raw: string) => safeName(raw, { fallback: "Проект" });

describe("safeName (Windows rules)", () => {
  it("renames reserved device names, with any extension and any case", () => {
    for (const name of ["CON", "prn", "Aux", "NUL", "com1", "COM9", "lpt1", "LPT9", "COM¹"]) {
      expect(safe(name), name).toBe(`_${name}`);
    }
    expect(safe("nul.txt")).toBe("_nul.txt");
    expect(safe("con.tar.gz")).toBe("_con.tar.gz");
    expect(safe("CONSOLE")).toBe("CONSOLE");
    expect(safe("com10")).toBe("com10");
    expect(safe("Конференция")).toBe("Конференция");
  });

  it("drops dots and spaces at the ends: Windows would make it another folder", () => {
    expect(safe("Сайт.")).toBe("Сайт");
    expect(safe("Сайт . . ")).toBe("Сайт");
    expect(safe("  Сайт  ")).toBe("Сайт");
    expect(safe(".hidden")).toBe("hidden");
    expect(safe("v1.2 сайт")).toBe("v1.2 сайт");
  });

  it("never «.» or «..» or empty", () => {
    expect(safe(".")).toBe("Проект");
    expect(safe("..")).toBe("Проект");
    expect(safe("   ")).toBe("Проект");
    expect(safe("<>:")).toBe("Проект");
  });

  it("refuses characters Windows refuses and control characters", () => {
    expect(safe('a\\b/c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(safe("Бот\u0000\u0007\nдоставки\u007f")).toBe("Бот доставки");
    expect(safeName("a:b", { fallback: "x", replacement: "-" })).toBe("a-b");
  });

  it("keeps to 80 characters, by letters, without a trailing dot after the cut", () => {
    expect(graphemes(safe("я".repeat(200)))).toHaveLength(MAX_NAME);
    expect(safe(`${"а".repeat(79)}.б`)).toBe("а".repeat(79));
    expect(graphemes(safe("😀".repeat(100)))).toHaveLength(MAX_NAME);
  });

  it("a numbered name stays within the limit", () => {
    expect(withSuffix("Бот", 2)).toBe("Бот 2");
    const long = withSuffix("я".repeat(MAX_NAME), 12);
    expect(graphemes(long)).toHaveLength(MAX_NAME);
    expect(long.endsWith(" 12")).toBe(true);
    expect(withSuffix(`${"а".repeat(77)}. `, 2)).toBe(`${"а".repeat(77)} 2`);
  });
});
