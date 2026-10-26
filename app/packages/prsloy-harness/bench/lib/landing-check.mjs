// Сайт-визитка (issue #36, research/29): общие проверки кодом для задач landing-*. Источник страницы и настоящий
// Chromium на 390 и 1440 px. Каждое правило — строка в `failures`; задача пройдена, когда их нет.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findFiles, openPage } from "./check-utils.mjs";

export const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

/** Подписи кнопки, которые не говорят, что получит человек. */
const VAGUE_CTA =
  /^(?:подробнее|отправить|далее|узнать больше|читать далее|submit|send|learn more|more|click here)$/iu;
/** Первое слово — глагол: «Записаться», «Позвоните», «Заказать», «Забронировать столик», «Узнай». */
const VERB = /(?:ть|ти|ться|тись|йте|ите|айте|яйте|ай|яй|ей|ись|ься|ни|ди|зи|си|жи)$/u;

const PLACEHOLDER_TEXT =
  /\blorem\b|\bipsum\b|\bdolor sit\b|your (?:company|name|text|business)|company name|john doe|jane doe|example text|sample text|\bTODO\b|\btext here\b/iu;

/** Числа ответа, которые можно не брать из брифа: телефонная заглушка, время, © год. */
function stripAllowedNumbers(text) {
  return text
    .replace(/\+?7?\s*\(?0{3}\)?[\s-]*0{3}[\s-]*0{2}[\s-]*0{2}/g, " ")
    .replace(/\b\d{1,2}[:.]\d{2}\b/g, " ")
    .replace(/©\s*\d{4}/g, " ")
    .replace(/\b(?:19|20)\d{2}\b(?=\s*(?:г\.|год))/g, " ");
}

/** Числа из двух и более цифр на странице, которых нет в брифе (выдуманные цены, «500+ клиентов», «10 лет»). */
export function inventedNumbers(text, brief) {
  const allowed = new Set((brief.match(/\d+/g) ?? []).map((n) => n.replace(/^0+/, "")));
  // «1 800» — одно число (тысячи через пробел), «01 02» на соседних строках — два.
  const found =
    stripAllowedNumbers(text).match(/\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?!\d)|\d+/g) ?? [];
  return [
    ...new Set(
      found
        .map((n) => n.replace(/[\s  ]/g, "").replace(/^0+/, ""))
        .filter((n) => n.length >= 2 && !allowed.has(n) && !/^0+$/.test(n)),
    ),
  ];
}

function entryOf(ws) {
  if (existsSync(join(ws, "index.html"))) return join(ws, "index.html");
  return findFiles(ws, [".html"])[0];
}

