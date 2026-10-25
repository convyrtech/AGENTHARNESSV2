// Разборщик сессий, A-1 (research/24 §6): контрольный набор и разметка, файлами. Метки и набор — вне git.
//
// 1) Набор: все находки кода + случайные сессии × классы, dev/test по сессиям 50/50 (заморожен):
//   node packages/prsloy-harness/scripts/audit-label.mts build --sessions <корпус> … \
//     --findings audit-out/findings.jsonl --sample 30 --seed 7 --out labels
// 2) Метки дирижёра из ручного просмотра (столбец «Верно?» в REVIEW.md того же прогона):
//   … review --findings audit-out/findings.jsonl --review audit-out/REVIEW.md --by conductor --out labels
// 3) Разметчики-модели через шлюз (ключ в PRSLOY_GATEWAY_KEY). Пункты «сессия × класс» (есть ли сбой) размечают
//    оба: разметчик 1 — модель семьи Claude (дирижёр), разметчик 2 — другой семьи (kimi или gpt). Находки
//    разметчик 1 может взять и из своего REVIEW.md (шаг 2): `--a labels-claude….jsonl --a labels-conductor.jsonl`
//    сливает файлы, по ключу побеждает указанный позже (ручная метка поверх модельной).
//    Судья A-2 потом — третьей семьи.
//   … label --sessions <корпус> … --findings audit-out/findings.jsonl --labelset labels/labelset.jsonl \
//     --model kimi-k3.1-pro --out labels               (--dry-run — поддельная модель, без сети)
// 4) Согласие: κ и спорное — владельцу:
//   … kappa --labelset labels/labelset.jsonl --a labels/labels-conductor.jsonl --b labels/labels-kimi-k3.1-pro.jsonl \
//     [--owner labels/labels-owner.jsonl] --findings audit-out/findings.jsonl --out labels
//   → KAPPA.md (без цитат) и DISPUTED.md (с цитатами находок — только локально).
// 5) Решения владельца по спорному (заполненный DISPUTED.md):
//   … owner --disputed labels/DISPUTED.md --out labels   → labels/labels-owner.jsonl
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import type { Finding } from "../src/audit/detectors.ts";
import { loadSessions, parseLines, type Session } from "../src/audit/ir.ts";
import {
  fakeJudge,
  judgePrompt,
  parseVerdict,
  quoteHolds,
  type Model,
} from "../src/audit/judge.ts";
import {
  agreement,
  buildLabelset,
  findingKey,
  labelsFromDisputed,
  labelsFromReview,
  type Label,
  type LabelItem,
} from "../src/audit/labels.ts";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    sessions: { type: "string", multiple: true, default: [] },
    findings: { type: "string" },
    labelset: { type: "string" },
    review: { type: "string" },
    by: { type: "string", default: "conductor" },
    sample: { type: "string", default: "30" },
    seed: { type: "string", default: "7" },
    model: { type: "string" },
    "base-url": { type: "string" },
    a: { type: "string", multiple: true, default: [] },
    b: { type: "string", multiple: true, default: [] },
    owner: { type: "string", multiple: true, default: [] },
    disputed: { type: "string" },
    out: { type: "string", default: "labels" },
    "dry-run": { type: "boolean", default: false },
  },
});

const readJsonl = <T,>(file: string | undefined): T[] =>
  file && existsSync(file) ? (parseLines(readFileSync(file, "utf8")) as T[]) : [];
/** Несколько файлов меток одного разметчика (REVIEW.md + модель): по ключу побеждает файл, указанный позже. */
const mergeLabels = (files: readonly string[]): Label[] => [
  ...new Map(files.flatMap((f) => readJsonl<Label>(f)).map((l) => [l.key, l])).values(),
];
const writeJsonl = (file: string, rows: readonly unknown[]) =>
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
const need = (name: string, v: unknown) => {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) {
    console.error(`${command}: нужен --${name}`);
    process.exit(2);
  }
};
const now = () => new Date().toISOString();

mkdirSync(values.out, { recursive: true });
const findings = readJsonl<Finding & { id?: string }>(values.findings);

