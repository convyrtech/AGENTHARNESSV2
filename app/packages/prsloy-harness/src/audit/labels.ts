// Разборщик сессий, A-1 (research/24 §6, research/23 §5.3): контрольный набор, разметка, согласие разметчиков.
// Разметка — файлами (labelset.jsonl, labels-<кто>.jsonl), без сервера. Файлы с метками живут вне git: в них
// ссылки на сессии; цитат в метках нет, цитаты — только в REVIEW.md / DISPUTED.md на машине разметчика.
import type { AuditClass, Finding } from "./detectors.ts";
import type { Session } from "./ir.ts";

export const ALL_CLASSES: readonly AuditClass[] = [
  "K1",
  "K2",
  "K3",
  "K4",
  "K5",
  "K6",
  "K7",
  "K8",
  "K9",
  "K10",
  "K11",
  "K12",
];

/** Что размечаем: находку кода (верна ли) или пару «сессия × класс» (есть ли сбой этого класса). */
export interface LabelItem {
  /** Устойчивый ключ: не зависит от id находки, который меняется от прогона к прогону. */
  key: string;
  kind: "finding" | "session";
  session: string;
  file: string;
  class: AuditClass;
  sig?: string;
  /** Шаги из доказательства находки. */
  steps?: string[];
  /** dev — можно смотреть и подкручивать судью; test — заморожен, один прогон на версию судьи. */
  split: "dev" | "test";
}

export type LabelValue = "yes" | "no" | "unsure";

export interface Label {
  key: string;
  /** Кто: conductor, owner, имя модели. */
  by: string;
  label: LabelValue;
  /** Шаг, на который указал разметчик (для «yes» у сессии). */
  step?: string;
  ts: string;
}

/** Ссылка на файл сессии, одинаковая на любой машине и уникальная в корпусе: последние три части пути
 * (`bench-out/sessions/visit-card/2026-…​.jsonl` → `sessions/visit-card/2026-….jsonl`). Имя файла одно не годится:
 * у стенда и дизайна много сессий с одинаковыми именами. */
export const sessionRef = (file: string) => file.split(/[\\/]/).filter(Boolean).slice(-3).join("/");

export function findingKey(f: Pick<Finding, "file" | "sig" | "evidence">): string {
  const step = f.evidence.find((e) => "step" in e) as { step: string } | undefined;
  return `F#${sessionRef(f.file)}#${f.sig}#${step?.step ?? "-"}`;
}

export const sessionKey = (s: Pick<Session, "file">, klass: AuditClass) =>
  `S#${sessionRef(s.file)}#${klass}`;

