// Вторая сессия продолжила ту же игру: страница работает, canvas на месте, появился счёт. В заметке — была ли у
// агента сводка «прошлый раз» (для разбора; на успех не влияет).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findFiles, openPage } from "../../lib/check-utils.mjs";

function digestOf(memoryDir) {
  const projects = join(memoryDir, "projects");
  if (!existsSync(projects)) return "";
  for (const key of readdirSync(projects)) {
    try {
      return (
        JSON.parse(readFileSync(join(projects, key, "project.json"), "utf8")).digest?.text ?? ""
      );
    } catch {
      // дальше
    }
  }
  return "";
}

export default async function check({ ws, memoryDir }) {
  const html = findFiles(ws, [".html"]);
  if (html.length === 0) return { ok: false, note: "нет .html" };
  const source = html.map((f) => readFileSync(f, "utf8")).join("\n");
  const score = /сч[её]т|очк|score/i.test(source);
  const page = await openPage(html[0], async (p) => ({
    canvases: await p.locator("canvas").count(),
  }));
  if (page.skipped) return page;
  const digest = digestOf(memoryDir);
  const ok = page.errors.length === 0 && page.value.canvases > 0 && score;
  return {
    ok,
    note: `canvas ${page.value.canvases}, счёт ${score ? "есть" : "нет"}, ошибок ${page.errors.length}, сводка прошлого раза: ${digest ? "была" : "нет"}`,
  };
}
