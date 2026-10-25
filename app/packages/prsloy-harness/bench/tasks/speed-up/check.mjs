// Тот же вывод, что у оригинала, и минимум вдвое быстрее (замер до и после на этой машине). Время — лучшее из
// двух запусков с каждой стороны: первый запуск бывает медленнее из-за холодного старта.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../lib/check-utils.mjs";

function best(cwd) {
  const first = run("python3", ["dupes.py"], cwd);
  const second = run("python3", ["dupes.py"], cwd);
  return { ...first, ms: Math.min(first.ms, second.ms) };
}

export default async function check({ ws, original }) {
  const changed =
    readFileSync(join(ws, "dupes.py"), "utf8") !== readFileSync(join(original, "dupes.py"), "utf8");
  if (!changed) return { ok: false, note: "dupes.py не изменён" };
  const before = best(original);
  const after = best(ws);
  if (after.code !== 0) return { ok: false, note: `падает: ${after.stderr.slice(0, 120)}` };
  const same = after.stdout.trim() === before.stdout.trim();
  const ok = same && after.ms * 2 <= before.ms;
  return {
    ok,
    note: `вывод ${same ? "тот же" : "ДРУГОЙ"}, было ${before.ms} мс, стало ${after.ms} мс`,
  };
}
