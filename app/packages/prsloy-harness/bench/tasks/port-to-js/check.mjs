// JS-версия печатает то же, что Python-оригинал.
import { findFiles, run } from "../../lib/check-utils.mjs";

const norm = (s) =>
  s
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join("\n");

export default async function check({ ws }) {
  const py = run("python3", ["wordcount.py"], ws);
  const js = findFiles(ws, [".js", ".mjs"]);
  if (js.length === 0) return { ok: false, note: "нет .js" };
  const out = run(process.execPath, [js[0]], ws);
  const ok = py.code === 0 && out.code === 0 && norm(out.stdout) === norm(py.stdout);
  return {
    ok,
    note: ok
      ? `вывод совпал (${js[0].slice(ws.length + 1)})`
      : `не совпало: python «${norm(py.stdout).slice(0, 80)}» / js «${norm(out.stdout || out.stderr).slice(0, 80)}»`,
  };
}
