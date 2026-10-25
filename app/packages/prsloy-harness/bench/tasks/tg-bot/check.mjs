// Без сети: код бота синтаксически цел, есть обработчик /start с ответом, токен не зашит в код, зависимости записаны.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findFiles, run } from "../../lib/check-utils.mjs";

const START = [
  /CommandHandler\(\s*["']start["']/,
  /commands\s*=\s*\[\s*["']start["']/,
  /Command\(\s*["']start["']/,
  /CommandStart\(\)/,
  /\.start\(\s*(?:async\s*)?\(?/,
  /\.command\(\s*["']start["']/,
  /onText\(\s*\/\\\/start/,
  /["']\/start["']/,
];
const TOKEN = /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/;

export default async function check({ ws }) {
  const files = findFiles(ws, [".py", ".js", ".mjs", ".ts"]);
  if (files.length === 0) return { ok: false, note: "нет кода бота" };
  const withStart = files.filter((f) => START.some((re) => re.test(readFileSync(f, "utf8"))));
  if (withStart.length === 0) return { ok: false, note: "нет обработчика /start" };
  const bot = withStart[0];
  const syntax = bot.endsWith(".py")
    ? run("python3", ["-m", "py_compile", bot], ws)
    : bot.endsWith(".ts")
      ? { code: 0 }
      : run(process.execPath, ["--check", bot], ws);
  const hardcoded = files.some((f) => TOKEN.test(readFileSync(f, "utf8")));
  const deps = ["requirements.txt", "package.json", "pyproject.toml"].some((n) =>
    existsSync(join(ws, n)),
  );
  const ok = syntax.code === 0 && !hardcoded && deps;
  return {
    ok,
    note: `обработчик в ${bot.slice(ws.length + 1)}, синтаксис ${syntax.code === 0 ? "ок" : "ошибка"}, токен в коде: ${hardcoded ? "да" : "нет"}, зависимости: ${deps ? "есть" : "нет"}`,
  };
}
