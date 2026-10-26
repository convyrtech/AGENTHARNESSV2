// A/B одного флага (scripts/ab.mts, 26.10): таблица из двух прогонов — по наборам и «всего»; сбой шлюза отдельно;
// цена неизвестна, если у задачи с токенами нет цены; доля токенов второго мнения.
import { describe, expect, it } from "vite-plus/test";
import { abMarkdown, abRows } from "../bench/lib/ab.ts";
import { emptyUsage } from "../bench/lib/meter.ts";
import type { BenchReport, TaskResult } from "../bench/run.ts";

const count = (calls: number, input: number, output: number) => ({
  calls,
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

function result(id: string, outcome: TaskResult["outcome"], review = 0, rub: number | null = 1) {
  const tokens = {
    ...emptyUsage(),
    ...count(2, 100 + review, 20),
    bySource: { agent: count(1, 100, 20) },
  };
  if (review) Object.assign(tokens.bySource, { review: count(1, review, 0) });
  return { id, outcome, seconds: 10, tokens, rub } as unknown as TaskResult;
}

const report = (results: TaskResult[]) => ({ results }) as unknown as BenchReport;

describe("A/B table", () => {
  it("rows per suite and in total; infra_error apart; the review share of tokens", () => {
    const on = report([
      result("fix-discount", "solved", 120),
      result("visit-card", "false_done", 120),
      result("wrong-test/v2", "cheat", 120),
      result("blocked-download/v1", "infra_error", 0),
    ]);
    const off = report([
      result("fix-discount", "solved"),
      result("visit-card", "solved"),
      result("wrong-test/v2", "cheat"),
      result("blocked-download/v1", "honest_fail"),
    ]);
    const suiteOf = (id: string) => (id.includes("/") ? "honesty" : "casual");
    const rows = abRows(
      [
        { name: "вкл", report: on },
        { name: "выкл", report: off },
      ],
      suiteOf,
    );
    expect(
      rows.map((r) => [r.suite, r.variant, r.tasks, r.solved, r.falseDone, r.cheat, r.infra]),
    ).toEqual([
      ["casual", "вкл", 2, 1, 1, 0, 0],
      ["casual", "выкл", 2, 2, 0, 0, 0],
      ["honesty", "вкл", 2, 0, 0, 1, 1],
      ["honesty", "выкл", 2, 0, 0, 1, 0],
      ["всего", "вкл", 4, 1, 1, 1, 1],
      ["всего", "выкл", 4, 2, 0, 1, 0],
    ]);
    const all = rows.find((r) => r.suite === "всего" && r.variant === "вкл")!;
    // Вход 3 × 220 + 100 = 760, выход 80 — всего 840; на ревью 3 × 120 = 360.
    expect(all.reviewShare).toBeCloseTo(360 / 840);
    expect(all.seconds).toBe(40);
    expect(all.rub).toBe(4);
    const md = abMarkdown("A/B «review»", rows, [{ variant: "выкл", message: "бюджет исчерпан" }]);
    expect(md).toContain("| всего | вкл | 4 | 1 | 1 | 1 | 1 | 40 | 760/80/0+0 | 4.00 | 43% |");
    expect(md).toContain("**Прогон «выкл» остановлен: бюджет исчерпан.**");
  });

  it("unknown price stays unknown", () => {
    const rows = abRows(
      [{ name: "вкл", report: report([result("a", "solved", 0, null)]) }],
      () => "casual",
    );
    expect(rows[0]!.rub).toBeNull();
    expect(abMarkdown("x", rows)).toContain("цена неизвестна");
  });
});
