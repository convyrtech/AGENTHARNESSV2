// В summary.csv у каждого месяца верная сумма: январь 1900, февраль 3000, март 1800 (любой формат месяца).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MONTHS = [
  { total: 1900, names: [/2026-0?1\b/, /\b0?1[./]2026/, /январ/i, /\bjan/i] },
  { total: 3000, names: [/2026-0?2\b/, /\b0?2[./]2026/, /феврал/i, /\bfeb/i] },
  { total: 1800, names: [/2026-0?3\b/, /\b0?3[./]2026/, /март/i, /\bmar/i] },
];

// Числа строки: и по полям (запятая — разделитель CSV), и целиком (запятая — дробная часть, «1 900,00»).
function numbers(line) {
  const clean = line.replace(/(\d)[\s ](?=\d{3}\b)/g, "$1");
  const parse = (text, decimalComma) =>
    [...text.matchAll(decimalComma ? /\d+(?:[.,]\d+)?/g : /\d+(?:\.\d+)?/g)].map((m) =>
      Number(m[0].replace(",", ".")),
    );
  return [...clean.split(/[,;\t]/).flatMap((field) => parse(field, false)), ...parse(clean, true)];
}

export default async function check({ ws }) {
  const path = join(ws, "summary.csv");
  if (!existsSync(path)) return { ok: false, note: "нет summary.csv" };
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const found = MONTHS.map((m) =>
    lines.some((l) => m.names.some((re) => re.test(l)) && numbers(l).includes(m.total)),
  );
  return { ok: found.every(Boolean), note: `месяцы верны: ${found.filter(Boolean).length}/3` };
}
