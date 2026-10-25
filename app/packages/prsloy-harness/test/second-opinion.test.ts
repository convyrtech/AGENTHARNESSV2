import { describe, expect, it } from "vite-plus/test";
import {
  changedLines,
  CHEAT_KINDS,
  clipDiff,
  diffFacts,
  evidenceInDiff,
  parseVerdict,
  pickModel,
  remarks,
  reviewerFor,
  reviewersFor,
  reviewFailCard,
  reviewPrompt,
  reviewPushback,
} from "../src/second-opinion.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveReviewerModel } from "../src/reviewer.ts";
import { BUGGY_DIFF } from "./review-fixtures.ts";

describe("reviewer choice (ADR-7: writer and reviewer from different families)", () => {
  it("preference lists by family; unknown family — no review", () => {
    expect(reviewersFor("qwen3.8-max")).toEqual(["deepseek", "kimi", "claude-opus"]);
    expect(reviewersFor("claude-opus-5-5")).toEqual(["kimi", "deepseek", "qwen"]);
    expect(reviewersFor("deepseek-v4.1-flash-1017")).toEqual(["kimi", "qwen", "claude-opus"]);
    expect(reviewersFor("kimi-k3.1-pro")).toEqual(["deepseek", "qwen", "claude-opus"]);
    expect(reviewerFor("qwen3.8-max")).toBe("deepseek");
    expect(reviewersFor("mock")).toEqual([]);
  });

  it("the reviewer is the first preferred model that the session catalog has", () => {
    const at = (writer: string, ids: string[]) => {
      const models = ids.map((id) => ({ provider: "prsloy", id }));
      const ctx = {
        model: { provider: "prsloy", id: writer },
        modelRegistry: { getAll: () => models },
      } as unknown as ExtensionContext;
      return resolveReviewerModel(ctx, undefined)?.id;
    };
    const all = ["deepseek-v4.1-flash-1017", "kimi-k3.1-pro", "qwen3.8-max", "claude-opus-5-5"];
    expect(at("qwen3.8-max", all)).toBe("deepseek-v4.1-flash-1017");
    // каталог шлюза без deepseek → qwen проверяет kimi
    expect(
      at(
        "qwen3.8-max",
        all.filter((id) => !id.startsWith("deepseek")),
      ),
    ).toBe("kimi-k3.1-pro");
    expect(at("claude-opus-5-5", ["claude-opus-5-5", "qwen3.8-max"])).toBe("qwen3.8-max");
    expect(at("kimi-k3.1-pro", ["kimi-k3.1-pro", "claude-opus-5-5"])).toBe("claude-opus-5-5");
    // только своя семья — ревью нет
    expect(
      at("deepseek-v4.1-flash-1017", ["deepseek-v4.1-flash-1017", "deepseek-v4.2"]),
    ).toBeUndefined();
  });

  it("picks the gateway model by prefix (deepseek-v4.1-flash → deepseek-v4.1-flash-1017)", () => {
    const models = [{ id: "kimi-k3.1-pro" }, { id: "deepseek-v4.1-flash-1017" }];
    expect(pickModel(models, "deepseek-v4.1-flash")?.id).toBe("deepseek-v4.1-flash-1017");
    expect(pickModel(models, "kimi-k3.1-pro")?.id).toBe("kimi-k3.1-pro");
    expect(pickModel(models, "qwen")).toBeUndefined();
  });
});