/** Детерминированный ГПСЧ (mulberry32): одна и та же выборка при том же seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** dev/test по сессии, 50/50 (research/23 §5.3): все пункты одной сессии — в одной половине. */
export function splitOf(file: string, seed: number): "dev" | "test" {
  let h = seed >>> 0;
  for (const ch of sessionRef(file)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 2 === 0 ? "dev" : "test";
}

export interface BuildOptions {
  /** Сколько случайных сессий разметить по всем классам (полнота). */
  sample: number;
  seed: number;
  classes?: readonly AuditClass[];
}

/** Набор для разметки: все находки кода, сессия × класс каждой находки и случайные сессии × все классы.
 * Дубликаты ключей схлопываются. */
export function buildLabelset(
  sessions: readonly Session[],
  findings: readonly Finding[],
  options: BuildOptions,
): LabelItem[] {
  const items = new Map<string, LabelItem>();
  for (const f of findings) {
    const key = findingKey(f);
    if (items.has(key)) continue;
    items.set(key, {
      key,
      kind: "finding",
      session: f.session,
      file: f.file,
      class: f.class,
      sig: f.sig,
      steps: f.evidence.flatMap((e) => ("step" in e ? [e.step] : [])),
      split: splitOf(f.file, options.seed),
    });
  }
  // Сессия × класс для каждой находки: так у судьи есть положительные примеры, а не только случайные сессии.
  for (const f of findings) {
    const key = sessionKey(f, f.class);
    if (items.has(key)) continue;
    items.set(key, {
      key,
      kind: "session",
      session: f.session,
      file: f.file,
      class: f.class,
      split: splitOf(f.file, options.seed),
    });
  }
  const random = rng(options.seed);
  const pool = [...sessions].sort((a, b) => a.file.localeCompare(b.file));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  for (const s of pool.slice(0, options.sample)) {
    for (const klass of options.classes ?? ALL_CLASSES) {
      const key = sessionKey(s, klass);
      items.set(key, {
        key,
        kind: "session",
        session: s.id,
        file: s.file,
        class: klass,
        split: splitOf(s.file, options.seed),
      });
    }
  }
  return [...items.values()];
}

/**
 * Метки дирижёра из REVIEW.md (столбец «Верно?»: да / нет / ?). Строки сопоставляются с находками по id
 * (F-…), потому что REVIEW.md и findings.jsonl одного прогона.
 */
export function labelsFromReview(
  md: string,
  findings: readonly (Finding & { id?: string })[],
  by: string,
  ts: string,
): Label[] {
  const byId = new Map(findings.filter((f) => f.id).map((f) => [f.id!, f]));
  const out: Label[] = [];
  for (const line of md.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const id = cells[1];
    if (!id || !/^F-\d{8}-\d{4}$/.test(id)) continue;
    const verdict = (cells[cells.length - 2] ?? "").toLowerCase();
    const f = byId.get(id);
    if (!f || !verdict) continue;
    const label: LabelValue = /^(?:да|yes|y|\+|tp|верно)$/u.test(verdict)
      ? "yes"
      : /^(?:нет|no|n|-|fp|неверно)$/u.test(verdict)
        ? "no"
        : "unsure";
    out.push({ key: findingKey(f), by, label, ts });
  }
  return out;
}

/** Коэффициент каппа Коэна для двух разметчиков на общих пунктах (unsure — отдельная категория). */
export function cohenKappa(pairs: readonly [LabelValue, LabelValue][]): number {
  const n = pairs.length;
  if (n === 0) return Number.NaN;
  const cats: LabelValue[] = ["yes", "no", "unsure"];
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  let chance = 0;
  for (const c of cats) {
    const pa = pairs.filter(([a]) => a === c).length / n;
    const pb = pairs.filter(([, b]) => b === c).length / n;
    chance += pa * pb;
  }
  return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}

export interface Agreement {
  /** κ по всем общим пунктам. */
  kappa: number;
  n: number;
  /** κ по классу (только где ≥ 5 общих пунктов). */
  byClass: Partial<Record<AuditClass, { kappa: number; n: number }>>;
  /** Ключи, где разметчики разошлись или кто-то не уверен, — к владельцу. */
  disputed: string[];
}

export function agreement(
  items: readonly LabelItem[],
  a: readonly Label[],
  b: readonly Label[],
): Agreement {
  const la = new Map(a.map((l) => [l.key, l.label]));
  const lb = new Map(b.map((l) => [l.key, l.label]));
  const both = items.filter((i) => la.has(i.key) && lb.has(i.key));
  const pairs = (list: readonly LabelItem[]) =>
    list.map((i) => [la.get(i.key)!, lb.get(i.key)!] as [LabelValue, LabelValue]);
  const byClass: Agreement["byClass"] = {};
  for (const klass of ALL_CLASSES) {
    const of = both.filter((i) => i.class === klass);
    if (of.length >= 5) byClass[klass] = { kappa: cohenKappa(pairs(of)), n: of.length };
  }
  return {
    kappa: cohenKappa(pairs(both)),
    n: both.length,
    byClass,
    disputed: both
      .filter((i) => la.get(i.key) !== lb.get(i.key) || la.get(i.key) === "unsure")
      .map((i) => i.key),
  };
}

/** Окончательная метка пункта: согласие двух разметчиков, иначе решение владельца; без него — нет метки. */
export function goldLabels(
  a: readonly Label[],
  b: readonly Label[],
  owner: readonly Label[] = [],
): Map<string, "yes" | "no"> {
  const out = new Map<string, "yes" | "no">();
  const lb = new Map(b.map((l) => [l.key, l.label]));
  for (const l of a) if (l.label !== "unsure" && lb.get(l.key) === l.label) out.set(l.key, l.label);
  for (const l of owner) if (l.label !== "unsure") out.set(l.key, l.label);
  return out;
}

/** Классы, где в окончательной разметке ≥ min положительных: только для них включаем судью (A-2). */
export function judgeableClasses(
  items: readonly LabelItem[],
  gold: ReadonlyMap<string, "yes" | "no">,
  min = 30,
): AuditClass[] {
  return ALL_CLASSES.filter(
    (klass) => items.filter((i) => i.class === klass && gold.get(i.key) === "yes").length >= min,
  );
}

export interface ClassScore {
  klass: AuditClass;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  /** confirmed — P ≥ 0,80 и R ≥ 0,60 на test (research/24 A-2); иначе shadow. */
  status: "confirmed" | "shadow";
}

/** P и R судьи по классу на пунктах «сессия × класс» выбранной половины. */
export function scoreJudge(
  items: readonly LabelItem[],
  gold: ReadonlyMap<string, "yes" | "no">,
  predicted: ReadonlyMap<string, boolean>,
  klass: AuditClass,
  split: "dev" | "test" = "test",
): ClassScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const i of items) {
    if (i.kind !== "session" || i.class !== klass || i.split !== split) continue;
    const truth = gold.get(i.key);
    if (truth === undefined || !predicted.has(i.key)) continue;
    const yes = predicted.get(i.key)!;
    if (yes && truth === "yes") tp += 1;
    else if (yes && truth === "no") fp += 1;
    else if (!yes && truth === "yes") fn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    klass,
    tp,
    fp,
    fn,
    precision,
    recall,
    status: precision >= 0.8 && recall >= 0.6 ? "confirmed" : "shadow",
  };
}

/** Решения владельца из DISPUTED.md (последний столбец: да / нет / ?). */
export function labelsFromDisputed(md: string, by: string, ts: string): Label[] {
  const out: Label[] = [];
  for (const line of md.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const key = cells[1];
    if (!key || !/^[FS]#/.test(key)) continue;
    const verdict = (cells[cells.length - 2] ?? "").toLowerCase();
    if (!verdict) continue;
    const label: LabelValue = /^(?:да|yes|y|\+)$/u.test(verdict)
      ? "yes"
      : /^(?:нет|no|n|-)$/u.test(verdict)
        ? "no"
        : "unsure";
    out.push({ key, by, label, ts });
  }
  return out;
}
