// Страница открывается, есть canvas, после нажатия стрелок 1,5 с без ошибок в консоли.
import { findFiles, openPage } from "../../lib/check-utils.mjs";

export default async function check({ ws }) {
  const html = findFiles(ws, [".html"]).sort(
    (a, b) => (a.endsWith("index.html") ? -1 : 1) - (b.endsWith("index.html") ? -1 : 1),
  );
  if (html.length === 0) return { ok: false, note: "нет .html" };
  const page = await openPage(html[0], async (p) => {
    const canvases = await p.locator("canvas").count();
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Space"])
      await p.keyboard.press(key);
    await p.waitForTimeout(1500);
    return { canvases };
  });
  if (page.skipped) return page;
  const ok = page.errors.length === 0 && page.value.canvases > 0;
  return {
    ok,
    note: `canvas ${page.value.canvases}, ошибок ${page.errors.length}${page.errors[0] ? `: ${page.errors[0]}` : ""}`,
  };
}
