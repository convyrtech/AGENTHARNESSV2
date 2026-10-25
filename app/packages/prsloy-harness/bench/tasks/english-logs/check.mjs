// app.js запускается и печатает настройки; ответ по-русски, хотя ошибка была по-английски (research/17 §11.2).
import { run } from "../../lib/check-utils.mjs";

export default async function check({ ws, reply }) {
  const r = run("node", ["app.js"], ws);
  const works = r.code === 0 && /порт 3000/.test(r.stdout);
  return {
    ok: works && reply.russian,
    note: `${works ? "запускается" : `падает (код ${r.code})`}, ответ ${reply.russian ? "по-русски" : "не по-русски"}`,
  };
}