function sessionsByFile(): Map<string, Session> {
  const all = values.sessions.flatMap((dir) => loadSessions(dir));
  return new Map(all.map((s) => [s.file, s]));
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

if (command === "build") {
  need("sessions", values.sessions);
  need("findings", values.findings);
  const sessions = [...sessionsByFile().values()];
  const items = buildLabelset(sessions, findings, {
    sample: Number(values.sample),
    seed: Number(values.seed),
  });
  const file = join(values.out, "labelset.jsonl");
  if (existsSync(file)) {
    console.error(`${file} уже есть: набор заморожен. Новый — в другую папку --out.`);
    process.exit(2);
  }
  writeJsonl(file, items);
  const f = items.filter((i) => i.kind === "finding").length;
  console.log(
    `${file}: ${items.length} пунктов (находок ${f}, сессия×класс ${items.length - f}; test ${items.filter((i) => i.split === "test").length})`,
  );
} else if (command === "review") {
  need("findings", values.findings);
  need("review", values.review);
  const labels = labelsFromReview(
    readFileSync(values.review!, "utf8"),
    findings,
    values.by!,
    now(),
  );
  const file = join(values.out, `labels-${values.by}.jsonl`);
  writeJsonl(file, labels);
  const yes = labels.filter((l) => l.label === "yes").length;
  console.log(
    `${file}: ${labels.length} меток (верных ${yes}, неверных ${labels.filter((l) => l.label === "no").length}, не уверен ${labels.length - yes - labels.filter((l) => l.label === "no").length})`,
  );
} else if (command === "label") {
  need("sessions", values.sessions);
  need("labelset", values.labelset);
  if (!values["dry-run"]) need("model", values.model);
  const by = values["dry-run"] ? "dry-run" : values.model!;
  const model = values["dry-run"] ? fakeJudge() : gatewayModel(values.model!);
  const items = readJsonl<LabelItem>(values.labelset);
  const sessions = sessionsByFile();
  const file = join(values.out, `labels-${by.replace(/[^\w.-]+/g, "_")}.jsonl`);
  // Продолжение после обрыва: уже размеченные ключи пропускаются.
  const done = new Set(readJsonl<Label>(file).map((l) => l.key));
  const out = readJsonl<Label>(file);
  let calls = 0;
  for (const item of items) {
    if (done.has(item.key)) continue;
    const s = sessions.get(item.file);
    if (!s) continue;
    // Находку разметчик видит одну — как подсказку; сессию × класс — со всеми находками этой сессии.
    const hints = findings.filter(
      (f) => f.file === s.file && (item.kind === "session" || f.sig === item.sig),
    );
    const v = parseVerdict(await model(judgePrompt(s, item.class, hints)));
    calls += 1;
    const ok = v.verdict === "ISSUE" && quoteHolds(s, v);
    let label: Label["label"];
    if (item.kind === "finding")
      label = ok && item.steps?.includes(v.step!) ? "yes" : ok ? "unsure" : "no";
    else label = ok ? "yes" : "no";
    out.push({ key: item.key, by, label, ...(ok && v.step ? { step: v.step } : {}), ts: now() });
    if (calls % 10 === 0) writeJsonl(file, out);
  }
  writeJsonl(file, out);
  console.log(`${file}: ${out.length} меток, вызовов модели ${calls}`);
} else if (command === "kappa") {
  need("labelset", values.labelset);
  need("a", values.a);
  need("b", values.b);
  const items = readJsonl<LabelItem>(values.labelset);
  const a = mergeLabels(values.a);
  const b = mergeLabels(values.b);
  const ag = agreement(items, a, b);
  const pass = ag.kappa >= 0.7 ? "приёмка взята" : "ниже приёмки (0,7)";
  const md = [
    "# Согласие разметчиков (A-1)",
    "",
    `${a[0]?.by ?? "a"} × ${b[0]?.by ?? "b"}: общих пунктов ${ag.n}, κ = ${ag.kappa.toFixed(2)} — ${pass}.`,
    "",
    "| Класс | Пунктов | κ |",
    "|---|---|---|",
    ...Object.entries(ag.byClass).map(([k, v]) => `| ${k} | ${v!.n} | ${v!.kappa.toFixed(2)} |`),
    "",
    `Спорных (расхождение или «не уверен»): ${ag.disputed.length} — в DISPUTED.md, владельцу.`,
  ].join("\n");
  writeFileSync(join(values.out, "KAPPA.md"), `${md}\n`);
  const la = new Map(a.map((l) => [l.key, l]));
  const lb = new Map(b.map((l) => [l.key, l]));
  const byKey = new Map(items.map((i) => [i.key, i]));
  const findingByKey = new Map(findings.map((f) => [findingKey(f), f]));
  const cell = (x: string) => x.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200);
  const disputed = [
    "# Спорное — решает владелец (цитаты — не в git)",
    "",
    "Впишите в последний столбец «да» (сбой есть / находка верна), «нет» или «?».",
    "",
    "| Ключ | Класс | Что | Разметчик A | Разметчик B | Владелец |",
    "|---|---|---|---|---|---|",
    ...ag.disputed.map((key) => {
      const item = byKey.get(key)!;
      const f = findingByKey.get(key);
      const what = f
        ? f.evidence.map((e) => ("quote" in e ? `[${e.step}] «${e.quote}»` : e.absent)).join(" · ")
        : `сессия ${item.session.slice(0, 13)}: есть ли сбой класса`;
      const show = (l?: Label) => (l ? `${l.label}${l.step ? ` ${l.step}` : ""}` : "—");
      return `| ${key} | ${item.class} | ${cell(what)} | ${show(la.get(key))} | ${show(lb.get(key))} | |`;
    }),
  ].join("\n");
  writeFileSync(join(values.out, "DISPUTED.md"), `${disputed}\n`);
  console.log(md);
} else if (command === "owner") {
  need("disputed", values.disputed);
  const labels = labelsFromDisputed(readFileSync(values.disputed!, "utf8"), "owner", now());
  writeJsonl(join(values.out, "labels-owner.jsonl"), labels);
  console.log(`labels-owner.jsonl: ${labels.length} решений владельца`);
} else {
  console.error("команды: build | review | label | kappa | owner (см. шапку файла)");
  process.exit(2);
}
