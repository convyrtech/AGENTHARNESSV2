// Страница открывается без ошибок в консоли, на ней имя Анны и форма с полем и кнопкой.
import { findFiles, openPage } from "../../lib/check-utils.mjs";

export default async function check({ ws }) {
  const html = findFiles(ws, [".html"]).sort(
    (a, b) => (a.endsWith("index.html") ? -1 : 1) - (b.endsWith("index.html") ? -1 : 1),
  );
  if (html.length === 0) return { ok: false, note: "нет .html" };
  const page = await openPage(html[0], async (p) => ({
    text: await p.locator("body").innerText(),
    forms: await p.locator("form").count(),
    fields: await p
      .locator("form input:not([type=hidden]):not([type=submit]), form textarea")
      .count(),
    buttons: await p.locator("form button, form input[type=submit]").count(),
  }));
  if (page.skipped) return page;
  const { errors, value } = page;
  const ok =
    errors.length === 0 &&
    value.forms > 0 &&
    value.fields > 0 &&
    value.buttons > 0 &&
    /Анн/.test(value.text);
  return {
    ok,
    note: `форм ${value.forms}, полей ${value.fields}, кнопок ${value.buttons}, ошибок ${errors.length}${errors[0] ? `: ${errors[0]}` : ""}`,
  };
}