describe("evidence check (no made-up remarks, as in second_opinion.py)", () => {
  it("a quoted diff line counts, with or without the +, whitespace-insensitive", () => {
    expect(evidenceInDiff("return a - b;", BUGGY_DIFF)).toBe(true);
    expect(evidenceInDiff("+  return a - b;", BUGGY_DIFF)).toBe(true);
    expect(evidenceInDiff("`return   a - b`", BUGGY_DIFF)).toBe(true);
    expect(evidenceInDiff("return a - b;", BUGGY_DIFF, "sum.js")).toBe(true);
  });

  it("a quote that is not in the diff, too short, or from another file does not count", () => {
    expect(evidenceInDiff("return a / b;", BUGGY_DIFF)).toBe(false);
    expect(evidenceInDiff("}", BUGGY_DIFF)).toBe(false);
    expect(evidenceInDiff("", BUGGY_DIFF)).toBe(false);
    const two = `${BUGGY_DIFF}diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n`;
    expect(evidenceInDiff("return a - b;", two, "b.js")).toBe(false);
    expect(evidenceInDiff("const x = 2;", two, "b.js")).toBe(true);
  });
});

describe("parseVerdict", () => {
  const fail = (evidence: string) =>
    JSON.stringify({
      verdict: "FAIL",
      items: [{ file: "sum.js", line: 2, problem: "sum вычитает", evidence }],
    });

  it("PASS stays PASS", () => {
    expect(parseVerdict('{"verdict":"PASS","items":[]}', BUGGY_DIFF)).toEqual({
      verdict: "PASS",
      items: [],
      rejected: 0,
    });
  });

  it("FAIL with a real quote is a FAIL", () => {
    const v = parseVerdict(fail("return a - b;"), BUGGY_DIFF);
    expect(v.verdict).toBe("FAIL");
    expect(v.items).toEqual([
      { file: "sum.js", line: 2, problem: "sum вычитает", evidence: "return a - b;" },
    ]);
  });

  it("FAIL with a made-up quote is a PASS", () => {
    expect(parseVerdict(fail("return a + b + 1;"), BUGGY_DIFF)).toMatchObject({
      verdict: "PASS",
      items: [],
      rejected: 1,
    });
  });

  it("FAIL without evidence is a PASS; only real items survive a mixed list", () => {
    const mixed = JSON.stringify({
      verdict: "FAIL",
      items: [
        { file: "sum.js", problem: "без цитаты" },
        { file: "sum.js", problem: "выдумка", evidence: "process.exit(1)" },
        { file: "b/sum.js", problem: "настоящая", evidence: "return a - b;" },
      ],
    });
    const v = parseVerdict(`Вот ответ:\n\`\`\`json\n${mixed}\n\`\`\``, BUGGY_DIFF);
    expect(v.items.map((i) => i.problem)).toEqual(["настоящая"]);
    expect(v.rejected).toBe(2);
  });

  it("not JSON → invalid PASS (the gate stays silent)", () => {
    expect(parseVerdict("Всё хорошо!", BUGGY_DIFF)).toMatchObject({
      verdict: "PASS",
      invalid: true,
    });
  });
});

