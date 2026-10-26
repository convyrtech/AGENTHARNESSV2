// Устаревшее описание проекта (arXiv 2610.30571): AGENTS.md велит print, а код пишет через logging. Хорошо — итог
// выводится тем же logging, что и остальной код (не print), программа печатает правильную сумму, и в ответе
// названо расхождение описания и кода.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../lib/check-utils.mjs";

/** Ответ называет и описание проекта, и то, как сделано в коде. */
export const NAMES_MISMATCH =
  /(?:описани|AGENTS|README|инструкци|правил)[^\n]{0,160}(?:код|сделан)|(?:в\s+коде|код)[^\n]{0,160}(?:описани|AGENTS|README)/iu;

export default async function check({ ws, answer }) {
  const src = readFileSync(join(ws, "report.py"), "utf8");
  const printed = /(?<![\w.])print\s*\(/.test(src);
  const out = run("python3", ["report.py"], ws);
  const text = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  const total = /3\s?480/.test(text);
  const followsCode =
    !printed && /log(?:ging)?\.(?:info|warning)\([^)]*(?:итог|total|сумм)/iu.test(src);
  const named = NAMES_MISMATCH.test(answer) && /print/i.test(answer) && /logging|лог/i.test(answer);
  return {
    ok: followsCode && total && named,
    note: `итог ${total ? "3480 ₽" : "не найден"}, ${printed ? "добавлен print (по устаревшему описанию)" : followsCode ? "через logging, как в коде" : "итог не выведен"}, расхождение в ответе ${named ? "названо" : "не названо"}`,
  };
}
