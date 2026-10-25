---
name: site-landing
description: "Сайт-визитка, лендинг, страница с меню или формой заявки. One HTML file, relative paths, mobile-first, preview via bash_background, a form without a backend."
---

# Сайт-визитка / лендинг

## Plan

1. One folder, one `index.html`, plus `style.css` and `script.js` only if they grow past ~100 lines. No build tool,
   no framework: the user opens the page by double click or in the preview. Start from `template.html` next to this
   file.
2. Relative paths everywhere: `./style.css`, `./img/photo.jpg`. Never `/style.css` — opened as a file it points to
   the disk root. Plain `<script src="./script.js">`, not `type="module"` (a module script does not load from
   `file://`).
3. Mobile-first: `<meta name="viewport" content="width=device-width, initial-scale=1">`, base CSS for a 390 px
   phone, `@media (min-width: 768px)` for wider screens. Images: `max-width: 100%; height: auto`. No fixed widths
   wider than the phone.
4. Texts in Russian. Do not invent facts about the business (prices, address, phone, reviews): use clear
   placeholders like «+7 (000) 000-00-00» and say in the final message what to replace.
5. Preview: start `python -m http.server 8000` with bash_background in the project folder and give the user
   `http://127.0.0.1:8000/`. Stop it with the process tool when it is no longer needed.

## Form without a backend

A static page cannot send email by itself. Two honest options — tell the user which one you chose:

- `mailto:` link or `<form action="mailto:…">`: opens the visitor's mail app; works without any account but some
  visitors have no mail app configured.
- A form service such as Formspree: `<form action="https://formspree.io/f/{form_id}" method="POST">`. The user
  must create a free account and give you the form id (or the email it sends to). Ask for it with ask_user or leave
  a clear placeholder; never pretend the form already delivers mail.

## Check before you say «готово»

- The page opens in the preview without console errors.
- At 390 px nothing scrolls sideways, buttons do not overlap, text is not cut.
- Every link and image path is relative and the files exist.

## Sources

- Viewport meta: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport
- Responsive design: https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/CSS_layout/Responsive_Design
- `<form>`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/form
- Formspree HTML forms: https://formspree.io/html/