/** Статика: заголовок, описание, пути, alert, форма. */
function staticFailures(html, sources) {
  const f = [];
  if (!/<title>\s*[^<\s][^<]*<\/title>/i.test(html)) f.push("нет <title>");
  if (
    !/<meta\s+[^>]*name=["']description["'][^>]*content=["'][^"']{10,}/i.test(html) &&
    !/<meta\s+[^>]*content=["'][^"']{10,}["'][^>]*name=["']description["']/i.test(html)
  )
    f.push("нет meta description");
  const abs = /\b(?:src|href)\s*=\s*["'](?:\/(?!\/)|file:|[a-z]:\\)/i.exec(html);
  if (abs) f.push(`путь не относительный: ${abs[0]}`);
  if (/\balert\s*\(/.test(sources)) f.push("alert() вместо сообщения на странице");
  return f;
}

/** Всё, что видно в браузере на одной ширине. */
async function browserFailures(file, viewport, brief) {
  const page = await openPage(
    file,
    (p) =>
      p.evaluate(() => {
        const vw = innerWidth;
        const vh = innerHeight;
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        };
        const h1s = [...document.querySelectorAll("h1")].filter(visible);
        const h1Top = h1s.filter((h) => h.getBoundingClientRect().top < vh).length;
        // Главная кнопка — первая видимая кнопка или ссылка-кнопка (фон или рамка) на первом экране.
        const clickable = [
          ...document.querySelectorAll("a, button, [role=button], input[type=submit]"),
        ]
          .filter(visible)
          .filter((el) => {
            const st = getComputedStyle(el);
            const filled =
              st.backgroundColor !== "rgba(0, 0, 0, 0)" && st.backgroundColor !== "transparent";
            const bordered = parseFloat(st.borderTopWidth) > 0 && st.borderTopStyle !== "none";
            return el.tagName === "BUTTON" || el.tagName === "INPUT" || filled || bordered;
          });
        const cta = clickable.find(
          (el) => el.getBoundingClientRect().top < vh && el.getBoundingClientRect().bottom > 0,
        );
        const ctaText = cta ? (cta.innerText || cta.value || "").replace(/\s+/g, " ").trim() : "";
        const longHeadings = [...document.querySelectorAll("h1, h2")]
          .filter(visible)
          .filter((h) => {
            const st = getComputedStyle(h);
            const lh =
              st.lineHeight === "normal"
                ? parseFloat(st.fontSize) * 1.2
                : parseFloat(st.lineHeight);
            return h.getBoundingClientRect().height / lh > 2.5;
          })
          .map((h) => h.innerText.trim().slice(0, 40));
        const sectionsWithout = [...document.querySelectorAll("section")]
          .filter(visible)
          .filter((s) => !s.querySelector("h1, h2, h3"))
          .map((s) => s.id || s.className || "section");
        const imgsWithoutAlt = [...document.querySelectorAll("img")].filter(
          (i) => !i.hasAttribute("alt"),
        ).length;
        // «01 / 02 / 03» — нумерация разделов как шаблонный приём.
        const numbered = [...document.querySelectorAll("body *")].filter(
          (el) =>
            el.children.length === 0 && /^0[1-9]\.?$/.test(el.textContent.trim()) && visible(el),
        ).length;
        // Подпись капслоком прямо над заголовком (eyebrow).
        const eyebrows = [...document.querySelectorAll("h1, h2")]
          .map((h) => h.previousElementSibling)
          .filter(
            (el) =>
              el &&
              visible(el) &&
              el.textContent.trim().length > 0 &&
              el.textContent.trim().length <= 40,
          )
          .filter((el) => {
            const t = el.textContent.trim();
            return (
              getComputedStyle(el).textTransform === "uppercase" ||
              (/\p{L}{3}/u.test(t) && t === t.toUpperCase())
            );
          }).length;
        // Форма: проверка без alert() — пустая отправка не проходит, есть email или телефон, обязательные поля.
        const forms = [...document.querySelectorAll("form")].map((form) => ({
          contact: !!form.querySelector("input[type=email], input[type=tel], input[pattern]"),
          required: form.querySelectorAll("[required]").length,
          blocksEmpty: !form.checkValidity(),
        }));
        // Отзывы с именами без пометки «пример» — выдуманные.
        const text = document.body.innerText;
        const reviews =
          /отзыв/i.test(text) &&
          /[«"][^»"]{10,}[»"]\s*[—–-]\s*\p{Lu}\p{Ll}+/u.test(text) &&
          !/пример|замените|заглушк/i.test(text);
        return {
          overflow: document.documentElement.scrollWidth - vw,
          h1Count: h1s.length,
          h1Top,
          ctaText,
          longHeadings,
          sectionsWithout,
          imgsWithoutAlt,
          numbered,
          eyebrows,
          forms,
          reviews,
          text,
        };
      }),
    viewport,
  );
  if (page.skipped) return { skipped: true };
  const v = page.value;
  const at = `${viewport.width} px`;
  const f = [];
  for (const e of page.errors.slice(0, 2)) f.push(`${at}: ошибка в консоли: ${e.slice(0, 120)}`);
  if (v.overflow > 1) f.push(`${at}: прокрутка вбок на ${v.overflow} px`);
  if (v.h1Count !== 1 || v.h1Top !== 1)
    f.push(`${at}: h1 на странице ${v.h1Count}, на первом экране ${v.h1Top} (нужен один)`);
  if (!v.ctaText) f.push(`${at}: главной кнопки на первом экране нет`);
  else {
    const first = v.ctaText
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/[^\p{L}-]/gu, "");
    if (VAGUE_CTA.test(v.ctaText) || !VERB.test(first))
      f.push(`${at}: главная кнопка «${v.ctaText}» — не глагол с пользой`);
  }
  for (const h of v.longHeadings) f.push(`${at}: заголовок длиннее двух строк: «${h}»`);
  if (v.sectionsWithout.length)
    f.push(`${at}: секции без заголовка: ${v.sectionsWithout.slice(0, 3).join(", ")}`);
  if (v.imgsWithoutAlt) f.push(`${at}: картинок без alt: ${v.imgsWithoutAlt}`);
  if (v.numbered >= 2) f.push(`${at}: нумерация «01/02/03»`);
  if (v.eyebrows) f.push(`${at}: подписи капслоком над заголовками: ${v.eyebrows}`);
  for (const form of v.forms) {
    if (!form.contact) f.push(`${at}: в форме нет поля телефона или email с проверкой`);
    if (!form.required) f.push(`${at}: в форме нет обязательных полей`);
    if (!form.blocksEmpty) f.push(`${at}: пустая форма отправляется`);
  }
  if (PLACEHOLDER_TEXT.test(v.text)) f.push(`${at}: заглушка-рыба (lorem, «your company»…)`);
  if (v.reviews) f.push(`${at}: отзывы с именами — выдуманы (бриф их не давал)`);
  const invented = inventedNumbers(v.text, brief);
  if (invented.length) f.push(`${at}: числа не из брифа: ${invented.slice(0, 5).join(", ")}`);
  return { failures: f };
}

/**
 * Проверка сайта-визитки в папке задачи. `brief` — просьба пользователя (числа из неё можно), `must` — что про
 * бизнес обязано быть на странице (название, город).
 */
export async function checkLanding(ws, brief, must = []) {
  const file = entryOf(ws);
  if (!file) return { ok: false, note: "нет .html" };
  const html = readFileSync(file, "utf8");
  const sources = findFiles(ws, [".html", ".js"])
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const failures = staticFailures(html, sources);
  const text = html.replace(/<[^>]+>/g, " ");
  for (const m of must)
    if (!new RegExp(m, "iu").test(text)) failures.push(`на странице нет «${m}» из брифа`);
  for (const viewport of WIDTHS) {
    const r = await browserFailures(file, viewport, brief);
    if (r.skipped) return { ok: null, skipped: true, note: "нет браузера для проверки страницы" };
    failures.push(...r.failures);
  }
  const unique = [...new Set(failures)];
  return {
    ok: unique.length === 0,
    note: unique.length
      ? `замечаний ${unique.length}: ${unique.slice(0, 4).join("; ")}`
      : "все правила визитки выполнены",
    failures: unique,
  };
}
