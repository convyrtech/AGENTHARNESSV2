# PRSLOY Desktop

Форк [aletheics/zeno](https://github.com/aletheics/zeno) (MIT, коммит `2acb419`, 2026-10-02), Pi обновлён до 1.4.0.
Лицензия Zeno сохранена в `LICENSE`. Изменения PRSLOY: бренд, русский интерфейс, провайдер PRSLOY, харнесс
(`../playbooks/site/harness`), вкладка «Дизайн». План: `../PLAN-alpha.md`.

## Заимствования

- `packages/prsloy-harness/bench/tasks/impossiblebench/` и `bench/import/fetch-honesty.mjs` — задачи
  Impossible-LiveCodeBench. Данные в репозиторий не входят: скрипт качает датасет
  [fjzzq2002/impossible_livecodebench](https://huggingface.co/datasets/fjzzq2002/impossible_livecodebench) (ревизия
  `98650ff`, лицензия на карточке не указана) в локальный кэш. Раскладка `func.py` / `test.py`, текст просьбы и
  правила разбора (правка теста — подгонка; виды подгонки A–E) — по
  [safety-research/impossiblebench](https://github.com/safety-research/impossiblebench) (коммит `d4f9a14`,
  `livecodebench_tasks.py`, `livecodebench_agent_full.py`, `analysis/llm_judge.py`), MIT License, Copyright (c)
  2025 ImpossibleBench Team. Варианты `syn-*` в git — свои задачи в том же формате.
- `packages/prsloy-harness/bench/import/evilgenie_vendor.py` — дословно функции `extract_function_signature`,
  `generate_solution_stub`, `generate_test_script`, `generate_problem_description` из
  [JonathanGabor/EvilGenie](https://github.com/JonathanGabor/EvilGenie) `src/problem_setup.py` (коммит `4b81d3d`).
  MIT License, Copyright (c) 2025 LiveCodeBench Contributors, Jonathan Gabor. По ним `evilgenie_build.py` строит
  папки агента, по их `canonical_splits/v5v6_hard_154p.json` и `multiple_solution_problems.txt` выбираются
  отложенные тесты и неоднозначные задачи. Условия и тесты задач —
  [livecodebench/code_generation_lite](https://huggingface.co/datasets/livecodebench/code_generation_lite)
  `test6.jsonl` (ревизия `0fe84c3`, на карточке лицензия «cc» без уточнения). В репозиторий не входят: их качает
  `fetch-honesty.mjs` в локальный кэш. Варианты `syn-*` в git — свои задачи, сделанные тем же кодом.
- [hyparquet](https://github.com/hyparam/hyparquet) 1.31.3 — dev-зависимость `prsloy-harness`: чтение parquet в
  `fetch-honesty.mjs`. MIT License (строки copyright в их LICENSE нет).
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
- `../playbooks/site/harness/judge_questions.py` — приём «фиксированные вопросы да/нет с причиной, неотвеченный =
  нет, статус из числа да» по [Open CoDesign](https://github.com/OpenCoworkAI/open-codesign)
  `packages/core/src/tools/verify-ui-kit-visual-parity.ts`, MIT, © 2026 OpenCoworkAI Contributors. Вопросы и код свои.
- `apps/desktop/src/main/design/tokens.ts`, `src/renderer/components/design/TokenPanel.tsx` — «Настроить»: ручки
  токенов бренда без модели по идее протокола tweaks из
  [OpenCoworkAI/open-codesign](https://github.com/OpenCoworkAI/open-codesign) (коммит `4cf3393`,
  `packages/runtime/src/tweaks-bridge.ts`, `apps/desktop/src/renderer/src/preview/tweak-persistence.ts`). MIT License,
  Copyright (c) OpenCoworkAI. Код не копировался: у нас статический HTML, значения подставляет сервер превью.
- `apps/desktop/src/main/design/text-overlay.js` — «Править», текст двойным щелчком: по идее
  [dyad-sh/dyad](https://github.com/dyad-sh/dyad) `worker/dyad-visual-editor-client.js` (contentEditable, текст уходит
  в приложение при выходе из поля). Apache License 2.0, авторы dyad-sh/dyad. Код не копировался; запись в
  исходник у Dyad (`src/pro/`, FSL) не смотрели и не брали.
- `apps/desktop/src/main/design/text-edit.ts` — запись этого текста в файл страницы по правилам `SOURCE_EDITING.md`
  из [OpenCoworkAI/open-codesign](https://github.com/OpenCoworkAI/open-codesign) (MIT, Copyright (c) OpenCoworkAI):
  место — только точное (позиции parse5), иначе отказ с причиной. Код не копировался.
- `../playbooks/site/harness/brand_check.py` — «только цвета бренда» и CSS-слоп. Пороги ΔE по
  [dembrandt](https://github.com/dembrandt/dembrandt) `lib/drift.ts` (MIT, `DEFAULT_DRIFT_CONFIG`: colorSame 2.3,
  colorShift 15). Список правил — OpenDesign `apps/daemon/src/lint-artifact.ts` (Apache-2.0): purple-gradient,
  ai-default-indigo, emoji-icon, raw-hex, all-caps-no-tracking, left-accent-card. Код не копировался, правила
  переписаны на Python заново.
- `apps/desktop/src/renderer/components/design/MarksDialog.tsx`, `src/main/design/marks.ts` и строка о пометках в
  `../playbooks/site/harness/run.py` — красные пометки на картинке. Правило «красное — пометки, не дизайн» — по идее
  системного промпта [tldraw/make-real](https://github.com/tldraw/make-real) (`prompts/anthropic-system-prompt.md`,
  Interpretation Rules). Ни кода, ни текста промпта, ни холста tldraw не брали.
- `../playbooks/site/harness/ask_owner.ts` — вопрос владельцу инструментом Pi. Форма — по
  [OpenCoworkAI/open-codesign](https://github.com/OpenCoworkAI/open-codesign) `packages/core/src/tools/ask.ts`
  (коммит `4cf3393`, MIT License, Copyright (c) OpenCoworkAI): типы вопросов и чистая функция проверки, общая для
  инструмента и тестов. Код не копировался: у нас два типа (text-options, freeform) и правила сообщения владельцу
  из пайплайна.
- `../playbooks/site/harness/run.py` (параллельные прототипы шага 5, `parallel_protos`) — по идее
  [abi/screenshot-to-code](https://github.com/abi/screenshot-to-code) (MIT): несколько вариантов одним вызовом на разных
  моделях параллельно, блок дизайн-системы в задании с правилом «при конфликте побеждает дизайн-система»
  (`backend/prompts/design_system.py`, `backend/routes/generate_code.py`). Ни кода, ни текста промптов не брали.
- `../playbooks/site/harness/brand_probe.py` — бренд по адресу сайта: по мотивам
  [dembrandt](https://github.com/dembrandt/dembrandt) (MIT, v0.39.2, вычисленные стили живой страницы) и методики
  `skills/brand-extract/SKILL.md` OpenDesign (Apache-2.0: «каждое значение — замер»). Код не копировался.
- Формат рецептов `apps/desktop/src/main/features/recipes/*/recipe.md` (ключ `params:` с `key`, `input_type`,
  `requirement`, `default`, `options`) — по образцу рецептов [block/goose](https://github.com/block/goose)
  (`crates/goose/src/recipe/mod.rs`, Apache License 2.0, Copyright (c) Block, Inc.). Код не копировался.
- [yaml](https://github.com/eemeli/yaml) 2.9.0 — зависимость, собирается в main (frontmatter рецептов). ISC License,
  Copyright Eemeli Aro.
- `packages/session-import/src/adapters/claude-code.ts`, `adapters/codex.ts`, `adapters/opencode.ts`, `sqlite-snapshot.ts`,
  `clean.ts` — перенос чатов Claude Code, Codex и OpenCode (старая схема, снимок SQLite с WAL) по образцу TypeScript-адаптеров [cline/cline](https://github.com/cline/cline)
  (`sdk/packages/core/src/services/session-import/`, коммит `40c5d99`). Apache License 2.0, Copyright 2026 Cline Bot
  Inc.; текст лицензии — `licenses/cline-Apache-2.0.txt`. Взяты: восстановление активной ветки по `parentUuid`,
  пропуск `<synthetic>`-моделей, какие записи Codex — слова человека, а какие — подмешанный контекст, самый полный
  файл на один id, названия из `session_index.jsonl`. Изменено PRSLOY: чтение потоком (и `.jsonl.zst`), только текст
  с однострочными заметками об инструментах, выводы инструментов и размышления не переносятся, секреты скрываются,
  папки субагентов пропускаются, запись в обычный файл сессии Pi со сводкой и сменой модели.
- `packages/session-import/src/title.ts`, `clean.ts`, `ledger.ts`, правила в `adapters/claude-code.ts` — по правилам
  импорта [openai/codex](https://github.com/openai/codex) (`codex-rs/external-agent-migration/src/sessions/`, коммит
  `970111f`). Apache License 2.0; текст лицензии — `licenses/codex-Apache-2.0.txt`. Из `NOTICE` Codex: «OpenAI Codex.
  Copyright 2025 OpenAI.» Взяты: порядок названий (своё → от агента → первая строка, 120 знаков), список служебных
  обёрток, пропуск `continued-in`, журнал импорта с sha256, по умолчанию 30 дней и не больше 50 чатов. Изменено PRSLOY:
  перенесено с Rust на TypeScript, обёртки вырезаются в любом месте текста, журнал — свой JSON в папке данных PRSLOY.
- `packages/session-import/src/adapters/opencode.ts` — текущая схема OpenCode (`session_v2`, `session_message`) прочитана
  по определениям [sst/opencode](https://github.com/sst/opencode) (`packages/core/src/session/sql.ts`,
  `packages/schema/src/session-message.ts`, коммит `450e7b9`). MIT License, Copyright (c) 2025 opencode. Код не копировался.
