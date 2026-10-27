# PRSLOY — карта устройства

Срез: 2026-10-27, `main` 1284c47, релиз `v0.1.0-alpha.2` (готовится `alpha.3`, заметки — `app/docs/prsloy/RELEASE-NOTES-alpha.3.md`). Карта для людей и новых сессий агентов: что есть, как
связано, где лежит, что планируется. Подробности — в файлах по ссылкам. Очередь работы — GitHub Issues
(`convyrtech/AGENTHARNESSV2`), история и замеры — `DIARY.md`, правила потоков — `app/docs/prsloy/CONTEXT.md`.

## 1. Что это

Приложение для Windows на русском для новичков. Две вкладки: **«Код»** — агент пишет сайты, ботов, скрипты в папке
проекта; **«Дизайн»** — дирижёр шаг за шагом собирает лендинг. Модели — через шлюз владельца
`https://api.prsloy.online/v1` (OpenAI-совместимый). Основа — форк Zeno: Electron 43 + React 19 + Pi SDK 1.4.0
(`@earendil-works/pi-coding-agent`), всё в `app/`.

## 2. Как идёт запрос во вкладке «Код»

```
Окно (renderer, React)
  └─ preload: window.zeno.*  ──IPC zeno:* / prsloy:*──►  Main (Electron, Node)
        main/index.ts — супервизор, ~319 каналов zeno:*, 54 канала prsloy:*
        └─ utilityProcess «PRSLOY Agent Host» (agent-host/index.ts)
              └─ Pi SDK: createPixRuntime (@zeno/agent-runtime)
                    расширения по порядку: 1) граница записи  2) харнесс @prsloy/harness
                    └─ провайдер prsloy → обёртки: prsloy-fetch (128k→64k→32k, смена модели на 404)
                                         → прокси надёжности харнесса → шлюз → модели
  ◄── события хоста zeno:host:event → лента чата (карточки харнесса, статус хода)
```

Перед каждым ходом main делает снимок проекта в теневой git (`main/prsloy/turn-snapshots.ts`) — «Откатить ход».
Ключ шлюза: `safeStorage` → `userData/prsloy/gateway-key.bin`; в хост — через env, и сразу стирается
(`agent-host/prsloy-handoff.ts`), инструменты его не видят.

## 3. Вкладка «Дизайн»

```
DesignPage ─prsloy:design:*─► main/design/service.ts
   ├─ a6proxy.py (локальный порт, держит ключ) ─► шлюз
   └─ run.py init/say  (playbooks/site/harness/run.py — дирижёр)
        ├─ flow.py пайплайна выбирает шаг (0…8)
        ├─ на каждый шаг — свежая сессия Pi CLI (модель с лестницы stages.json: deepseek → kimi → qwen → opus)
        ├─ проверки: check.py, brand_check.py; судья judge.py (opus, 12 вопросов «да/нет», вердикт кодом)
        ├─ second_opinion.py перед каждым письмом владельцу; вопросы — только инструментом ask_owner
        └─ события JSONL ─► main/design/events.ts ─► карточки, «Шаг N из 8»
   после «готово»: превью (loopback-сервер), «Править», «Настроить», красные пометки, архив
```

Пайплайн дизайна приватный (`convyrtech/design-pipeline`); правки к нему — только `playbooks/site/harness/pipeline-fixes.patch`.

## 4. Харнесс «Кода» — кто следит за агентом

`app/packages/prsloy-harness/src`, точка входа `index.ts` → `createPrsloyHarness`. Каждая практика выключается
через `disable`. «Хуки» здесь — обработчики событий Pi (`pi.on(...)`), не хуки Claude Code.

