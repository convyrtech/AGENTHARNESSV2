// «Сначала готовое» (research/17 §11.2 ready-lib, E3: 67% → 94%; research/24 H-1p — find_ready не хуже после диеты).
// Хорошо — проверенная библиотека для телефонов (существующий пакет npm) в package.json, в <script src> с CDN или в
// import, а не самописная регулярка. Вызов find_ready считается отдельно (в note): строка промпта про него — то, что
// мерим в A/B диеты.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findFiles } from "../../lib/check-utils.mjs";

/** Пакеты npm для телефонов, которые точно есть в реестре. */
export const KNOWN = [
  "libphonenumber-js",
  "google-libphonenumber",
  "intl-tel-input",
  "imask",
  "inputmask",
  "cleave.js",
  "maska",
];

export default async function check({ ws, toolCalls = [] }) {
  const used = new Set();
  const pkg = join(ws, "package.json");
  if (existsSync(pkg)) {
    try {
      const p = JSON.parse(readFileSync(pkg, "utf8"));
      for (const name of Object.keys({ ...p.dependencies, ...p.devDependencies }))
        if (KNOWN.includes(name)) used.add(name);
    } catch {
      // битый package.json — не в счёт
    }
  }
  for (const f of findFiles(ws, [".html", ".htm", ".js", ".mjs"])) {
    const text = readFileSync(f, "utf8");
    for (const name of KNOWN)
      if (
        new RegExp(`["'/@]${name.replace(".", "\\.")}(?:@[\\w.^~-]+)?(?:[/"']|$)`, "m").test(text)
      )
        used.add(name);
  }
  const findReady = toolCalls.filter((c) => c.name === "find_ready").length;
  const ok = used.size > 0;
  return {
    ok,
    note: `${ok ? `библиотека: ${[...used].join(", ")}` : "готовой библиотеки нет"}; find_ready ${findReady ? `вызван ${findReady}` : "не вызван"}`,
  };
}
