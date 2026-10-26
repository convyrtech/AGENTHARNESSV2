// A/B одного флага (дирижёр, 26.10): два прогона одного набора — флаг вкл и выкл — и одна таблица. Правило владельца:
// любой замер = решено + время + токены/₽, только факты. Строки — по набору задачи (casual, honesty…) и «всего»;
// задачи со сбоем шлюза (infra_error) не в счёте решённых и провалов, их число — отдельной колонкой.
import { addUsage, emptyUsage, type TokenUsage } from "./meter.ts";
import type { BenchReport, TaskResult } from "../run.ts";

export interface AbRow {
  suite: string;
  variant: string;
  tasks: number;
  solved: number;
  falseDone: number;
  cheat: number;
  infra: number;
  seconds: number;
  tokens: TokenUsage;
  /** ₽; null — цена неизвестна. */
  rub: number | null;
  /** Доля токенов (вход + выход) второго мнения. */
  reviewShare: number;
}

export function abRow(suite: string, variant: string, results: TaskResult[]): AbRow {
  const tokens = emptyUsage();
  for (const r of results) if (r.tokens) addUsage(tokens, r.tokens);
  const count = (o: TaskResult["outcome"]) => results.filter((r) => r.outcome === o).length;
  const all = tokens.input + tokens.output;
  const review = tokens.bySource.review;
  return {
    suite,
    variant,
    tasks: results.length,
    solved: count("solved"),
    falseDone: count("false_done"),
    cheat: count("cheat"),
    infra: count("infra_error"),
    seconds: Math.round(results.reduce((n, r) => n + r.seconds, 0)),
    tokens,
    rub: results.some((r) => r.tokens && r.rub === null)
      ? null
      : results.reduce((n, r) => n + (r.rub ?? 0), 0),
    reviewShare: all ? (review ? review.input + review.output : 0) / all : 0,
  };
}

/** Строки по наборам и «всего» для каждого варианта; `suiteOf` — набор задачи по её id. */
export function abRows(
  variants: { name: string; report: BenchReport }[],
  suiteOf: (id: string) => string,
): AbRow[] {
  const suites = [
    ...new Set(variants.flatMap((v) => v.report.results.map((r) => suiteOf(r.id)))),
  ].sort();
  const rows: AbRow[] = [];
  for (const suite of [...suites, ...(suites.length > 1 ? ["всего"] : [])])
    for (const { name, report } of variants)
      rows.push(
        abRow(
          suite,
          name,
          suite === "всего"
            ? report.results
            : report.results.filter((r) => suiteOf(r.id) === suite),
        ),
      );
  return rows;
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

export function abMarkdown(
  title: string,
  rows: AbRow[],
  stopped: { variant: string; message: string }[] = [],
): string {
  return [
    `# ${title}`,
    "",
    "| набор | вариант | задач | решено | ложное «готово» | жульничество | сбой шлюза | время, с | токены вх/вых/кэш | ₽ | доля токенов на ревью |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.suite} | ${r.variant} | ${r.tasks} | ${r.solved} | ${r.falseDone} | ${r.cheat} | ${r.infra} | ${r.seconds} | ${k(r.tokens.input)}/${k(r.tokens.output)}/${k(r.tokens.cacheRead)}+${k(r.tokens.cacheWrite)} | ${r.rub === null ? "цена неизвестна" : r.rub.toFixed(2)} | ${Math.round(r.reviewShare * 100)}% |`,
    ),
    "",
    "Сбой шлюза (infra_error) не в счёте решённых и провалов; ₽ — по bench/prices.json.",
    ...stopped.map((s) => `**Прогон «${s.variant}» остановлен: ${s.message}.**`),
    "",
  ].join("\n");
}
