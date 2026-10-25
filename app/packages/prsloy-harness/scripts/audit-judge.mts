// Разборщик сессий, A-2 (research/24 §6, research/23 §5.2–§5.3): судья по классам, только где в окончательной
// разметке ≥ 30 положительных. Прогон — на замороженной половине test, один раз на версию судьи.
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/audit-judge.mts --sessions <корпус> … \
//     --findings audit-out/findings.jsonl --labelset labels/labelset.jsonl \
//     --a labels/labels-conductor.jsonl --b labels/labels-kimi-k3.1-pro.jsonl [--owner labels/labels-owner.jsonl] \
//     --model <судья: семья ≠ семей разметчиков> [--second <третья семья>] [--split test|dev] --out judge-out
//   … --dry-run        поддельный судья, без сети (проверка скрипта)
//   … --min 30         порог положительных для включения класса
// Выход: JUDGE.md (P/R по классам, без цитат), judge-classes.json (confirmed / shadow — для audit-sessions),
// judge-calls.jsonl (класс, ключ, вердикт, вызовов; без цитат).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import type { AuditClass, Finding } from "../src/audit/detectors.ts";
import { loadSessions, parseLines } from "../src/audit/ir.ts";
import { CLASSES, fakeJudge, judgeSession, type Model } from "../src/audit/judge.ts";
import {
  goldLabels,
  judgeableClasses,
  scoreJudge,
  type Label,
  type LabelItem,
} from "../src/audit/labels.ts";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", multiple: true, default: [] },
    findings: { type: "string" },
    labelset: { type: "string" },
    a: { type: "string", multiple: true, default: [] },
    b: { type: "string", multiple: true, default: [] },
    owner: { type: "string", multiple: true, default: [] },
    model: { type: "string" },
    second: { type: "string" },
    "base-url": { type: "string" },
    split: { type: "string", default: "test" },
    min: { type: "string", default: "30" },
    out: { type: "string", default: "judge-out" },
    "dry-run": { type: "boolean", default: false },
  },
});

const readJsonl = <T,>(file: string | undefined): T[] =>
  file && existsSync(file) ? (parseLines(readFileSync(file, "utf8")) as T[]) : [];
/** Несколько файлов меток одного разметчика (REVIEW.md + модель): по ключу побеждает файл, указанный позже. */
const mergeLabels = (files: readonly string[]): Label[] => [
  ...new Map(files.flatMap((f) => readJsonl<Label>(f)).map((l) => [l.key, l])).values(),
];
for (const [name, v] of [
  ["sessions", values.sessions.length ? 1 : undefined],
  ["labelset", values.labelset],
  ["a", values.a.length ? 1 : undefined],
  ["b", values.b.length ? 1 : undefined],
] as const) {
  if (!v) {
    console.error(`нужен --${name}`);
    process.exit(2);
  }
}
if (!values["dry-run"] && !values.model) {
  console.error("нужен --model (судья другой семьи, чем разметчики) или --dry-run");
  process.exit(2);
}

function gatewayModel(model: string): Model {
  const baseUrl = (values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY;
  if (!key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY (или --dry-run).");
    process.exit(2);
  }
  return async (prompt) => {
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (r.ok) {
        const body = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        return body.choices?.[0]?.message?.content ?? "";
      }
      if (attempt >= 3 || r.status < 500) {
        throw new Error(`chat/completions: ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
      await new Promise((ok) => setTimeout(ok, 2000 * attempt));
    }
  };
}

const split = values.split === "dev" ? "dev" : "test";
const items = readJsonl<LabelItem>(values.labelset);
const gold = goldLabels(mergeLabels(values.a), mergeLabels(values.b), mergeLabels(values.owner));
const min = Number(values.min);
const classes = judgeableClasses(items, gold, min);
const findings = readJsonl<Finding>(values.findings);
const sessions = new Map(
  values.sessions.flatMap((dir) => loadSessions(dir)).map((s) => [s.file, s]),
);
const primary = values["dry-run"] ? fakeJudge() : gatewayModel(values.model!);
const second = values["dry-run"]
  ? undefined
  : values.second
    ? gatewayModel(values.second)
    : undefined;

mkdirSync(values.out, { recursive: true });
const predicted = new Map<string, boolean>();
const calls: unknown[] = [];
let disputed = 0;
for (const item of items) {
  if (item.kind !== "session" || item.split !== split || !classes.includes(item.class)) continue;
  if (!gold.has(item.key)) continue;
  const s = sessions.get(item.file);
  if (!s) continue;
  const j = await judgeSession(s, item.class, findings, primary, second);
  if (j.status === "disputed") disputed += 1;
  // «Спорно» засчитываем как «нет проблемы»: судья по умолчанию молчит.
  predicted.set(item.key, j.status === "issue");
  calls.push({
    key: item.key,
    class: item.class,
    status: j.status,
    step: j.step,
    fault: j.fault,
    calls: j.calls,
  });
}

const scores = classes.map((k) => scoreJudge(items, gold, predicted, k, split));
const positives = (k: AuditClass) =>
  items.filter((i) => i.class === k && gold.get(i.key) === "yes").length;
const allClasses = Object.keys(CLASSES) as AuditClass[];
const md = [
  "# Судья по классам (A-2)",
  "",
  `Судья: ${values["dry-run"] ? "поддельный (--dry-run)" : values.model}${values.second ? `, эскалация: ${values.second}` : ""}. Половина: ${split}. Порог включения: ≥ ${min} положительных.`,
  `Пунктов судили: ${predicted.size}, спорных (к человеку): ${disputed}.`,
  "",
  "| Класс | Положительных в разметке | Судим? | TP | FP | FN | P | R | Статус |",
  "|---|---|---|---|---|---|---|---|---|",
  ...allClasses.map((k) => {
    const sc = scores.find((x) => x.klass === k);
    return sc
      ? `| ${k} ${CLASSES[k].name} | ${positives(k)} | да | ${sc.tp} | ${sc.fp} | ${sc.fn} | ${sc.precision.toFixed(2)} | ${sc.recall.toFixed(2)} | ${sc.status} |`
      : `| ${k} ${CLASSES[k].name} | ${positives(k)} | нет (< ${min}) | | | | | | ждёт |`;
  }),
  "",
  "confirmed — P ≥ 0,80 и R ≥ 0,60; иначе shadow (в отчёт с пометкой «проверить», не в уроки).",
].join("\n");
writeFileSync(join(values.out, "JUDGE.md"), `${md}\n`);
writeFileSync(
  join(values.out, "judge-classes.json"),
  `${JSON.stringify(Object.fromEntries(scores.map((s) => [s.klass, s.status])), null, 2)}\n`,
);
writeFileSync(
  join(values.out, "judge-calls.jsonl"),
  calls.map((c) => JSON.stringify(c)).join("\n") + (calls.length ? "\n" : ""),
);
console.log(md);
