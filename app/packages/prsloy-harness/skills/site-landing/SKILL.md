---
name: site-landing
description: "Сайт-визитка, лендинг, страница с меню или формой заявки. One HTML file, relative paths, mobile-first, one goal and one main action, ideas from the client's own facts, a form without a backend."
---

# Сайт-визитка / лендинг

## Before you write

1. **One goal → one action.** Decide what a visitor should do (call, book, order, come over). One main button for
   it on the first screen, labelled with a verb and what they get: «Записаться на маникюр», «Заказать с собой».
   Never «Подробнее», «Отправить», «Далее».
2. **The idea comes from this client, not from the genre.** Write down 2–3 things only this client has, taken from
   the user's words: the name and what it means, the street, the hours, the price they gave, how they work. Build
   the headline and the first screen on them. Check: swap in the nearest competitor — if the page still fits,
   it is a template, rewrite it.
3. **Never invent facts.** No made-up prices, years, numbers of clients, reviews, awards or photos of «our team».
   Use only what the user said; for the rest, clear placeholders («+7 (000) 000-00-00», «адрес — замените») and a
   line in the final message about what to replace.

## Page

- Sections, each with its own heading (`h2`): what you offer → why trust it → FAQ → the form or contacts →
  footer. Exactly one `h1`, on the first screen. Headings fit in two lines on a phone.
- **Proof next to the claim.** «Работаем без выходных» → the hours right there; «рядом с домом» → the street.
  No claim without its fact.
- **FAQ and removing the risk:** 2–4 real questions a visitor has before calling (how to book, can I cancel or
  move, how much). Answer plainly.
- **Footer with contacts:** name, address or area, phone (placeholder if not given), hours.
- **States:** buttons have hover and visible keyboard focus (`:focus-visible`); fields show an error next to the
  field in words, not `alert()`; the button says what happens («Записаться»), and a short «Спасибо, перезвоним»
  appears after sending.
- Head: `<title>` with the name and what it is, `<meta name="description">`, `<html lang="ru">`, viewport meta.
- Images only if you have them: every `img` has `alt`. Otherwise CSS, colour and inline SVG — never pictures that
  do not exist.

## Do not

- lorem ipsum, English placeholder text («Your company», «Lorem»);
- «01 / 02 / 03» section numbers, small capslock labels above headings, three identical icon cards;
- invented reviews, numbers or prices (see 3);
- absolute paths (`/style.css`), `type="module"`, `alert()`.

## Build

1. One folder: `index.html`, plus `style.css` and `form.js` when they grow. No build tool, no framework: the user
   opens the page by double click or in the preview. Start from `template.html` next to this file and change it.
2. Relative paths everywhere: `./style.css`, `./img/photo.jpg`. Plain `<script src="./form.js">`.
3. Mobile-first: base CSS for a 390 px phone, `@media (min-width: 768px)` for wider screens, `max-width: 100%`
   on images, no fixed widths wider than the phone, nothing scrolls sideways.
4. Texts in Russian, short and warm, in the client's voice.
5. Preview: `python -m http.server 8000` with bash_background in the project folder, give the user
   `http://127.0.0.1:8000/`; stop it with the process tool when done.

## Form without a backend

A static page cannot send email by itself. Validate in the browser: name `required`, phone `type="tel"` with a
pattern (or email `type="email"`), errors shown next to the fields. Then one honest option, and tell the user:

- `mailto:` — opens the visitor's mail app; no account needed, but some visitors have no mail app;
- a form service such as Formspree (`action="https://formspree.io/f/{form_id}"`): the user creates a free account
  and gives you the form id (ask for it with ask_user); until then leave a clear placeholder. Never pretend the form
  already delivers mail.

## Check before you say «готово»

The app opens the page in a real browser at 390 and 1440 px at the end of your turn and tells you about errors.
Do not install jsdom, puppeteer or browsers yourself. Look at your page against the lists above: one `h1`, the
main button visible without scrolling, a heading in every section, no invented facts, nothing scrolls sideways.

## Sources

- Viewport meta: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport
- `<form>` and validation: https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Form_validation
- Formspree HTML forms: https://formspree.io/html/
- Landing ideas (one goal, proof next to claim, FAQ, states): elayadesign `landing-page-design`, Leonxlnx `taste-skill` (MIT) — ideas only, see research/29.
