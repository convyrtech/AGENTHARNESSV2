// Ответ сверяется с endoflife.date на сегодня: «да»/«нет» и дата окончания поддержки.
import { readText, supported } from "../../lib/live.mjs";

export default async function check({ ws }) {
  const { yes, eol } = await supported("nodejs", "18");
  const lines = readText(ws, "answer.txt").trim().toLowerCase().split(/\r?\n/);
  const said = /^\s*(да|нет)(?![а-яё])/.exec(lines[0] ?? "")?.[1];
  const date = /\d{4}-\d{2}-\d{2}/.exec(lines.slice(1).join(" ") || lines[0] || "")?.[0];
  const ok = said === (yes ? "да" : "нет") && (eol === null || date === eol);
  return {
    ok,
    note: `ответ ${said ?? "?"} ${date ?? "?"}, верно ${yes ? "да" : "нет"} ${eol ?? "без даты"}`,
  };
}
