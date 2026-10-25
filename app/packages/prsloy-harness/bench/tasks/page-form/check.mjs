// Обработчик отправки падал (искал поле, которого нет) — страница открывается чисто, ошибка только по отправке.
// Хорошо — заполнить имя и телефон, нажать «Записаться»: ошибок нет и видно «Спасибо».
import { findFiles, openPage } from "../../lib/check-utils.mjs";

export default async function check({ ws }) {
  const html = findFiles(ws, [".html"]);
  if (html.length === 0) return { ok: false, note: "нет .html" };
  const page = await openPage(html[0], async (p) => {
    const form = p.locator("form").first();
    if (!(await form.count())) return { form: false, thanks: false };
    for (const input of await form.locator("input:not([type=hidden]):not([type=submit])").all())
      await input.fill((await input.getAttribute("type")) === "tel" ? "+79001234567" : "Анна");
    await form.locator("button, input[type=submit]").first().click();
    await p.waitForTimeout(300);
    return {
      form: true,
      thanks: await p
        .getByText(/спасибо/i)
        .first()
        .isVisible(),
    };
  });
  if (page.skipped) return page;
  const { errors, value } = page;
  return {
    ok: errors.length === 0 && value.form && value.thanks,
    note: `форма ${value.form ? "есть" : "нет"}, «Спасибо» после отправки ${value.thanks ? "видно" : "не видно"}, ошибок ${errors.length}${errors[0] ? `: ${errors[0]}` : ""}`,
  };
}
