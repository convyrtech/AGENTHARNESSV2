import { describe, expect, it } from "vite-plus/test";
import { rollPieces } from "./roll-text.ts";

const keys = (text: string) => rollPieces(text).map((piece) => piece.key);

describe("rollPieces", () => {
  it("keeps the text as it is, marking the digits", () => {
    const pieces = rollPieces("12 мин");
    expect(pieces.map((piece) => piece.text).join("")).toBe("12 мин");
    expect(pieces.filter((piece) => piece.digit).map((piece) => piece.text)).toEqual(["1", "2"]);
  });

  it("only a changed digit gets a new key", () => {
    const before = new Set(keys("осталось ~15 мин"));
    const changed = keys("осталось ~14 мин").filter((key) => !before.has(key));
    expect(changed).toEqual(["4:4"]);
  });

  it("9 → 10: the 0 rolls in place of the 9 and the 1 is new; the words stay", () => {
    const before = new Set(keys("9 мин"));
    const changed = keys("10 мин").filter((key) => !before.has(key));
    expect(changed).toEqual(["5:1", "4:0"]);
  });

  it("a ruble amount rolls by digit, the separator stays", () => {
    const before = new Set(keys("ход 1,20 ₽"));
    const changed = keys("ход 1,35 ₽").filter((key) => !before.has(key));
    expect(changed).toEqual(["3:3", "2:5"]);
  });
});
