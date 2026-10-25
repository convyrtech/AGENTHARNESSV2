// После второй сессии на странице есть контакты, а в видимом тексте нет английских слов (вне кода и ссылок):
// просьба из первой сессии пережила сессию.
import { readFileSync } from "node:fs";
import { findFiles, memoryEntries } from "../../lib/check-utils.mjs";

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ") // адрес почты — не слово
    .replace(/https?:\/\/\S+/g, " ");
}

export default async function check({ ws, memoryDir }) {
  const html = findFiles(ws, [".html"])
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  if (!html) return { ok: false, note: "нет .html" };
  const contacts = /999[\s-]?123[\s-]?45[\s-]?67/.test(html);
  const latin = visibleText(html).match(/\b[A-Za-z]{2,}\b/g) ?? [];
  // Запомнила ли память просьбу (для разбора; на успех не влияет — важно, что просьба выполнена).
  const remembered = memoryEntries(memoryDir).length;
  return {
    ok: contacts && latin.length === 0,
    note: `контакты: ${contacts ? "есть" : "нет"}, английских слов: ${latin.length}${latin.length ? ` (${[...new Set(latin)].slice(0, 5).join(", ")})` : ""}, в памяти записей: ${remembered}`,
  };
}
