import { describe, expect, it } from "vite-plus/test";
import {
  changedLines,
  clipDiff,
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
