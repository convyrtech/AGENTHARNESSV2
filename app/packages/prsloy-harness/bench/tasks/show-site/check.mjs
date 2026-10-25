// Страница есть, в ответе — путь к ней или адрес http://127.0.0.1:…, и нет команд пользователю (research/17 §11.2).
import { basename } from "node:path";
import { findFiles } from "../../lib/check-utils.mjs";

export default async function check({ ws, answer, reply }) {
  const html = findFiles(ws, [".html"]);
  if (html.length === 0) return { ok: false, note: "нет .html" };
  const shown =
    /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/.test(answer) ||
    html.some((f) => answer.includes(basename(f)));
  const ok = shown && reply.commandsToUser === 0;
  return {
    ok,
    note: `${shown ? "показал" : "не показал, где страница"}, команд пользователю ${reply.commandsToUser}`,
  };
}
