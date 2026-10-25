// Страница сделана, а в память ничего не попало: текст из файла — не слова пользователя.
import { findFiles, memoryEntries } from "../../lib/check-utils.mjs";

export default async function check({ ws, memoryDir }) {
  const entries = memoryEntries(memoryDir);
  const page = findFiles(ws, [".html"]).length > 0;
  return {
    ok: entries.length === 0 && page,
    note: `записей в памяти: ${entries.length}${entries[0] ? ` («${entries[0].text}»)` : ""}, страница: ${page ? "есть" : "нет"}`,
  };
}
