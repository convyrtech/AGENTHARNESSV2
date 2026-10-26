// Дирижёр, 26.10: конфликт слияния в STATUS.md и в счётчике задач. Хорошо — маркеров конфликта нет, обе стороны
// STATUS.md на месте (и лендинги, и устаревшее описание; остальное не потеряно), в тесте обе задачи, число в
// названии теста совпадает со списком, и `node --test` проходит. Папки задач не тронуты.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../lib/check-utils.mjs";

const MARKERS = /^(?:<{7}|={7}|>{7})(?:\s|$)/m;
const STATUS_LINES = [
  "## Гейт для Python (#37)",
  "## Лендинги (#36)",
  "Три казуальные задачи с проверкой в браузере на 390 и 1440 px.",
  "## Устаревшее описание проекта (arXiv 2610.30571)",
  "Две задачи замера: `stale-docs-logging`, `stale-docs-naming`.",
  "## Безопасность навыков",
];

export default async function check({ ws, original }) {
  const statusPath = join(ws, "STATUS.md");
  const testPath = join(ws, "test", "tasks.mjs");
  if (!existsSync(statusPath) || !existsSync(testPath)) return { ok: false, note: "файлы пропали" };
  const status = readFileSync(statusPath, "utf8");
  const testSrc = readFileSync(testPath, "utf8");
  const markers = MARKERS.test(status) || MARKERS.test(testSrc);
  const lost = STATUS_LINES.filter((l) => !status.includes(l));
  const both = testSrc.includes('"landing-coffee"') && testSrc.includes('"stale-docs-naming"');
  const tasks = readdirSync(join(ws, "tasks")).sort();
  const sameTasks =
    JSON.stringify(tasks) === JSON.stringify(readdirSync(join(original, "tasks")).sort());
  const title = /has (\d+) casual tasks/.exec(testSrc);
  const countOk = title !== null && Number(title[1]) === tasks.length;
  const out = run("node", ["--test"], ws);
  const passed = out.code === 0;
  const ok = !markers && lost.length === 0 && both && sameTasks && countOk && passed;
  return {
    ok,
    note: [
      markers ? "маркеры конфликта остались" : "маркеров нет",
      lost.length ? `в STATUS.md потеряно: ${lost.length}` : "обе стороны STATUS.md на месте",
      both ? "в тесте обе задачи" : "в тесте не обе задачи",
      countOk ? null : "число в названии теста не совпадает",
      sameTasks ? null : "папки задач изменены",
      passed ? "тест прошёл" : "тест не прошёл",
    ]
      .filter(Boolean)
      .join(", "),
  };
}
