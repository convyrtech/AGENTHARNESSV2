# PRSLOY Desktop

Форк [aletheics/zeno](https://github.com/aletheics/zeno) (MIT, коммит `2acb419`, 2026-10-02), Pi обновлён до 1.4.0.
Лицензия Zeno сохранена в `LICENSE`. Изменения PRSLOY: бренд, русский интерфейс, провайдер PRSLOY, харнесс
(`../playbooks/site/harness`), вкладка «Дизайн». План: `../PLAN-alpha.md`.

## Код из открытых проектов

- `apps/desktop/src/main/preview-bridge/inspector.js` — по мотивам `public/inspector-script.js` из
  [stackblitz-labs/bolt.diy](https://github.com/stackblitz-labs/bolt.diy) (коммит `353b44c`). MIT License,
  Copyright (c) 2024 StackBlitz, Inc. and bolt.diy contributors. Изменено PRSLOY: убрана правка стилей и текста,
  добавлены точный CSS-путь, кусок `outerHTML` и отмена по Esc.
