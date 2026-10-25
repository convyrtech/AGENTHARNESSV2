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