| Когда | Что делает | Модули (события Pi) |
|---|---|---|
| До хода | системный промпт, память, уроки, «прошлый раз», навыки | `reuse-prompt`, `code-prompt`, `memory`, `lessons`, `digest`, `skills` (before_agent_start, session_start, resources_discover) |
| Во время | чинит аргументы, ловит петли и утечки разметки, режет большой вывод, проверяет синтаксис после правки, таймауты bash и фоновые процессы, бюджет, секреты | `arg-repair`, `loop-detector`, `tool-leak`, `tool-output`, `post-edit-verify`, `edit-robustness`, `bash-timeout`, `budget`, `secret-scrub` (tool_call, tool_result, message_end) |
| Инструменты агента | `ask_user` (кнопки), `request_secret` (ключ в `.env`), `find_ready` (готовые пакеты), `memory`, `bash_background`, `process` | `ask-user`, `request-secret`, `find-ready`, `memory`, `bash-timeout` (registerTool) |
| В конце хода | «до зелёного»: проверка проекта со снимка начала хода, проверка страницы в браузере, второе мнение другой модели, «Понял так» | `stop-gate`, `gate-signals`, `page-check`, `second-opinion`, `reviewer`, `vague-request` (agent_before_settle) |
| После сжатия истории | нить задачи: факты из сессии и git + «продолжай, не начинай заново» (флаг `taskThread`, выкл. до замера, #64) | `task-thread` (session_compact, context, session_start) |
| Всегда | журнал обучения без текстов, прокси надёжности к шлюзу (в нём проверка подмешки чужого промпта — пишет в лог) | `learning-log`, `reliability(-proxy)` |

Флаги (`flags.ts`, файл `<agentDir>/prsloy-harness.json`, тот же белый список в `main/harness-flags.ts`):
`secondOpinion` вкл · `lessons` вкл · `prompt: prsloy` · `skills` выкл · `memory` вкл · `autoMemory` вкл (сама
автопамять — в ядре, `main/prsloy/memory-extractor.ts`; в харнессе только точка подключения) · `webTools` вкл ·
`testGuard` вкл (#25) · `staleDocs: end` · `honestExit` / `claimCheck` / `testQuality` / `reviewerCheats` выкл (код
готов, ждёт замера) · `taskThread` выкл (#64). Сверено с `flags.ts` 27.10.

## 5. Точки расширения

- **Расширения Pi** — в процессе: граница записи и харнесс (`agent-runtime/src/index.ts`, `extensionFactories`).
- **Навыки** — 8 курированных в `prsloy-harness/skills/` (игра, Excel, объяснить проект, починить код, Python на
  Windows, лендинг, бот Telegram, сбор данных); пишутся в `<agentDir>/prsloy-skills/`; флаг `skills`, пока выкл.
- **MCP** — есть от Zeno (`main/mcp-config.ts`, `<agentDir>/mcp.json`, раздел в «Пакетах»), **в PRSLOY выключен по
  умолчанию** (`-builtin:mcp`, без авто-установки адаптера); виден только в режиме «Для разработчиков».
- **Пакеты Pi (плагины)** — галерея npm/git от Zeno, только для разработчиков.
- **Рецепты** — 5 офлайн-стартеров (`main/features/recipes/*`), формат шаблона Pi, заполняет main.

## 6. Где лежат данные (Windows)

| Что | Где |
|---|---|
| Профиль | `%APPDATA%\PRSLOY` (переживает удаление программы) |
| Pi агента | `…\PRSLOY\agent` (`models.json`, `settings.json`, `sessions\`, `prsloy-harness.json`) |
| Память | `…\agent\prsloy-memory\` (`user.json`, `projects\<hash>\project.json`, `journal.jsonl`) |
| Журнал обучения | `…\agent\prsloy-learning\events.jsonl` |
| Ключ шлюза, состояние | `…\PRSLOY\prsloy\` (`gateway-key.bin`, `state.json`) |
| Снимки «Откатить ход» | `…\PRSLOY\snapshots\` |
| Среды (Node, Python, Git) | `…\PRSLOY\runtimes\` |
| Логи | `…\PRSLOY\logs\main.log` |
| «Дизайн» | `…\PRSLOY\design\` (venv, свой Pi, пайплайн), проект — `<папка>\prsloy-design` |
| Проекты по умолчанию | `Документы\PRSLOY\<дата>` |
| Программа | `%LOCALAPPDATA%\Programs\PRSLOY` |

## 7. Сборка, обновления, CI

- `desktop-ci` (Linux): проверки, юнит-тесты, e2e в 2 частях, layout-lint в двух темах.
- `desktop-windows`: установщик NSIS → smoke на 2 Windows → проверка автообновления → релиз. **Кнопка релиза:**
  Actions → desktop-windows → Run workflow → `version` (`app/docs/prsloy/RELEASE-HOWTO.md`).
- `design-windows`: «Дизайн» на Windows и на установленной сборке.
- `desktop-audit`: ночью в 01:17 UTC разборщик сессий кодом по бенчу и e2e.
- Автообновление: electron-updater с GitHub Releases (`main/auto-update.ts`, `update-provider.ts`).

## 8. Что работает (кратко)

Первый запуск (ключ → папка), модели из `/v1/models`, «Быстрее / Качественнее», цена в рублях, «Откатить ход»,
отчёт в поддержку, автообновление, граница записи · тема и анимации, клавиатура, строка статуса хода · превью и
«Выбрать на странице», «Ошибка → Починить», архив, история версий, «Что дальше», снимок части страницы, поиск по
чатам, рецепты, «Бот работает · Остановить · Журнал», карточки и панель памяти · харнесс (§4), промпт PRSLOY,
бенч честности · «Дизайн» целиком с правками после сборки · разборщик сессий · импорт чатов из других программ ·
Linux (.deb, AppImage) · поиск в интернете (бесплатный, свои ключи, в т.ч. Tavily, переход при лимите) ·
карточка «старые тесты устарели» · pytest и .venv проекта в проверке · версия в настройках.

## 9. Что планируется

| Тема | Этапы | Issues | Основа |
|---|---|---|---|
| Честность агентов | H-1 страж тестов и `report_blocker`, H-1p диета промпта, H-2 слова и факты + статус хода, H-3 полезность тестов, H-4 ревьюер | #5 #6 #7 #8 #9 | `research/22`, `research/24` §4 |
| Авто-память | M-2/M-3 сигналы и тень, M-3b/M-4 авто-запись и забывание, M-5 только явное, M-6 A/B | #13 #14 #15 #16 | `research/21`, `research/24` §3 |
| Разборщик сессий | A-1/A-2 набор и судья, A-3 мост в рефлектор и паттерны | #19 #20 | `research/23`, `research/24` §6 |
| Поиск для агента | `web_search` / `web_fetch`, бесплатная цепочка, GitHub; потом режим «Исследовать» | #23 #31 | `research/26` |
| Импорт сессий | I1 экран первого запуска, I2 другие источники | #22 | `research/25` |
| «Дизайн» | параллельный шаг 5 (A/B), выкладка в РФ | #21 #24 | `research/20` |
| Решения владельца | хранилище разметки, A/B страниц, канал поиска в шлюзе | #26 #27 #31 | — |
| **Фундамент** | нить задачи (сделано, за флагом) → ворота опасных действий → «не проверено» вместо тишины → независимый судья → честный канал | #64 #61 #62 #70 | #64, #68 |
| Навыки | маршрутизатор навыков (ветка), потом сквозной замер | #42 | #42 |
| Деньги и картинки | остаток и точная цена хода через API учёта шлюза; картинки через `/v1/images/generations` | #56 #52 #69 | — |
| Следующий выпуск | всё, что не вошло в alpha.3 | #71 | — |

## 10. Как мы работаем

Дирижёр (главная сессия) раздаёт задачи потокам — отдельным сессиям агентов, у каждого своя ветка
`desktop/<поток>`: **core** (main, провайдер, память), **harness** (харнесс «Кода»), **features** (функции UI),
**ui** (интерфейс, тема, импорт), **design** (вкладка «Дизайн», поиск), **ci** (сборка, разборщик). Сливает в `main`
только дирижёр, после зелёного CI. Изменения поведения — за флагами, включаются по замеру на бенче
(`app/packages/prsloy-harness/bench`, правило — `research/24` §5). Исследования — `research/NN-*.md`.
