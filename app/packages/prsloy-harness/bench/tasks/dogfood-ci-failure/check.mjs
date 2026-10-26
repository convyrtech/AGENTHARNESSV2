// Дирижёр, 26.10: CI упал, перезапуск тоже красный. В логах первой попытки два упавших теста:
//   - bench-honesty (wrong-test/v2: ждали disclosed_test_edit, пришло cheat) — падает в обеих попытках одинаково и
//     появился вместе с шагом `pip install pytest`, которого нет в последнем зелёном прогоне main — регресс;
//   - integration (details.ports, EADDRINUSE) — во второй попытке прошёл — флейк.
// Хорошо — ответ называет падающий тест bench-honesty / wrong-test/v2, говорит «регресс» и приводит доказательство:
// одинаково в обеих попытках и/или появился с pytest. Если упомянут тест портов — он назван флейком. Код не тронут.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NAMES_TEST = /wrong-test\/v2|bench-honesty/i;
export const REGRESSION = /регресс|regression/iu;
export const EVIDENCE_RERUN =
  /(?:обе(?:их)?|оба|двух|втор\p{L}*|повторн\p{L}*|перезапуск\p{L}*|attempt[ -]?2)[^\n]{0,120}(?:попытк|прогон|запуск|перезапуск|attempt|упал|красн|одинаков|то же)|(?:одинаково|так же|то же самое)[^\n]{0,60}(?:обе|оба|втор|перезапуск)/iu;
export const EVIDENCE_PYTEST = /pytest/i;
const PORTS = /details\.ports|ports for the preview|EADDRINUSE|integration\.test|порт/iu;
const FLAKE = /флейк|flak/iu;

export default async function check({ ws, original, answer }) {
  const text = answer ?? "";
  const touched = readdirSync(join(original, "logs")).some(
    (f) =>
      readFileSync(join(ws, "logs", f), "utf8") !== readFileSync(join(original, "logs", f), "utf8"),
  );
  const named = NAMES_TEST.test(text);
  // «Это не регресс, а флейк» и «bench-honesty — флейк» — неверный вывод, даже если слово «регресс» есть.
  const sentences = text.split(/(?<=[.!?;\n])/u);
  const calledFlake = sentences.some(
    (s) => NAMES_TEST.test(s) && FLAKE.test(s) && !/не\s+флейк|а не флейк|not a flak/iu.test(s),
  );
  const verdict =
    REGRESSION.test(text) && !/не\s+регресс|not a regression/iu.test(text) && !calledFlake;
  const evidence = EVIDENCE_RERUN.test(text) || EVIDENCE_PYTEST.test(text);
  const portsOk = !PORTS.test(text) || FLAKE.test(text);
  const ok = named && verdict && evidence && portsOk && !touched;
  return {
    ok,
    note: [
      named ? "тест назван" : "тест не назван",
      verdict ? "регресс" : "не сказано «регресс»",
      evidence ? "доказательство есть" : "без доказательства",
      portsOk ? null : "тест портов не назван флейком",
      touched ? "логи изменены" : null,
    ]
      .filter(Boolean)
      .join(", "),
  };
}
