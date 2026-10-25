// Оффлайн-улучшатель (#33): разбиение казуального стенда на train / test — до первого подбора, файлом
// (research/27: «train/test-разбиение», research/24 §5). Улучшатель смотрит и правит только по train; решение
// «повышать» — только по check.mjs на test. Задачи честности (suite honesty) — всегда test, не для подбора.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rng } from "../audit/labels.ts";

export const SPLIT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bench",
  "split.json",
);

export interface Split {
  version: 1;
  /** Когда решено — до любого подбора. */
  decided: string;
  /** Как выбраны train-задачи (seed или «нестабильные по базовым прогонам …»). */
  rule: string;
  train: string[];
  test: string[];
  /** Задачи, добавленные в стенд после решения: только в test, с датой добавления. */
  added?: { task: string; date: string }[];
}

export function loadSplit(file = SPLIT_FILE): Split {
  const s = JSON.parse(readFileSync(file, "utf8")) as Split;
  const both = s.train.filter((t) => s.test.includes(t));
  if (both.length) throw new Error(`split: задачи и в train, и в test: ${both.join(", ")}`);
  return s;
}

/** Train-задачи по seed (детерминированно), остальные — test. */
export function seededSplit(
  tasks: readonly string[],
  nTrain: number,
  seed: number,
  decided: string,
): Split {
  const random = rng(seed);
  const pool = [...tasks].sort();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const train = pool.slice(0, nTrain).sort();
  return {
    version: 1,
    decided,
    rule: `seed ${seed}: ${nTrain} случайных задач в train, до любого прогона`,
    train,
    test: tasks.filter((t) => !train.includes(t)).sort(),
  };
}

/**
 * Train — «нестабильные» задачи по базовым прогонам (research/06: этап 0 на 4 нестабильных): доля ok строго
 * между 0 и 1 по всем переданным отчётам стенда; при равенстве — меньше прогонов, потом по имени.
 */
export function unstableSplit(
  tasks: readonly string[],
  reports: readonly { results: { id: string; ok: boolean | null }[] }[],
  nTrain: number,
  decided: string,
): Split {
  const stats = tasks.map((t) => {
    const runs = reports.flatMap((r) => r.results.filter((x) => x.id === t && x.ok !== null));
    const ok = runs.filter((x) => x.ok).length;
    return { t, n: runs.length, rate: runs.length ? ok / runs.length : -1 };
  });
  // Округление: 1/3 и 2/3 одинаково далеки от 0,5, а в плавающей точке — нет.
  const far = (rate: number) => Math.round(Math.abs(rate - 0.5) * 1e9);
  const unstable = stats
    .filter((s) => s.rate > 0 && s.rate < 1)
    .sort((a, b) => far(a.rate) - far(b.rate) || a.n - b.n || a.t.localeCompare(b.t));
  const train = unstable
    .slice(0, nTrain)
    .map((s) => s.t)
    .sort();
  return {
    version: 1,
    decided,
    rule: `нестабильные по ${reports.length} базовым отчётам: доля ok ближе всего к 0,5 (${unstable.length} задач с 0 < ok < 1)`,
    train,
    test: tasks.filter((t) => !train.includes(t)).sort(),
  };
}

/**
 * Разбиение пишется один раз: перезапись означала бы подбор train задним числом. Исключение одно — заменить
 * разбиение по seed (заглушку до базовых прогонов) на «нестабильные» (`replaceSeeded`), и только до подбора.
 */
export function writeSplitOnce(
  split: Split,
  file: string,
  options: { replaceSeeded?: boolean } = {},
): void {
  if (existsSync(file)) {
    const old = loadSplit(file);
    const seeded = old.rule.startsWith("seed ") && !split.rule.startsWith("seed ");
    if (!(options.replaceSeeded && seeded))
      throw new Error(`${file} уже есть: разбиение решено до подбора и не перезаписывается`);
  }
  writeFileSync(file, `${JSON.stringify(split, null, 2)}\n`);
}

/** Улучшатель видит только train: попытка дать ему test-задачу — ошибка, а не тихий пропуск. */
export function assertTrainOnly(split: Split, tasks: readonly string[]): void {
  const bad = tasks.filter((t) => !split.train.includes(t.split("/")[0]!));
  if (bad.length) throw new Error(`не из train (${split.train.join(", ")}): ${bad.join(", ")}`);
}

/**
 * Новые задачи стенда (появились после решения) — только в test: train задним числом не расширяется, а задачи,
 * которых больше нет, убираются. Train должен остаться прежним, иначе — ошибка.
 */
export function withNewTasks(split: Split, tasks: readonly string[], date: string): Split {
  const gone = split.train.filter((t) => !tasks.includes(t));
  if (gone.length)
    throw new Error(`train-задач больше нет в стенде: ${gone.join(", ")} — нужно новое решение`);
  const known = new Set([...split.train, ...split.test]);
  const fresh = tasks.filter((t) => !known.has(t)).sort();
  return {
    ...split,
    test: [...split.test.filter((t) => tasks.includes(t)), ...fresh].sort(),
    ...(fresh.length || split.added
      ? { added: [...(split.added ?? []), ...fresh.map((task) => ({ task, date }))] }
      : {}),
  };
}

/** Записать разбиение с новыми задачами в test (train сверяется с файлом). */
export function writeWithNewTasks(file: string, tasks: readonly string[], date: string): Split {
  const old = loadSplit(file);
  const next = withNewTasks(old, tasks, date);
  if (next.train.join() !== old.train.join()) throw new Error("train изменился бы — отказ");
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
