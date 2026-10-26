// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  markAnswered,
  parseTestsOutdated,
  quoteIsLong,
  readAnswered,
  testsOutdatedKey,
} from "./tests-outdated-card.ts";

const details = {
  files: ["tests/price.test.js", "tests/price.test.js", ""],
  quote: "expect(price(100)).toBe(90)",
  request: "скидка 15%",
  actions: [
    { label: "Обновить тесты", prompt: "Обнови тесты под новое правило: скидка 15%" },
    { label: "Оставить как есть" },
    { label: "" },
  ],
};

describe("tests-outdated card (#25)", () => {
  beforeEach(() => localStorage.clear());

  it("reads files, the quote, the request and the buttons; drops junk", () => {
    expect(parseTestsOutdated(details)).toEqual({
      files: ["tests/price.test.js"],
      quote: "expect(price(100)).toBe(90)",
      request: "скидка 15%",
      actions: [
        { label: "Обновить тесты", prompt: "Обнови тесты под новое правило: скидка 15%" },
        { label: "Оставить как есть" },
      ],
    });
    expect(parseTestsOutdated({ ...details, quote: undefined })?.quote).toBe("");
    expect(parseTestsOutdated({ files: [], actions: [] })).toBeUndefined();
    expect(parseTestsOutdated(null)).toBeUndefined();
  });

  it("folds a long or many-line quote", () => {
    expect(quoteIsLong("expect(a).toBe(1)")).toBe(false);
    expect(quoteIsLong("x".repeat(200))).toBe(true);
    expect(quoteIsLong("a\nb\nc\nd")).toBe(true);
  });

  it("remembers the answer for the same card", () => {
    const key = testsOutdatedKey(parseTestsOutdated(details)!);
    expect(readAnswered(key)).toBeUndefined();
    markAnswered(key, "Оставить как есть");
    expect(readAnswered(key)).toBe("Оставить как есть");
  });
});
