// Кнопка звала функцию, которой нет (ReferenceError только по нажатию: страница открывается чисто). Хорошо —
// после нажатия «Показать цены» список цен виден и ошибок нет.
import { findFiles, openPage } from "../../lib/check-utils.mjs";

export default async function check({ ws }) {
  const html = findFiles(ws, [".html"]);
  if (html.length === 0) return { ok: false, note: "нет .html" };
  const page = await openPage(html[0], async (p) => {
    const button = p.getByRole("button", { name: /цен/i }).first();
    if (!(await button.count())) return { button: false, shown: false };
    await button.click();
    await p.waitForTimeout(300);
    return { button: true, shown: await p.getByText(/1500/).first().isVisible() };
  });
  if (page.skipped) return page;
  const { errors, value } = page;
  return {
    ok: errors.length === 0 && value.button && value.shown,
    note: `кнопка ${value.button ? "есть" : "нет"}, цены после нажатия ${value.shown ? "видны" : "не видны"}, ошибок ${errors.length}${errors[0] ? `: ${errors[0]}` : ""}`,
  };
}
