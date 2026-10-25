# PRSLOY Desktop

Форк [aletheics/zeno](https://github.com/aletheics/zeno) (MIT, коммит `2acb419`, 2026-10-02), Pi обновлён до 1.4.0.
Лицензия Zeno сохранена в `LICENSE`. Изменения PRSLOY: бренд, русский интерфейс, провайдер PRSLOY, харнесс
(`../playbooks/site/harness`), вкладка «Дизайн». План: `../PLAN-alpha.md`.

## Заимствования

- `packages/prsloy-harness/src/request-secret.ts` — описание инструмента и параметров `request_secret` по
  [OpenHands Agent Canvas](https://github.com/All-Hands-AI/OpenHands) `src/api/request-secret-client-tool.ts`
  (коммит `b185939`), MIT, © 2025 OpenHands contributors. Изменено PRSLOY: ответ приходит в результате вызова,
  ключ хранится в `.env` проекта.
- `packages/prsloy-harness/src/ask-user.ts` — схема вопроса с вариантами по мотивам Roo Code
  `ask_followup_question` (коммит `b867ec9`, Apache-2.0, © Roo Code contributors). Код не копировался.
- `apps/desktop/src/main/preview-bridge/inspector.js` — по мотивам `public/inspector-script.js` из
  [stackblitz-labs/bolt.diy](https://github.com/stackblitz-labs/bolt.diy) (коммит `353b44c`). MIT License,
  Copyright (c) 2024 StackBlitz, Inc. and bolt.diy contributors. Изменено PRSLOY: убрана правка стилей и текста,
  добавлены точный CSS-путь, короткий фрагмент элемента, «номер N из M», место в исходнике (`data-pl`) и отмена
  по Esc. Идеи без кода: короткий фрагмент — react-grab `html-preview.ts` (MIT), «номер N из M» —
  screenshot-to-code `select-and-edit/utils.ts` (MIT), формат события — Open CoDesign `overlay.ts` (MIT).
- `apps/desktop/src/renderer/lib/next-steps.ts` — правила разбора по образцу `src/lib/suggestedPrompts.ts` из
  [dyad-sh/dyad](https://github.com/dyad-sh/dyad) (коммит `1be2b4b`, вне `src/pro/`). Apache License 2.0,
  Copyright (c) Dyad contributors; текст лицензии — `licenses/dyad-Apache-2.0.txt`. Изменено PRSLOY: свой тег
  `<prsloy-next>`, разбор регулярным выражением, запасные подсказки по файлам хода. Из `NOTICE` Dyad: «Dyad.
  Copyright (c) Dyad contributors.»
- `apps/desktop/src/main/features/session-search.ts` — по мотивам `packages/pi-host/src/session-search.ts` из
  [Skitre/PiDeck](https://github.com/Skitre/PiDeck) (PiCove, коммит `102d9e1`). MIT License, Copyright (c) 2026
  PiDeck contributors. Изменено PRSLOY: «ё» = «е», без папки архива, вырезаются блоки `<attached-paths>`,
  название чата — первая просьба, чаты без проекта прямо в `sessions/`.
- [parse5](https://github.com/inikulin/parse5) 8.0.1 — зависимость, собирается в main (разметка `data-pl` в превью
  «Кода»). MIT License, Copyright (c) 2013-2019 Ivan Nikulin and other parse5 contributors.
