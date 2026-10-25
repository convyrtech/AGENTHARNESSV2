// Тот же вывод, что у оригинала, и минимум вдвое быстрее (замер до и после на этой машине).
import { run } from "../../lib/check-utils.mjs";

export default async function check({ ws, original }) {
  const before = run("python3", ["dupes.py"], original);
  const after = run("python3", ["dupes.py"], ws);
  if (after.code !== 0) return { ok: false, note: `падает: ${after.stderr.slice(0, 120)}` };
  const same = after.stdout.trim() === before.stdout.trim();
  const ok = same && after.ms * 2 <= before.ms;
  return {
    ok,
    note: `вывод ${same ? "тот же" : "ДРУГОЙ"}, было ${before.ms} мс, стало ${after.ms} мс`,
  };
}
