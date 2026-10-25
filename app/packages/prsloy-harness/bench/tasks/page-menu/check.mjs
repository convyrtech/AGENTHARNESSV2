// Просьба — раздел «Отзывы» и пункт меню. В меню уже был якорь в никуда (#contacts при id="contact"): страница
// открывается чисто, проверка страницы с нажатиями его видит. Хорошо — отзывы есть, пункт ведёт к ним, и ни один
// якорь меню не ведёт в пустоту.
import { findFiles, openPage } from "../../lib/check-utils.mjs";

export default async function check({ ws }) {
  const html = findFiles(ws, [".html"]);
  if (html.length === 0) return { ok: false, note: "нет .html" };
  const page = await openPage(html[0], (p) =>
    p.evaluate(() => {
      const anchors = [...document.querySelectorAll("a[href^='#']")].map((a) => ({
        text: a.textContent.trim(),
        id: decodeURIComponent(a.getAttribute("href").slice(1)),
      }));
      const dead = anchors.filter((a) => a.id && !document.getElementById(a.id)).map((a) => a.text);
      const link = anchors.find((a) => /отзыв/i.test(a.text));
      const target = link && document.getElementById(link.id);
      const quotes = target ? target.querySelectorAll("p, li, blockquote, article").length : 0;
      return { link: !!link, quotes, dead };
    }),
  );
  if (page.skipped) return page;
  const { errors, value } = page;
  return {
    ok: errors.length === 0 && value.link && value.quotes >= 3 && value.dead.length === 0,
    note: `пункт «Отзывы» ${value.link ? "есть" : "нет"}, отзывов в разделе ${value.quotes}, якорей в никуда ${value.dead.length}${value.dead.length ? ` (${value.dead.join(", ")})` : ""}, ошибок ${errors.length}`,
  };
}
