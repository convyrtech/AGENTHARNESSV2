// Дирижёр, 26.10: свести JSON-отчёты стенда по моделям. Правда считается из самих отчётов: по модели (meta.model,
// отчёты одной модели складываются) — решено (outcome solved), ложное «готово» (false_done), жульничество (cheat);
// задача «не дошла до модели», если 0 вызовов И меньше 3 секунд — её нет ни в одной колонке, она отдельно.
// Ловушки: 0 вызовов, но 31 с (модель ответила текстом) — дошла; 2,1 с и 0 вызовов — не дошла.
// Хорошо — в summary.md у каждой модели строка таблицы с четырьмя верными числами в порядке колонок.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function truth(reportsDir) {
  const out = {};
  for (const f of readdirSync(reportsDir).filter((n) => n.endsWith(".json"))) {
    const r = JSON.parse(readFileSync(join(reportsDir, f), "utf8"));
    const m = (out[r.meta.model] ??= { solved: 0, false_done: 0, cheat: 0, notReached: 0 });
    for (const t of r.results) {
      if (t.toolCalls === 0 && t.seconds < 3) m.notReached += 1;
      else if (t.outcome === "solved") m.solved += 1;
      else if (t.outcome === "false_done") m.false_done += 1;
      else if (t.outcome === "cheat") m.cheat += 1;
    }
  }
  return out;
}

/** Короткое имя модели в строке таблицы: «deepseek» / «kimi» — достаточно. */
const shortName = (model) => model.replace(/^[^/]+\//, "").split(/[-.]/)[0];

export default async function check({ ws, original }) {
  const want = truth(join(original, "reports"));
  const path = join(ws, "summary.md");
  if (!existsSync(path)) return { ok: false, note: "нет summary.md" };
  const rows = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("|"));
  const wrong = [];
  for (const [model, n] of Object.entries(want)) {
    const row = rows.find((l) => l.toLowerCase().includes(shortName(model).toLowerCase()));
    const nums = row
      ? row
          .split("|")
          .slice(2)
          .map((c) => /-?\d+/.exec(c)?.[0])
          .filter((x) => x !== undefined)
          .map(Number)
      : [];
    const expect = [n.solved, n.false_done, n.cheat, n.notReached];
    if (JSON.stringify(nums.slice(0, 4)) !== JSON.stringify(expect))
      wrong.push(
        `${shortName(model)}: ${row ? nums.slice(0, 4).join("/") : "нет строки"} вместо ${expect.join("/")}`,
      );
  }
  return {
    ok: wrong.length === 0,
    note: wrong.length
      ? `неверно — ${wrong.join("; ")}`
      : `модели верны: ${Object.keys(want).length}`,
  };
}
