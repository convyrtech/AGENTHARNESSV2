import { describe, expect, it } from "vite-plus/test";
import { asksKimiToImplement } from "./explicit-kimi.ts";

describe("explicit Kimi implementation request", () => {
  it.each([
    "В сообщениях после обрезки появляется �. Пусть Кими сделает правку.",
    "Поручи правку Kimi, потом проверь.",
    "Передай эту задачу Кими.",
    "Попроси Кими исправить это.",
    "Have Kimi fix this.",
    "Кими, исправь это.",
    "Kimi, fix this.",
  ])("accepts a direct instruction: %s", (prompt) => {
    expect(asksKimiToImplement(prompt)).toBe(true);
  });

  it.each([
    "Кими раньше помогал с этой задачей.",
    "Не поручай эту задачу Кими.",
    "Проанализируй цитату: «Пусть Кими сделает правку».",
    "Проанализируй цитату: «Это пример. Пусть Кими сделает правку».",
    "> Пусть Кими сделает правку.",
    "```text\nПусть Кими сделает правку.\n```",
    "Сравни ответы Кими и MiniMax.",
    "Попроси Кими проверить ответ.",
  ])("ignores a mention or quotation: %s", (prompt) => {
    expect(asksKimiToImplement(prompt)).toBe(false);
  });
});