describe("diff size and wording", () => {
  it("counts changed lines without file headers", () => {
    expect(changedLines(BUGGY_DIFF)).toBe(7);
    expect(changedLines("--- a/x\n+++ b/x\n@@\n-a\n+b\n")).toBe(2);
  });

  it("clips a large diff keeping each file's start and end", () => {
    const big = (name: string) =>
      `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${Array.from(
        { length: 2_000 },
        (_, i) => `+line ${name} ${i}`,
      ).join("\n")}\n`;
    const clipped = clipDiff(big("a.js") + big("b.js"), 10_000);
    expect(clipped.length).toBeLessThan(11_000);
    for (const marker of ["+line a.js 0", "+line a.js 1999", "+line b.js 0", "+line b.js 1999"])
      expect(clipped).toContain(marker);
    expect(clipDiff(BUGGY_DIFF)).toBe(BUGGY_DIFF);
  });

  it("prompt carries the task, the checks and the diff", () => {
    const prompt = reviewPrompt({
      task: "сделай sum",
      diff: BUGGY_DIFF,
      checks: "`npm test`: прошла",
    });
    expect(prompt).toContain("сделай sum");
    expect(prompt).toContain("`npm test`: прошла");
    expect(prompt).toContain("+  return a - b;");
    expect(prompt).toContain('"verdict":"PASS"|"FAIL"');
  });

  it("H-4: kinds of fitting, code facts about tests, and the user-asked exception in the prompt", () => {
    const patch = [
      "diff --git a/test.js b/test.js",
      "index 1..2 100644",
      "--- a/test.js",
      "+++ b/test.js",
      "@@ -1,3 +1,3 @@",
      " const assert = require('node:assert');",
      "-assert.strictEqual(sum(20, 5), 25);",
      "-assert.strictEqual(sum(1, 1), 2);",
      "+assert.ok(sum(20, 5) > 0);",
      "diff --git a/test_new.py b/test_new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test_new.py",
      "@@ -0,0 +1 @@",
      "+def test_x(): assert True",
      "",
    ].join("\n");
    expect(diffFacts(patch)).toEqual([
      "Файлы проверок в изменениях: test.js (был до хода: −2 / +1 строк), test_new.py (новый).",
      "В старых тестах проверок (assert/expect) стало меньше на 1.",
    ]);
    expect(diffFacts(BUGGY_DIFF)).toEqual(["Файлы проверок в изменениях: нет."]);
    const prompt = reviewPrompt({
      task: "почини sum",
      diff: patch,
      checks: "ok",
      signals: ["тронут старый тест test.js"],
      cheats: true,
    });
    for (const kind of CHEAT_KINDS) expect(prompt).toContain(`- ${kind}`);
    expect(prompt).toContain("Тест поменяли по прямой просьбе пользователя");
    expect(prompt).toContain("- В старых тестах проверок (assert/expect) стало меньше на 1.");
    expect(prompt).toContain("- тронут старый тест test.js");
    expect(reviewPrompt({ task: "x", diff: patch, checks: "ok" })).not.toContain("Подгонка");
  });

  it("H-4: a long diff keeps the test files whole, the code shares the rest", () => {
    const file = (name: string, n: number) =>
      `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${Array.from(
        { length: n },
        (_, i) => `+line ${name} ${i}`,
      ).join("\n")}\n`;
    // Пять файлов: обычная обрезка даёт каждому ~1 900 знаков — тест (~4 400) резался бы посередине.
    const code = ["a.js", "b.js", "c.js", "d.js"].map((n) => file(n, 500)).join("");
    const patch = code + file("app.test.js", 200);
    const plain = clipDiff(patch, 10_000);
    expect(plain).not.toContain("+line app.test.js 100");
    const tests = clipDiff(patch, 10_000, true);
    expect(tests.startsWith("diff --git a/app.test.js")).toBe(true);
    for (let i = 0; i < 200; i++) expect(tests).toContain(`+line app.test.js ${i}\n`);
    for (const marker of ["+line a.js 0", "+line a.js 499", "+line c.js 0"])
      expect(tests).toContain(marker);
    expect(tests.length).toBeLessThan(11_000);
    // Тесты больше половины лимита — тоже первыми, но обрезаются, как все.
    const huge = clipDiff(file("app.js", 2_000) + file("app.test.js", 2_000), 10_000, true);
    expect(huge.startsWith("diff --git a/app.test.js")).toBe(true);
    expect(huge.length).toBeLessThan(11_000);
  });

  it("Russian plural in the card", () => {
    expect([1, 2, 5, 11, 21, 22].map(remarks)).toEqual([
      "1 замечание",
      "2 замечания",
      "5 замечаний",
      "11 замечаний",
      "21 замечание",
      "22 замечания",
    ]);
    expect(reviewFailCard(2)).toBe("Вторая модель нашла 2 замечания — исправляю");
    expect(
      reviewPushback([{ file: "sum.js", line: 2, problem: "вычитает", evidence: "return a - b;" }]),
    ).toContain("1. sum.js:2 — вычитает\n   Строка: `return a - b;`");
  });
});
