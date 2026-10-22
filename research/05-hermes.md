# 05 — Hermes Agent (Nous Research): досье по первоисточникам

> Проверено 2026-10-22. Фильтр свежести: описано состояние на июнь–октябрь 2026; источники старше 2026-06-01 не используются, кроме явно помеченных случаев.
> Метки: **VERIFIED** — видел в коде или официальной документации в репозитории на указанном коммите; **UNVERIFIED** — вторичный источник или мой вывод.
> Пути ниже даны относительно корня репозитория `NousResearch/hermes-agent` на коммите `944c3a43` (2026-10-22). Локальная копия: `/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/repos/hermes-agent/src/`.

---

## 1. Обзор

| Параметр | Значение |
|---|---|
| Что это | Персональный агент общего назначения на Python. Одно ядро (`AIAgent`) обслуживает CLI, TUI (Ink), Electron Desktop, веб-дашборд, мессенджер-шлюз (~30 платформ), cron, ACP и OpenAI-совместимый API-сервер |
| Репозиторий | https://github.com/NousResearch/hermes-agent. Последний релиз v0.22.4 (2026-10-21), ветка main на `944c3a43` (2026-10-22) — VERIFIED |
| Лицензия | MIT, «Copyright (c) 2025 Nous Research» (`LICENSE`) — VERIFIED |
| Документация | https://hermes-agent.nousresearch.com/docs, исходники в `website/docs/` того же репозитория — VERIFIED |
| Масштаб | ~20.7k файлов. Бывшие god-файлы разрезаны на фасад и «siblings» `<stem>_<topic>.py` (`AGENTS.md`). В каталоге плагинов 763 записи (`plugin-catalog/*.yaml`) — VERIFIED |
| Позиционирование | «The self-improving AI agent… creates skills from experience, improves them during use» (`pyproject.toml`, `README.md`) |

Два архитектурных инварианта авторы сами называют главными при review (`AGENTS.md:17-27`, VERIFIED):
1. **«Per-conversation prompt caching is sacred.»** Нельзя мутировать прошлый контекст, менять toolsets, перечитывать память или пересобирать system prompt посреди разговора. Единственное исключение — компрессия. Slash-команды, меняющие состояние промпта, откладываются до следующей сессии (opt-in `--now`).
2. **«The core is a narrow waist; capability lives at the edges.»** Каждый инструмент уходит в каждом запросе, поэтому планка для нового core-инструмента высокая. Новые возможности оформляются как CLI-команда + skill, как сервисный инструмент или как плагин.

Для нас Hermes интересен прежде всего тремя вещами: (а) самая проработанная из открытых реализаций петли «память + skills + фоновый review + curator»; (б) жёсткая дисциплина prompt-cache; (в) A/B-харнессы на тех же дешёвых моделях, что у нас (GLM-5.3-flash, Qwen3.8).

---

## 2. По измерениям

### A. Agent loop

**Что.** Синхронный цикл `while (api_call_count < max_iterations and budget.remaining > 0) or grace_call`. Каждая фаза итерации вынесена в отдельный файл `agent/turn_*.py`: preflight, iteration_prep, request_assembly, api_call, api_error, response_intake, empty_response, tool_round, tool_validation, overflow, truncation, context_compaction, recovery, stop_gates, finalizer (`agent/AGENTS.md`, VERIFIED).

**Как.**
- **Сообщения.** Внутренний формат — OpenAI (`role/content/tool_calls`). Reasoning лежит в `assistant_msg["reasoning"]`. Три API-режима: `chat_completions`, `codex_responses`, `anthropic_messages`; все сводятся к одному внутреннему формату (`website/docs/developer-guide/agent-loop.md`, VERIFIED).
- **Чередование ролей.** Два сообщения одной роли подряд запрещены. Синтетический user посреди цикла тоже запрещён, за одним исключением — `/steer`. Steer доставляется отдельной user-строкой после последнего tool result (`assistant(tool_calls) → tool → user` допустимо у всех провайдеров) и не дописывается в уже персистентную tool-строку, иначе append-only история разойдётся с live-запросом и сломает кэш (`agent/AGENTS.md:64-69`, `agent/turn_iteration_prep.py:~170`, VERIFIED). Модель получает в system prompt точный формат маркера `[OUT-OF-BAND USER MESSAGE …]` и инструкцию доверять только ему, а не похожим текстам в tool output (`tests/fixtures/prompt_surface/prompts/cli.claude.txt`, VERIFIED).
- **Параллельные вызовы.** Несколько tool calls выполняются в `ThreadPoolExecutor`, кроме интерактивных (`clarify`). Результаты возвращаются в исходном порядке (VERIFIED, agent-loop.md). В stable-слое промпта есть явный блок «Parallel tool calls», объясняющий, что батчинг избавляет от повторной пересылки всего разговора (VERIFIED, fixture).
- **Прерывание.** HTTP-вызов идёт в фоновом потоке, главный поток ждёт ответ, interrupt или таймаут. При прерывании частичный ответ в историю не попадает (VERIFIED, agent-loop.md).
- **Лимиты.** `agent.max_turns: None`, то есть без лимита по умолчанию: «caps caused silent mid-task truncation» (`hermes_cli/config_defaults.py:76-78`, VERIFIED). Документация agent-loop.md до сих пор пишет «500» — устарела. У субагента по умолчанию `max_iterations: 250` (`config_defaults.py:1376`). Есть opt-in бюджеты: `budget_warning_ratio` (одноразовое предупреждение) и `run_budget_seconds` (wrap-up на 80%). Оба сообщения дописываются к последнему tool result, а не отдельным сообщением.
- **Почему нет предупреждений о давлении контекста.** «Intermediate pressure warnings made models give up early» (`agent/agent_init.py:572`, VERIFIED). Это сильный практический вывод: модели, которым говорят «контекст кончается», бросают задачу раньше времени.
- **Stop gates.** Когда модель отвечает текстом, четыре гейта могут продолжить ход: поздние LSP-вердикты по правкам, verify-on-stop, плагинный `pre_verify` и guard для kanban-воркера (`agent/turn_stop_gates.py:1-12`, VERIFIED). Подробнее в разделе J.
- **Охрана от вырождения.** `repetition_guard.py` обрывает ход, если повторяющиеся куски ≥60 символов занимают большинство текста. Был инцидент: ответ на 60k символов ушёл 31 сообщением в Discord (`agent/repetition_guard.py:1-8`, VERIFIED). `empty_response_guard.py` обрабатывает пустой ответ: до 3 повторов, а после двух одинаковых пустых ответов «deterministic-empty» сразу переходит в fallback-цепочку; при дорогом запросе (>$0.25) повтор только один (VERIFIED).

**Применимость.** В Pi своя петля, переписывать её не нужно. Стоит перенять: (1) не показывать модели предупреждения о давлении контекста; (2) steer доставлять только отдельным user-сообщением после tool results; (3) детекторы repetition-loop и deterministic-empty как Pi-extension на событиях стрима — дешёвые модели (GLM/Qwen) регулярно зацикливаются; (4) без жёсткого лимита ходов, вместо него бюджет по деньгам или времени.

---

### B. Context engineering и prompt caching (ключевой раздел)

**B1. Сборка system prompt — три уровня** (`agent/system_prompt.py`, `website/docs/developer-guide/prompt-assembly.md`, VERIFIED):

1. **stable**: identity (`SOUL.md` либо дефолт), guidance по инструментам и модели, coding brief.
2. **context**: `system_message` вызывающего, project context file, git-snapshot воркспейса, operator instructions, platform hint.
3. **volatile**: skills index, снимок `MEMORY.md`, снимок `USER.md`, блок внешнего memory-провайдера, время/сессия/модель, runtime environment (host/home/cwd). Блок cwd всегда последний.

Порядок выбран под longest-prefix кэш. Общие для проекта файлы стоят до всего, что зависит от worktree, поэтому сессии одного проекта в разных worktree делят префикс (VERIFIED, prompt-assembly.md). Размер по зафиксированному рендеру — около 3.2–4.4k токенов промпта плюс ~13.3k токенов схем 33 инструментов (`tests/fixtures/prompt_surface/surfaces.json`, VERIFIED). Документация местами противоречит себе («skills are part of the stable tier»), но рендер показывает skills index в volatile.

**Per-model guidance (VERIFIED, diff fixture-ов):** GPT получает ~1.2k токенов «Tool-use enforcement» и «Execution discipline» (`<tool_persistence>`, `<mandatory_tool_use>`, `<act_dont_ask>`, `<verification>`…). Gemini получает «Google model operational directives» (абсолютные пути, неинтерактивные флаги). Claude получает базовый текст. Отбор идёт по имени модели.

**Project rules.** Загружается только один project-файл, первый найденный: `.hermes.md`/`HERMES.md` (поиск до git root) → `AGENTS.md` → `CLAUDE.md` → `.cursorrules`. Файл сканируется на инъекции и обрезается 70/20 head/tail; лимит масштабируется с окном модели (минимум 20k символов, максимум 500k). `AGENTS.md` из подкаталогов подгружается постепенно: его **дописывают к tool result** при первом обращении к каталогу (`agent/subdirectory_hints.py`, лимит 32k), а не вставляют в system prompt (`agent/AGENTS.md:57-63`, VERIFIED).

**B2. Как память не ломает кэш — механика «frozen snapshot».**
- `MemoryStore.load_from_disk()` один раз рендерит `_system_prompt_snapshot`. `format_for_system_prompt()` возвращает только этот снимок: «Frozen load-time snapshot (NOT live state — mid-session writes don't touch …)» (`tools/memory_tool_store.py:175-253, 618-621`, VERIFIED).
- Запись через `memory` сразу идёт на диск (атомарно, под `fcntl`-lock), а **tool result показывает живое состояние** (VERIFIED, docs memory.md:57). Поэтому модель в текущей сессии видит свою запись через ответ инструмента, а промпт остаётся байт-в-байт прежним.
- Снимок пересобирается в двух случаях: новая сессия или компрессия. `invalidate_system_prompt()` сбрасывает кэшированный промпт и вызывает `_memory_store.load_from_disk()` (`agent/system_prompt.py:814-832`, VERIFIED). Компрессия всё равно ломает кэш, поэтому её используют как «санкционированную точку» обновления памяти, skills index и плагинных секций.
- **Ответ на вопрос «почему frozen»** — да, ради prefix cache. Цитата: «This is intentional — it preserves the LLM's prefix cache for performance» (`website/docs/user-guide/features/memory.md:57`, VERIFIED). Есть и вторая причина, семантическая: «keep memory semantics understandable» (prompt-assembly.md).
- **Цена решения.** Авторы её прямо признают: свежая запись не видна в текущей сессии, а в мессенджерах, где сессия живёт неделями, петля «забыть → вспомнить» почти не срабатывает. Рекомендация — `/new` на естественных границах (memory.md, раздел «Memory Needs Session Boundaries», VERIFIED).
- **Изменения skills посреди сессии.** Индекс `<available_skills>` тоже заморожен. Каждый ход `agent/skills_index_delta.py` сравнивает его с актуальным и доставляет **разницу одноразовой заметкой в user-сообщении** (`[System: The skills available in this conversation changed…]`). Заметка повторяется только при новом изменении. Сам индекс обновится на следующей компрессии (`agent/skills_index_delta.py:1-25`, VERIFIED). Так же в user-канал уходит подсказка о смене поверхности (desktop↔TUI): `agent/surface_switch.py`.
- **Всё эфемерное — в user message.** Recall внешней памяти на последующих ходах, контекст из `pre_llm_call`-плагинов, gateway overlays — всё это уходит в текущий user message, а не в system prompt (prompt-assembly.md, «API-call-time-only layers», VERIFIED).
- **Персистентность промпта.** В БД сессии хранится весь промпт. При resume, после рестарта процесса и даже когда gateway собирает нового агента на каждый ход, используются сохранённые байты; `_stored_prompt_matches_runtime()` проверяет, что они совпадают с runtime (prompt-assembly.md; `agent/system_prompt.py::reconstruct_static_prefix`, VERIFIED). **Для нас это особенно важно: Pi-sidecar может перезапускаться, и кэш не должен от этого холодеть.**
- **Модель — часть ключа кэша.** «Don't add features that silently swap the model or credentials mid-session» (context-compression-and-caching.md, VERIFIED). Отсюда вывод: смену профиля в нашем приложении нужно делать на границе сессии.
- **Anthropic.** Стратегия `system_and_3`: breakpoint на system prompt плюс скользящее окно из 3 последних сообщений; TTL `5m`, `1h` или `auto` (1h для человеческого темпа, 5m для машинного). Заявлено «~75%» экономии input (VERIFIED как утверждение docs, цифра не перепроверена).

**B3. Компрессия.**
- **Два слоя.** Агентский `ContextCompressor` срабатывает на 50% окна. Для окон меньше 512k порог **поднимается до 75%**: «at 50% the incompressible floor eats the reclaimed headroom and compaction re-fires every 1-2 turns» (`agent/context_compressor.py:1150-1153`, VERIFIED). Gateway hygiene — страховочная сетка на 85%.
- **Алгоритм.** (1) Без LLM старые tool results длиннее 200 символов заменяются на `[Old tool output cleared…]`. (2) Границы выравниваются, пары tool_call/result не разрываются. (3) Один вызов aux-модели строит структурированное summary: Goal / Constraints & Preferences / Progress (Done / In Progress / Blocked) / Key Decisions / Relevant Files / Next Steps / Critical Context. При повторной компрессии предыдущее summary **обновляется**, а не пишется заново.
- **Режим `lean` (по умолчанию).** Хвост равен 2.5% окна (от 10k до 25k токенов). Плюс механически извлечённый **anchor index**: SHA, пути, PR, строки ошибок через regex, без пересказа. Плюс все реальные user-сообщения дословно и указатель на `session_search` для восстановления. Загруженные skills при выпадении помечаются `[SKILL_PRUNED … reload with skill_view]`; в system prompt есть правило перезагрузки (VERIFIED, context-compression-and-caching.md; `config_defaults.py:604-618`).
- **In-place по умолчанию.** Старые строки помечаются `active=0, compacted=1` под тем же session id и остаются доступны для поиска. Это убрало «session-rotation bug cluster» (VERIFIED).
- **Предупреждение авторов.** Если окно summary-модели меньше окна основной, summary молча не строится и середина просто теряется: «the most common cause of degraded compaction quality» (VERIFIED).

**Доказательства (компрессия).** `evals/compaction/results/SCORECARD-2026-08-15.md` (VERIFIED, primary): 4 реальных транскрипта по 500k токенов, 15 вопросов на recall к каждому.

| политика | средний recall | сохранено токенов |
|---|---|---|
| без компрессии | 96.7% | 500K |
| старая «current» | 45.8% | ~162K |
| lean, без доступа к истории | 40.0% | ~49K |
| **lean + один `session_search`** | **68.3%** | ~49K |
| Codex CLI (gpt-5.6-sol), после компакции | 36.7% | ~4.5K |

Вывод авторов: «LEAN+RECOVERY BEATS CURRENT BY +22.5pts… AT 3.3x FEWER TOKENS». «THE ANCHOR INDEX FIXED THE NEEDLE-FACT CLASS» (GUI: 23.3 → 60.0).

**B4. Tool output.** Большой вывод не обрезается, а **сохраняется** в `$HERMES_HOME/cache/spillover/{id}.txt`; в контекст попадают preview и путь. Есть ещё бюджет на ход (`enforce_turn_budget`) (`tools/tool_result_storage.py:1-6`, VERIFIED). Терминал: 50k символов; `read_file`: 2000 строк и ~100k символов с `next_offset` (`tools/tool_output_limits.py`, VERIFIED). В описании `terminal` прямо сказано: «never pipe through head/tail to shorten it».

**B5. Progressive disclosure.**
- **Skills.** Индекс (имя и описание, усечённое до ~57–60 символов) → `skill_view(name)` → `skill_view(name, file_path)`.
- **Отложенные инструменты.** `tool_search` / `tool_describe` / `tool_call` — мост к отложенным инструментам; в стоковом CLI их 7: `browser_vault`, `computer_use`, `cronjob_manage`, `image_generate`, `session_search`, `process_manage`, `todo_list` (`tests/fixtures/prompt_surface/tools/tool_search.json`, VERIFIED).

**Применимость к нам.** Frozen snapshot и «всё изменяемое — в user/tool канал» переносятся в Pi напрямую. Отдельный вопрос, требующий эксперимента: держит ли кэш наш relay-маркетплейс (OpenAI-compatible). У DeepSeek, Kimi, GLM и Qwen кэш префикса автоматический на стороне провайдера (UNVERIFIED для нашего relay). Для Claude через OpenAI-совместимый relay `cache_control`, скорее всего, не пробрасывается (UNVERIFIED). Даже без кэша фиксированный промпт полезен, потому что делает поведение воспроизводимым.

---

### C. Инструменты и форматы правок

**Набор.** Стоковый CLI отдаёт 33 инструмента, из них 13 браузерных (`surfaces.json`, VERIFIED). Ядро: `terminal`, `read_file`, `write_file`, `patch`, `search_files`, `execute_code`, `delegate_task`, `memory`, `skill_manage`, `skill_view`, `skills_list`, `clarify`, `web_search`, `web_extract`, `vision_analyze`, `tool_search`/`tool_describe`/`tool_call`. Агентские инструменты (`todo`, `memory`, `session_search`, `delegate_task`) перехватываются до registry через таблицу `INLINE_TOOL_EXECUTORS` (VERIFIED).

**Формат правок** (VERIFIED, fixtures `patch.json`, `patch.cli.gpt.json`, system prompt):
- Основной формат — `patch` в режиме `replace` (`old_string`/`new_string`/`replace_all`). Применяется **fuzzy matching из 9 стратегий** (`tools/fuzzy_match.py`: нормализация unicode-кавычек и тире, пробелы, отступы, escape-drift и т.д.); результат возвращается unified diff-ом.
- **Только GPT-моделям** схема дополнительно раскрывает `mode='patch'` (V4A multi-file `*** Begin Patch`). Остальным показывается одна replace-схема, без лишнего режима.
- В system prompt зашито правило эскалации: «If an edit fails to apply, re-read the file… If the same region fails twice, rewrite the enclosing function or file with `write_file` instead of attempting a third patch.»
- **Lint после каждой правки**: `py_compile`, `node --check`, `tsc --noEmit`, `go vet`, `rustfmt --check`, а также LSP-диагностика, если есть сервер (`tools/file_operations_lint.py`, VERIFIED). Шумные линтеры (одиночный `tsc` без tsconfig) пропускаются, когда файл покрыт LSP.

**Bash-семантика.** Это не постоянный процесс, а **snapshot**: каждая команда запускается в новом bash, который `source`-ит сохранённый `export -p` и маркер cwd. Переменные, специфичные для сессии, из снимка вычищаются, чтобы не протекали между сессиями (`tools/environments/base_session_env.py:1-35`, VERIFIED). Таймаут по умолчанию 180 с, максимум 600 с; всё длиннее автоматически переводится в фон с `notify_on_complete`. Есть `background`, `notify` (по выходу или по regex), `heartbeat`, `pty`. Правило в схеме: «never background a sleep or polling loop» (VERIFIED, `terminal.json`).

**Починка кривых tool calls** (VERIFIED):
- `tools/arg_coercion.py` по схеме чинит `"42"`→int, `"true"`→bool, JSON-строку→массив, скаляр→`[скаляр]`. Если исправление неоднозначно, оригинал не трогается.
- `agent/turn_tool_validation.py`: неизвестное имя инструмента авторемонтируется, после трёх ошибок — частичный выход; битый JSON сначала повторяется, затем подставляются recovery tool results. Чередование ролей сохраняется.
- `chat_completion_helpers_tool_calls.py`: Ollama-совместимые эндпоинты переиспользуют `index 0` для всех параллельных вызовов, поэтому при новом id открывается новый слот.

**Эргономика ошибок — образцовая** (`tools/memory_tool_store.py`, VERIFIED). При неудачном `old_text` модель получает `closest_entries` (top-3 по пересечению слов), подсказку, что `§` разделяет записи, а сравнение толерантно к типографике (кавычки и тире нормализуются). Если `old_text` не передан, возвращаются текущие записи и инструкция для повтора. После трёх неудачных консолидаций за ход приходит **терминальный** ответ «Stop retrying memory calls… continue with your reply», чтобы побочное действие не съело ход (`_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3`, строка 184).

**Доказательства.**
- `evals/core_tool_deferral/results/SUMMARY.md` (2026-08-29, VERIFIED): 288 живых прогонов, перевод 19 инструментов в отложенные (схемы −56%). Точность: gpt-5.6-terra 0.938→0.879, **glm-5.3-flash 0.915→0.963**, **qwen3.8-27b 0.915→0.907**. Токены −7…−23% на всех моделях, ходов на 1–2 больше. Единственная настоящая регрессия — `clarify`: без видимой схемы модели задают вопрос простым текстом (7/18 против 18/18). Поэтому `clarify` в текущем рендере оставлен eager (VERIFIED, `tools/clarify.json` есть в списке прямых инструментов). Цитата: «the focused catalog line beats 27 competing schemas for weaker models».
- `evals/readtool/` (август 2026): A/B по «враждебным» файлам — lockfile на 2.7MB, однострочный min.js на 600KB, FIFO, PNG с расширением .txt. Методика: 3 прогона минимум, ошибки остаются в знаменателе (VERIFIED, README; итоговые цифры я не читал).

**Применимость.** Для Pi стоит перенять как extensions: (1) fuzzy-replace со списком стратегий и правилом «2 неудачи → write_file»; (2) post-edit lint/LSP в tool result; (3) coercion аргументов по схеме — критично для GLM/Qwen/Kimi; (4) spillover в файл вместо обрезки; (5) отложенные инструменты для неосновных возможностей, но `clarify`/`ask_user` держать eager.

---

### D. Модели и провайдеры

**Абстракция.** Провайдер описывается профилем-плагином `plugins/model-providers/<name>/` (`ProviderProfile.build_api_kwargs_extras()`); всего ~45 профилей (VERIFIED). Вспомогательные задачи (compression, curator, background_review, session_search, vision, title, approval) резолвятся через `auxiliary.<task>.{provider,model,base_url,reasoning_effort}` (`agent/AGENTS.md`, VERIFIED). Это готовая модель «ролей моделей», близкая к нашим profiles/model-roles.

**Находки, напрямую касающиеся наших моделей** (VERIFIED, код профилей):
- **DeepSeek V4/Flash**: «V4 defaults to thinking ON when `extra_body.thinking` is unset, and then requires `reasoning_content` to be echoed back on later turns (HTTP 400 after the first tool call otherwise)». Hermes всегда явно ставит `thinking`. `json_schema` не поддерживается, только `json_object` (`plugins/model-providers/deepseek/__init__.py:1-8, 58-60`).
- **GLM-5.3**: thinking нельзя отключить, минимальный режим — `low`. Effort клампится к словарю модели (`plugins/model-providers/zai/__init__.py`).
- **Kimi**: `extra_body.thinking` и `reasoning_effort` взаимоисключающие (400, если переданы оба). K2.x сохраняет reasoning прошлых ходов только с `thinking.keep:"all"`, K3 сохраняет всегда. Brotli отключён из-за бага стрима (`plugins/model-providers/kimi-coding/__init__.py`).
- **Custom (OpenAI-compatible relay)**: «kimi-k3 behind an OpenAI-compatible relay defaults to `max` — 3x the reasoning tokens and ~3x the latency of medium», поэтому при незаданном effort Hermes шлёт `medium` (`plugins/model-providers/custom/__init__.py:45-55`). **Прямое попадание в наш сценарий.**
- **Reasoning passback.** Gemini `thought_signature` и Copilot `reasoning_opaque` хранятся отдельным приватным `reasoning_details` и выдаются на провод только тому маршруту, который их читает (`agent/reasoning_carriers.py:1-15`). Харнесс `evals/reasoning_replay/` проверяет **на проводе по дельте `prompt_tokens`**, читает ли провайдер повторённый reasoning: «a 200 OK only shows a field was accepted… chat template (Qwen3) discard reasoning from earlier turns» (VERIFIED, README; таблицу результатов не нашёл).

**Применимость.** Наш relay — один OpenAI-compatible endpoint, а под ним DeepSeek, GLM, Kimi, Qwen и Claude. Значит, нужен **per-model профиль внутри одного провайдера**: те же квирки (thinking toggle, echo `reasoning_content`, effort-словарь, отказ от `json_schema`), но по имени модели, а не по хосту. Харнесс reasoning_replay стоит перенести как есть и прогнать на нашем relay.

---

### E. Состояние и сессии

- **Хранилище** — SQLite `state.db` в режиме WAL, своё на каждый профиль. Таблицы `sessions`, `messages`, три FTS5-индекса (`unicode61`, trigram, CJK), `session_model_usage`, `compression_locks`, `session_admissions` (устойчивая очередь ввода), `delivery_obligations` (outbox) и другие (`website/docs/developer-guide/session-storage.md`, VERIFIED). Единственный писатель канонических сессий — gateway профиля; CLI, TUI и Desktop его клиенты.
- **`session_search`** не делает вызовов LLM: «No LLM calls — every shape returns actual DB messages» (`tools/session_search_tool.py:1-9`, VERIFIED). Это **опровергает** формулировку из ТЗ и из собственного `README.md` Hermes («FTS5 session search with LLM summarization»): README устарел. Режимы: discovery (FTS5 с дедупом по lineage), scroll (окно ±N вокруг сообщения), read (head/tail, до 2000 символов на сообщение), browse. Cron-сессии в ранжировании понижены: их лексика забивала BM25 («recall blindness»).
- **Rewind/edit/regenerate** делается через `prompt.submit` с `truncate_before_row_id` и обязательным `confirm_truncate`. Отрезанные строки архивируются, а не удаляются; глубокий откат требует `confirm_deep_truncate` (programmatic-integration.md, VERIFIED). Ветвление — `session.branch`.
- **Файловые чекпойнты** (opt-in): общий теневой git-store в `~/.hermes/checkpoints/store/` с ref на проект. Снимок делается перед `write_file`/`patch` и «разрушительными» командами (`rm`, `mv`, `sed -i`, `>`, `git reset`), не чаще одного раза на каталог за ход. `/rollback N` откатывает файлы **и** последний ход чата (`website/docs/user-guide/checkpoints-and-rollback.md`, VERIFIED). Отключены по умолчанию: «most users never use /rollback».

**Применимость.** У Pi своё дерево сессий в JSONL (UNVERIFIED, проверит Pi-исследователь). Из Hermes стоит взять: (1) теневой git-store с ref на проект как бэкенд file rollback, связанный с id сообщения; (2) FTS5-индекс поверх Pi-сессий в Rust-мосте как сервис для `session_search` без LLM; (3) явные `confirm_*` флаги в протоколе для деструктивных операций.

---

### F. Расширяемость: skills, память, плагины, «профили»

**Skills.** Формат совместим с agentskills.io (`SKILL.md` с frontmatter `name`, `description`, `platforms`, `metadata.hermes.{tags, category, requires_toolsets, fallback_for_toolsets, config}`). Поддиректории `references/`, `templates/`, `scripts/`, `assets/` (`website/docs/user-guide/features/skills.md`, VERIFIED). Приоритет источников: project (`.hermes/skills`, `.agents/skills`, только после `hermes skills trust`) → `~/.hermes/skills` → `skills.create_dir` → `external_dirs`. Есть skill bundles, hub из 8 источников с уровнями доверия и `/learn`: превращает директорию, URL, «то, что мы только что сделали» или книгу в skill. Книга становится knowledge-base skill: компактный `SKILL.md` плюс `references/` по главам.

**Ограничения формата** (`agent/learn_prompt.py`, VERIFIED): description ≤60 символов, потому что индекс его усекает: «anything past char 60 is silently cut and never routes». Поле `author: Hermes`, а не имя из окружения — защита приватности. Обязательный порядок секций: When to Use → Prerequisites → How to Run → Quick Reference → Procedure → Pitfalls → Verification.

**Внешняя память.** ABC `MemoryProvider` (`agent/memory_provider.py`): `system_prompt_block` (статический), `prefetch` (перед вызовом, уходит **в user message**), `queue_prefetch`, `sync_turn`, `on_session_end`, `on_pre_compress` (с API v2 и fail-closed чекпойнтом), `on_memory_write` (зеркалирование встроенной памяти) (VERIFIED, memory-provider-plugin.md). Одновременно активен только один провайдер. Recall оборачивается в `<memory-context>` с пометкой «recalled memory context, NOT new user input», а на выходе вычищается из стрима (`agent/memory_context.py`, VERIFIED).

**Политика (VERIFIED, `plugins/AGENTS.md`).** С мая 2026 новых in-tree memory-провайдеров не принимают. Honcho, Mem0, Supermemory, Hindsight, OpenViking и Holographic переехали в `plugin-catalog/` (запись с пином на 40-символьный SHA, мерж человеком). Принцип: «Plugins never touch core… A hook with no concrete consumer is speculative infrastructure and is rejected».

**Хуки.** Около 40 событий трёх классов: Observer, Transform, Directive (`website/docs/user-guide/features/hooks.md`, VERIFIED). Из важных для нас: `pre_llm_call` (контекст в user message), `transform_tool_result`, `transform_terminal_output`, `pre_verify`, `post_compaction`, `on_skill_lifecycle`, `subagent_start/stop`, `pre_api_request`, `pre_auxiliary_call`.

**«Профили» Hermes ≠ наши профили.** Профиль Hermes — **изолированный HERMES_HOME**: свой config, .env, SOUL, memories, skills, sessions, cron и state.db. «Profiles are islands on purpose» (`AGENTS.md`, VERIFIED). Распространяется как git-репозиторий с `distribution.yaml`, `SOUL.md`, `config.yaml`, `mcp.json`, `skills/`, `cron/jobs.json`; при обновлении файлы автора заменяются, а memories, sessions и .env пользователя не трогаются (`website/docs/user-guide/profile-distributions.md`, VERIFIED). Отдельное предупреждение: никогда не направлять два агентских процесса в один home — записи памяти «compound each other's entries into state neither of them authored».

**Применимость.** Наши Code/Daily/Creative — режимы **одного** пользователя, а не изолированные агенты. Рекомендация (мой вывод, UNVERIFIED): `USER.md` общий для всех профилей; `MEMORY.md` и skills — с профильной областью видимости (общая библиотека с тегом `profiles:` во frontmatter и фильтром индекса); smена профиля только на границе сессии. Схема `distribution.yaml` с разделением «author-owned / user-owned» — хороший образец манифеста профиля и его обновления.

---

### G. Протокол UI ↔ core

`tui_gateway` — JSON-RPC с разделением по переводам строк поверх stdio (или WebSocket). Он обслуживает три клиента: Ink TUI, Electron Desktop и дашборд (`tui_gateway/AGENTS.md`, VERIFIED). Ключевые решения:
- **Контракт объявлен в Python (Pydantic, `extra="forbid"`) и генерируется в TypeScript** (`gateway-contract.generated.ts` + OpenRPC). Тест падает, если сгенерированные типы устарели.
- **Server→client requests** (`approval`, `clarify`, `sudo`, `secret`, `vault.*`) — настоящие JSON-RPC-запросы с id `srq-N`, а не события. Клиент один раз сообщает `client.capabilities {server_requests:true}`; если он этого не сделал, запрос сразу проваливается, а не ждёт таймаута. При переподключении `open_requests` и `inflight` (текущий незавершённый ход) воспроизводятся заново.
- **В документации есть прямой маппинг на Pi RPC** (`website/docs/developer-guide/programmatic-integration.md`, VERIFIED): `prompt→prompt.submit`, `steer→session.steer`, `follow_up→prompt.submit` (в очередь), `abort→session.interrupt`, `set_model→command.dispatch /model`, `compact→session.compress`, `get_state→session.status`, `get_messages→session.history`, `switch_session→session.resume`, `fork→session.branch`, `ui_request/ui_response→server→client requests`.

**Применимость.** Подтверждает, что Pi RPC покрывает нужный набор команд. Стоит перенять для Rust-моста: (1) единая схема с генерацией TS-типов; (2) вопросы пользователю как запросы с id, плюс `request.cancel` и replay открытых запросов при переподключении UI; (3) `inflight` в ответе на resume.

---

### H. Безопасность и prompt-injection (включая отравление памяти)

**Слои** (`website/docs/user-guide/security.md`, VERIFIED): авторизация пользователей шлюза → одобрение опасных команд → защита записи файлов → контейнеры → фильтрация env для MCP → скан context-файлов → изоляция сессий → санитизация ввода.

- **Approvals.** Режим `smart` по умолчанию: aux-LLM одобряет низкорисковые команды, явно опасные отклоняет, неясные передаёт человеку. Режимы `manual` и `off`/`--yolo`. Плюс **hardline blocklist** (`rm -rf /`, fork bomb, `mkfs`, `dd` на диск, `curl | sh`), который не отключает даже YOLO, и пользовательский `approvals.deny`. Команда с неразбираемыми кавычками отклоняется (fail-closed). В cron, `-q` и webhook без человека по умолчанию `deny`.
- **Бэкенды терминала.** local, Docker (с hardened-флагами), SSH, Singularity, Modal, Daytona, Vercel Sandbox, а также сторонние через `TerminalEnvironmentProvider` (VERIFIED, `tools/environments/`, terminal-environment-plugin.md).
- **Защита памяти от отравления** (VERIFIED, код):
  - **Запись.** Каждая запись в memory сканируется в «strict»-scope по `tools/threat_patterns.py`: классические инъекции, C2/«Brainworm»-лексика, exfil через `curl $…KEY`, `authorized_keys`, `~/.hermes/.env`, правки `AGENTS.md`/`SOUL.md`, захардкоженные секреты, невидимый unicode. Принцип из шапки модуля: «New patterns must anchor on C2 vocabulary or unambiguous attack behavior, NOT bossy English ("you must" is common in legitimate AGENTS.md)». Filler между словами ограничен ради защиты от катастрофического backtracking.
  - **Загрузка.** Повторный скан при загрузке. Подозрительная запись заменяется на `[BLOCKED: …]` **только в снимке промпта**, а в живом списке остаётся, чтобы пользователь увидел атаку и удалил запись: «dropping them silently would hide the attack» (`tools/memory_tool_store.py:221-253`).
  - **Формулировка записей.** В system prompt велено писать факты, а не инструкции: «'User prefers concise responses' ✓ — 'Always respond concisely' ✗ (imperative phrasing gets re-read as a directive in later sessions and can override the user's current request)» (fixture, VERIFIED). Это эффективная мера и против инъекций, и против самоотравления.
  - **Фоновый review.** Без присмотра review **не может** выполнять `patch`/`remove` памяти даже при выключенном гейте: такие операции ставятся в очередь `/memory pending` с привязкой к точному тексту записи (`tools/memory_tool.py:179-220`, VERIFIED).
- **Skills.** Hub-установки и project skills проходят сканер. Вердикт `dangerous` — карантин, `--force` его не снимает. А вот `skills.guard_agent_created: False` по умолчанию с обоснованием: «the agent can run the same code via terminal() ungated, so it mostly blocks prose with risky keywords» (`hermes_cli/config_defaults.py:~1486`, VERIFIED). То есть авторы считают скан собственных записей агента в skills театром безопасности. Inline shell в `SKILL.md` (`!`cmd``) по умолчанию выключен.
- **Context-файлы.** Совпадение в `AGENTS.md` проекта заменяет его на `[BLOCKED…]`. Собственный `SOUL.md` пользователя только помечается предупреждением, кроме случая, когда он пришёл из дистрибутива (VERIFIED).
- **Telegram** (`website/docs/user-guide/messaging/telegram.md`, `security.md`, VERIFIED). Работает **как бот через Bot API** (python-telegram-bot, токен от @BotFather), а не через пользовательский аккаунт; MTProto используется только для опционального локального Bot API-сервера (файлы >20MB). Авторизация по умолчанию — deny. Есть allowlist (`TELEGRAM_ALLOWED_USERS`) или **DM pairing**: 8-символьный код из алфавита без 0/O/1/I через `secrets.choice`, TTL 1 час, не чаще 1 запроса в 10 минут, не больше 3 ожидающих, блокировка на час после 5 ошибок, файлы с правами 0600. В группах: privacy mode, `mention_patterns`, `guest_mode`, контроль доступа к slash-командам. Вход через QR-код в Desktop создаёт бота и сам заполняет allowlist.
- **Внешний сигнал.** В каталоге есть плагин `memory-shield` (запрет удалять факты, read-only для групповых чатов, снапшоты). Само его существование показывает, что отравление памяти через групповые чаты считается реальной угрозой (`plugin-catalog/memory-shield.yaml`, VERIFIED как факт наличия).

**Применимость.** Для Desktop: approvals превращаются в server→client request и модальное окно; «smart» approval стоит поручить дешёвой модели только при наличии жёсткого blocklist; скан записей памяти и загрузка с `[BLOCKED]` переносятся напрямую; формулировку «факты, не инструкции» стоит вписать в схему нашего memory-инструмента.

---

### I. Субагенты и мульти-агентность

- **`delegate_task`** (VERIFIED, `tests/fixtures/prompt_surface/tools/delegate_task.json`): до 10 параллельных задач (`max_concurrent_children`). У каждой изолированный контекст и свой терминал; родителю возвращается только итоговое summary. Есть `output_schema` с одной попыткой исправления и `action: list/steer/stop` для управления на лету. В интерактивных сессиях результат приходит фоново: «results re-enter as a new message… give a one-line status and END YOUR TURN. Never wait or poll».
- **Правила в схеме.** «Child summaries are SELF-REPORTS, not verified facts… require a verifiable handle». Детям запрещены `delegate_task`, `clarify`, `memory`, `cronjob`. Глубина по умолчанию 1 (плоская); роль `orchestrator` открывается через `max_spawn_depth`. Для one-shot прогонов лимит 2 ребёнка: «in benchmark trajectories most of its spawns were "independently review my own work"… each such child re-pays a cold system prompt» (delegation.md, VERIFIED).
- **Стоимость.** Авторы рекомендуют frontier-модель для планирования и дешёвые модели для воркеров (`delegation.model`): «the children are where the tokens go». Опционально каждый ребёнок получает свой git worktree (`worktree_isolation`).
- **Ревьюер.** `/review` запускает полноправного фонового ревьюера по последним 10 сообщениям; модель задаётся через `auxiliary.review`. Отдельно `/refine` — ручной запуск review памяти и skills. В каталоге есть **плагин `advisor`**: «A persistent second model reviews every agent turn… [NIT]/[CONCERN]/[BLOCKER]… held back until a later review raises the same point again». Он описан как «Port of pi-omplike-advisor (Petr Baudis / pasky), itself rooted in oh-my-pi» (`plugin-catalog/advisor.yaml`, VERIFIED) — **готовый прецедент advisor-паттерна именно из экосистемы Pi.**
- **MoA (mixture of agents)**: виртуальный провайдер, где reference-модели советуют один раз за ход, а aggregator действует и платит за весь цикл. **`/goal`** — Ralph-loop: aux-модель-судья после каждого хода, до 20 продолжений. **Kanban** — доска задач с воркерами в разных профилях.

**Применимость.** Схема «премиум-планировщик плюс дешёвые воркеры» у Hermes поддерживается конфигом, но **без выбора модели на задачу** (`delegate_task` не имеет параметра model; per-task модель есть только в kanban). Нам нужна per-task модель в нашем `delegate`, ровно для escalation. Advisor с правилом hold-and-reconfirm, когда замечание доставляется только при повторе, — дешёвый способ снизить шум ревьюера.

---

### J. Верификация и самоулучшение — петля end-to-end

#### J1. Верификация кода
- Post-edit lint/LSP встроен в `patch`/`write_file` (раздел C).
- **Verify-on-stop** (`agent/verification_stop.py`, VERIFIED): пассивный ledger доказательств (`agent/verification_evidence.py`) фиксирует, какие проверки реально проходили. Если модель пытается закончить ход после правки кода без свежих passing-доказательств, добавляется nudge: «[System: You edited code in this turn, but the workspace does not have fresh passing verification evidence yet… Run the relevant verification command now (…), read any failure, repair the code… If verification is not possible, explain the concrete blocker instead of claiming the work is fully verified.]». Если команды проверки нет, предлагается временный скрипт `hermes-verify-*`. Правки только в .md/.txt не триггерят nudge. **По умолчанию выключено** (`agent.verify_on_stop: False`); режим `auto` включает его только на не-мессенджер поверхностях. Не больше 3 nudge подряд (`agent/verify_hooks.py:DEFAULT_MAX_VERIFY_NUDGES`).
- `pre_verify` — плагинный хук на той же точке, для политик пользователя.

#### J2. Память и skills: кто, когда и что пишет

```
ход пользователя ─► агент (foreground)
    │  может сам вызвать memory / skill_manage (system prompt: «Skills come first…»)
    │  счётчики: _turns_since_memory += 1 на user-ход; _iters_since_skill += 1 на tool-итерацию;
    │  использование memory / skill_manage обнуляет соответствующий счётчик
    ▼
финализация хода (agent/turn_finalizer.py:760-790)
    review_memory = turns_since_memory ≥ memory.nudge_interval (10)
    review_skills = iters_since_skill ≥ skills.creation_nudge_interval (10)
    если final_response есть, ход не прерван и это не cron ─► spawn фонового review (daemon thread)
    ▼
fork AIAgent (agent/background_review.py:965-1048)
    • та же модель → байт-идентичные system prompt, tools[], reasoning config, session_id,
      cache scope → вся история читается из кэша («~26% end-to-end cost reduction», комментарий в коде)
    • другая модель (auxiliary.background_review) → digest: последние 24 сообщения дословно
      + старые ужаты до 300/200 символов
    • персистентность отключена (_persist_disabled, _session_db=None),
      внешние memory-провайдеры отключены
    • whitelist инструментов на стороне ДИСПЕТЧЕРА: схемы tools[] не меняются ради кэша,
      но разрешены только skills_list/skill_view/skill_manage (+memory, если сработал memory-триггер)
      + read_file/search_files
    • max 16 итераций; бюджет input = 75% окна review-модели, ≤600k
    • новый пользовательский ход ОТМЕНЯЕТ review (foreground priority, ожидание 2 с)
    ▼
prompt: _MEMORY_REVIEW_PROMPT | _SKILL_REVIEW_PROMPT | _COMBINED_REVIEW_PROMPT (строки 383-570)
    ▼
записи: memory (unattended: только add; patch/remove → /memory pending)
        skill_manage (read-before-write: перед patch нужен свежий skill_view в этом review)
        гейт write_approval (по умолчанию off) → иначе ~/.hermes/pending/{memory,skills}/<id>.json
        ledger .curator_ledger.jsonl (before/after sha256 + content-addressed blobs)
    ▼
уведомление в чат «💾 Memory updated» / «💾 Skill 'foo' patched» (display.memory_notifications)
    ▼
следующая СЕССИЯ (или компрессия) перечитывает MEMORY.md/USER.md; skills index —
дельта-заметкой в user-канале
    ▼
Curator (agent/curator.py) — раз в 7 дней при простое ≥2 ч:
    детерминированно: не использовался 14 дн → stale, 30 дн → .archive/ (pinned и cron-skills не трогает)
    опционально (curator.consolidate: false по умолчанию): LLM-проход «umbrella-building»
```

Источники: `agent/turn_context.py:758-767`, `agent/turn_iteration_prep.py:165-167`, `agent/tool_executor.py:747-749`, `agent/agent_init.py:1304,1333,1388-1390`, `agent/turn_finalizer.py:760-790`, `agent/background_review.py`, `agent/curator.py:31-35, 209-262, 290+` — все VERIFIED.

**Поправка к ТЗ.** Триггера «5+ tool calls» в текущем коде **нет**: skill-review срабатывает после ≥10 tool-итераций без использования `skill_manage`, memory-review — каждые 10 user-ходов (VERIFIED). Цифра «5+» встречается во вторичных обзорах (UNVERIFIED, вероятно, ранняя версия).

**Точные промпты review** (VERIFIED, `agent/background_review.py:365-570`; ключевые фрагменты дословно):
- *Routing памяти:* «USER.md… who the user is… MEMORY.md… facts about the ENVIRONMENT… One fact goes to ONE store, never both — writing it to both bloats both files until they hit their size limits». Комментарий объясняет мотивацию: без этого review писал профиль в MEMORY.md, а один урок в оба файла (#30220).
- *Skill review:* «Be ACTIVE — most sessions produce at least one skill update… A pass that does nothing is a missed learning opportunity, not a neutral outcome.» Целевая форма — «CLASS-LEVEL skills, each with a SKILL.md of always-on rules and a small `references/` set». Сигналы: стилистические поправки и раздражение пользователя («FIRST-CLASS skill signals»), исправления workflow, нетривиальная техника, ошибочный загруженный skill. Порядок предпочтений: 1) патчить skill, загруженный в этой сессии; 2) существующий umbrella; 3) support-файл; 4) новый umbrella с именем уровня класса задач, но не «fix-X / PR-номер».
- *«Lessons, not logs»* (`_LESSON_LAYER_BLOCK`): «A pitfall is a generalizable rule + one clause of WHY… No PR/issue numbers, dates… Fix the skill in place when it is wrong… do not append 'UPDATE: actually...'».
- *Что НЕ сохранять* (`_DO_NOT_CAPTURE_BLOCK`), один из самых ценных фрагментов: «Environment-dependent failures… Negative claims about tools or features ('browser tools do not work')… These harden into refusals the agent cites against itself for months after the actual problem was fixed… Unresolved failures: if the session ended WITHOUT actually finding a working method… do NOT write those attempts up as a 'reliable workflow'».

**Лимиты памяти** (VERIFIED, `tools/memory_tool.py`, `memory_tool_store.py`): MEMORY.md — 2200 символов (~800 токенов), USER.md — 1375 символов (~500 токенов). Лимит в символах, чтобы не зависеть от модели. Записи разделяются `\n§\n`. Действия `add`, `patch` (замена одного фрагмента внутри записи), `remove` и атомарный батч `operations`; лимит проверяется по **итоговому** результату батча, поэтому за один вызов можно освободить место и добавить запись. `replace` убран, потому что модели использовали его как find-and-swap и стирали соседние факты в составных записях. **Автоконсолидации нет**: при переполнении приходит ошибка с текущими записями и объёмом, который нужно освободить. Заголовок снимка показывает заполненность (`[67% — 1,474/2,200 chars]`), и агенту сказано консолидировать после 80%.

**Curator** (VERIFIED, `website/docs/user-guide/features/curator.md`, `agent/curator.py`):
- Под его управлением только skills с маркером `created_by: agent`, а этот маркер ставит **только фоновый review**. Skills, созданные агентом по просьбе пользователя (`/learn`, foreground create), считаются пользовательскими; curator их не трогает, пока не выполнен `hermes curator adopt`.
- **Никогда не удаляет**: максимум перемещение в `.archive/`. Перед консолидацией делается tar.gz-снапшот, каждая мутация пишется в ledger; можно откатить одну запись (`hermes curator rollback <entry-id>`).
- Промпт консолидации требует искать «PREFIX CLUSTERS», не отказывать с доводом «each skill has a distinct trigger», не судить по `use_count` («absence of evidence either way»), переносить файлы только через ledgered `skill_manage`, а не `mv` («a shell mv/cp writes the same bytes with no ledger entry… rollback restores a hollow skill»). Body больше ~24k символов сам по себе считается целью консолидации.
- Документация противоречива: в одном месте 30/90 дней, в конфиге и коде 14/30. Код главнее.

**Фоновый review может патчить ЛЮБОЙ skill** — ручной, bundled, hub, pinned: «lessons land in the skill that governs the task whoever wrote it». Отредактированный bundled skill перестаёт обновляться при `hermes update` (curator.md, VERIFIED). Удалять может только curator-managed skills.

#### J3. Доказательства, что петля работает
- **Внутренние (VERIFIED как утверждения docs, данных не видел).** Review на более дешёвой модели обходится в «~3–5× in benchmarks» дешевле; «memory capture was identical and skill capture near-identical to the main-model review» (memory.md). Cache-parity fork даёт ~26% экономии (комментарий в коде со ссылкой на PR #17276; дата PR не проверена).
- **Метрик результата нет.** Hermes считает `reused_after_patch` в телеметрии, но прямо пишет: «Task-outcome attribution after a patch remains deferred until its window and multi-skill semantics are defined» (`website/docs/developer-guide/relay-shared-metrics.md:~416`, VERIFIED). **В репозитории нет eval, показывающего, что накопленные skills или память повышают долю успешных задач.** Утверждение «агенты с 20+ skills на 40% быстрее» из обзоров в текущих docs не найдено (grep пуст) — UNVERIFIED, маркетинг.
- **Внешний тест.** CodeCut (2026-07-17, secondary): qwen3-coder:30b через Ollama починил сломанный sklearn-скрипт за 14 tool calls, и Hermes без просьбы создал skill `data-cleaning-for-machine-learning`. Curator в dry-run предложил объединить 3 пересекающихся skills. Ни времени, ни токенов, ни повторного прогона нет; вывод автора — «It does not remove the need for human review».
- **Общий фон.** arXiv 2609.24663 (2026-09-21) про self-evolving агентов в целом (не Hermes): выигрыш на похожих задачах слабеет при сдвиге распределения, а потери удержания сосредоточены в немногих путях эволюции (secondary, только abstract).

#### J4. Режимы отказа (из комментариев в коде и docs, VERIFIED)
1. **Ложное сохранение.** Модель пишет «запомнил», но tool не вызывает; особенно модели <30B: «the fix is a stronger model for setup» (memory.md, troubleshooting).
2. **Самоотравление негативными утверждениями** («инструмент X не работает») — отсюда `_DO_NOT_CAPTURE_BLOCK`.
3. **Хаотичная библиотека.** «hoarding library: one references/ file per session, incident narration» — отсюда линтер skills: `incident-log-shape`, `references-sprawl` (>60), `oversized-body` (>24k).
4. **Утечка служебного промпта в сессию.** Fork с тем же session_id записал свой harness-ход в реальную сессию, и следующий живой ход прочитал его как постоянную инструкцию («curator-takeover root cause»). Отсюда полная изоляция персистентности.
5. **Шторм отказов.** Когда review не давали `read_file`, за 2 дня набралось «~142 denials + ~204 read-before-write refusals… so almost no patch landed».
6. **Неприсмотренное удаление.** Memory-tool подсказывает «consolidate now», review удалял записи без присмотра. Отсюда staging для patch/remove (#105921).
7. **Конкуренция за ресурсы.** На локальном GPU review занимает модель, и новый prompt его отменяет. Отсюда `defer: auto` (ждать простоя).
8. **Невидимость новой памяти в длинных мессенджер-сессиях** — следствие frozen snapshot.
9. **Порча чужих правок.** Review патчит skills, написанные пользователем. Защита — только ledger и `write_approval`.

#### J5. Как сделать эквивалент на Pi (рекомендации, мой дизайн; API Pi — UNVERIFIED, сверить с досье по Pi)
- **Extension `memory`.** Инструмент `memory` с батч-семантикой Hermes (add/patch/remove, лимит в символах, `closest_entries`, терминальный ответ после 3 ошибок, скан угроз). Хранение: `USER.md` глобально, `MEMORY.md` на профиль. На старте сессии снимок кладётся в system prompt через хук сборки промпта, предположительно `before_agent_start` (UNVERIFIED), и больше не меняется. Rust-мост следит за файлом и шлёт событие `memory.changed` в UI-панель; модели изменения видны через tool result.
- **Memory-панель в Desktop.** Список записей с заполненностью, источником (foreground / review / user), pending-очередью с diff и кнопками approve/reject, историей из ledger. Пометка «вступит в силу в новой сессии» и кнопка «начать новую сессию с обновлённой памятью».
- **Extension `skills`.** `skill_manage` (батч, rollback при ошибке, read-before-write), индекс с описаниями ≤60 символов и дельта-заметки в user-канале.
- **Extension `review`.** На событии конца агентского хода, предположительно `agent_end` (UNVERIFIED), с порогами 10/10 запускается второй экземпляр Pi (или in-process session) с **тем же** system prompt, теми же схемами и историей, но с whitelist на диспетчере. Для дешёвых моделей вариант: review на премиум-модели с digest-историей; это стоит дороже, но даёт качество. Экспериментально сравнить с review на той же дешёвой модели с кэшем.
- **Curator.** Детерминированная часть (stale/archive по `.usage.json`) как задача в Rust-мосте; LLM-консолидация вручную по кнопке.
- **Облачная синхронизация.** Записи памяти — упорядоченное множество строк (`§`-разделитель). Мерж по записи с pinned-matching как в Hermes (destructive-операция применяется только к точному тексту, который видел пользователь, иначе конфликт). Skills синхронизируются как content-addressed blobs и ledger. Hermes явно запрещает двух писателей в один home; облачная синхронизация как раз создаёт двух писателей, поэтому нужен merge-слой, а не last-writer-wins (вывод, UNVERIFIED).

---

### K. Evals и наблюдаемость

- В каталоге `evals/` ~70 харнессов: compaction, core_tool_deferral, readtool, reasoning_replay, session_search_schema, tool_search, prefix_rediet, browser_use, provider_fallback и др. (VERIFIED). Общая дисциплина («hermesbench discipline»): не меньше 3 прогонов; разница в ±3% на одном прогоне — шум; упавший прогон считается нулём **и остаётся в знаменателе**; спорные ячейки расширяют до n=6; транскрипты аномалий проверяют до публикации; в интерактивных задачах harness выдаёт заскриптованный ответ пользователя (иначе clarify-задачи несправедливо получают 0).
- Модели в A/B намеренно разного уровня: «a frontier model… and a strong open model where harness quality shows. A feature that only helps qwen still counts» (`evals/readtool/README.md`, VERIFIED).
- **Наблюдаемость.** Usage review/curator атрибутируется родительской сессии (`session_model_usage.task='background_review'`). Отчёты curator — в `logs/curator/<ts>/REPORT.md`. Хуки `pre/post_api_request` и `pre/post_auxiliary_call` разведены, чтобы aux-вызовы не путались с основными.

**Применимость.** Методику (n≥3, ошибки в знаменателе, заскриптованные ответы, A/B двух коммитов в изолированном home) стоит взять целиком. Харнессы compaction, core_tool_deferral и reasoning_replay можно адаптировать почти напрямую.

---

### L. Мета-оптимизация harness-а

- **Prompt surface как код.** `scripts/ci/prompt_surface.py render` рендерит system prompt и `tools[]` для 9 поверхностей и семейств моделей с зафиксированными часами, ОС и путями. Результат коммитится в `tests/fixtures/prompt_surface/`; CI падает на устаревшем снимке и постит в PR дельту токенов и диф промпта; изменения требуют approval core-команды (prompt-assembly.md, VERIFIED). «A one-line code change can rewrite either without the diff showing it.»
- **Диеты схем с проверкой.** `prefix_rediet`, `session_search_schema` (695 против 1570 токенов на вызов) и `core_tool_deferral` — каждое сокращение промпта подтверждается живым A/B на дешёвых моделях.
- **Ratchet-лимиты кода** (CC ≤20, функции ≤300 строк, файлы ≤2000 строк) и `AGENTS.md` ≤12k символов, чтобы весь файл помещался в контекст 128k-моделей.

**Применимость.** Снимок prompt surface в CI — дешёвая и очень полезная практика для нас: профили Code/Daily/Creative будут менять промпт и инструменты, и регрессии должны быть видны в PR.

---

## 3. Топ-10 приёмов, которые стоит взять

| # | Приём | Приоритет | Источник |
|---|---|---|---|
| 1 | **Frozen snapshot памяти + live-состояние в tool result.** System prompt байт-стабилен на всю сессию; память, skills index и смена поверхности доходят до модели через user/tool-канал. Пересборка только на новой сессии или компрессии. Промпт хранится вместе с сессией, чтобы рестарт sidecar не холодил кэш | **P0** | `tools/memory_tool_store.py`, `agent/system_prompt.py:814-832`, `agent/skills_index_delta.py` |
| 2 | **Ограниченная память в символах с батчем и итоговым лимитом** (2200/1375), `patch` вместо `replace`, `closest_entries`, терминальный стоп после 3 ошибок, факты вместо инструкций | **P0** | `tools/memory_tool.py`, `memory_tool_store.py` |
| 3 | **Per-model профили внутри одного OpenAI-compatible relay:** thinking toggle, echo `reasoning_content` для DeepSeek V4, клампинг effort GLM/Kimi, дефолт `medium` против `max` у Kimi через relay, отказ от `json_schema` | **P0** | `plugins/model-providers/{deepseek,zai,kimi-coding,custom}` |
| 4 | **Устойчивые edit-инструменты:** fuzzy replace (9 стратегий) + lint/LSP в результате + правило «2 провала → write_file» + coercion аргументов по схеме | **P0** | `tools/fuzzy_match.py`, `file_operations_lint.py`, `arg_coercion.py`, system prompt |
| 5 | **Фоновый review после хода:** cache-parity fork, whitelist на диспетчере, отмена при новом ходе, бюджет input, промпты «lessons not logs» и «что НЕ сохранять» | **P1** | `agent/background_review.py` |
| 6 | **Staging и ledger:** unattended-удаления памяти всегда в pending; `write_approval`; ledger со sha256 и content-addressed blobs; откат одной мутации. Для Desktop это естественная панель «Pending learning» | **P1** | `tools/write_approval.py`, curator.md |
| 7 | **Lean-компрессия:** хвост 2.5% окна + anchor index (regex по SHA/путям/ошибкам) + дословные user-сообщения + указатель на `session_search`; порог 75% для окон <512k | **P1** | `evals/compaction/results/SCORECARD-2026-08-15.md`, `context_compressor.py` |
| 8 | **Отложенные инструменты через tool_search** для второстепенных возможностей, `clarify` держать eager | **P1** | `evals/core_tool_deferral/results/SUMMARY.md` |
| 9 | **Verify-on-stop по ledger доказательств** (nudge до 3 раз, только при правках кода, «объясни блокер, а не заявляй готовность») + advisor с hold-and-reconfirm на премиум-модели | **P1** | `agent/verification_stop.py`, `plugin-catalog/advisor.yaml` |
| 10 | **Prompt-surface snapshot в CI** + A/B-дисциплина (n≥3, ошибки в знаменателе, дешёвые и frontier модели) | **P2** | prompt-assembly.md, `evals/*/README.md` |

Дополнительно (P2): curator с детерминированным stale/archive по usage, без автоудаления; spillover tool output в файл; DM pairing как образец авторизации мессенджер-канала; `distribution.yaml` как манифест профиля.

---

## 4. Антипаттерны и ограничения

1. **Петля обучения без измерения результата.** Hermes не связывает правки skills с успехом задач («Task-outcome attribution… remains deferred»). Активный промпт («most sessions produce at least one skill update») при этом подталкивает к частым записям. Риск — дрейф и разбухание библиотеки; лечится curator-ом и линтером, а не данными (VERIFIED).
2. **Review молча правит чужие skills**, включая pinned и hub. По умолчанию без approval. Защита — только ledger (VERIFIED). Для нашего Desktop лучше показывать diff в UI до применения, хотя бы для неагентских skills.
3. **Frozen snapshot плюс вечные сессии** означают, что память не работает. Авторы перекладывают решение на пользователя (`/new`). Нам нужна явная UX-граница сессий (VERIFIED).
4. **Нельзя делить home между процессами.** Иначе это «compound state neither of them authored». Облачная синхронизация без merge-слоя воспроизведёт ту же проблему (VERIFIED + вывод).
5. **Regex-сканеры инъекций — эвристика.** Авторы сами: «heuristics, not semantic intent detection». Скан записей агента в skills отключён как бесполезный. Вторичные источники упоминают CVE-2026-9353 в `skills_guard.py` (обработка THREAT_PATTERNS), затрагивающий версии до апреля 2026 (UNVERIFIED, весна 2026; текущий код ограничивает filler именно против backtracking) — сканер сам становится поверхностью атаки.
6. **Документация отстаёт от кода:** README говорит о «LLM summarization» в session_search; agent-loop.md — о `max_turns 500` и субагентах на 50 итераций; curator.md даёт 30/90 против 14/30. При заимствовании ориентироваться на код (VERIFIED).
7. **Сложность.** ~20k файлов и десятки «сиблингов» на каждую фазу; масса защитного кода под мульти-профильный gateway. Нам не нужен один процесс на много профилей с fail-closed секретами, если Desktop однопользовательский. Брать идеи, а не структуру (вывод).
8. **Свой Python-цикл** — для нас неприменим (ядро у нас Pi). Переносить только политики и промпты.
9. **`delegate_task` без модели на задачу.** Escalation к премиум-модели по ситуации там не выразить (VERIFIED).
10. **Компрессия «тихо теряет середину»**, если окно summary-модели меньше окна основной. Нам нужно проверять это при выборе aux-модели (VERIFIED).

---

## 5. Открытые вопросы и что проверить экспериментом

1. **Кэш через наш relay.** Даёт ли маркетплейс скидку на cached input для DeepSeek, GLM, Kimi, Qwen и Claude через chat-completions? Как это видно в `usage` (`prompt_tokens_details.cached_tokens`)? Без этого frozen snapshot и cache-parity fork экономят меньше.
2. **Reasoning passback через relay.** Прогнать `evals/reasoning_replay/harness.py --route custom` против нашего эндпоинта для DeepSeek V4.1 Flash, GLM 5.3, Kimi K3 и Qwen 3.8. Проверить, требует ли relay echo `reasoning_content` (HTTP 400) и потребляет ли его.
3. **Review: дешёвая модель с кэшем против премиум-модели с digest.** A/B на 20–30 реальных сессиях по метрикам: доля «полезных» записей (оценка человеком), повторное использование skill, успех повторной задачи. Hermes этого не публикует.
4. **Портят ли skills задачи дешёвых моделей?** Задача-близнец до и после накопления skills, с ошибками в знаменателе и n≥3.
5. **Пороги nudge (10/10) для наших моделей.** Дешёвые модели делают больше tool-итераций, и 10 итераций у них могут наступать почти каждый ход. Нужна калибровка, возможно порог по «сложности» хода.
6. **Lean-компрессия на окнах 128–256k** (DeepSeek, GLM) против дефолтной компрессии Pi. Перенести 15-вопросный recall-харнесс.
7. **Отложенные инструменты в Pi** при ~20+ инструментах в профиле Code: повторить дизайн core_tool_deferral на наших 4 дешёвых моделях.
8. **Нужен ли verify-on-stop по умолчанию для дешёвых моделей?** У Hermes он opt-in. Для нашего профиля Code, вероятно, должен быть включён — проверить влияние на успех и стоимость.
9. **Pi-API.** Существуют ли в Pi хуки для «один раз на сессию» в system prompt, конца хода, перехвата диспетчера tools (для whitelist без изменения схем) и программного создания второй сессии с тем же префиксом? (сверить с досье по Pi)
10. **Мерж памяти между устройствами**: CRDT по записям или ledger с ручным разрешением конфликтов — прототип и проверка на одновременных правках.

---

## 6. Источники

**Primary (репозиторий `NousResearch/hermes-agent`, main `944c3a43`, дата коммита 2026-10-22; все пути проверены локально):**
- `AGENTS.md`, `agent/AGENTS.md`, `plugins/AGENTS.md`, `tui_gateway/AGENTS.md` — 2026-10-22
- `tools/memory_tool.py`, `tools/memory_tool_store.py`, `tools/threat_patterns.py`, `tools/write_approval.py` — 2026-10-22
- `agent/background_review.py`, `agent/curator.py`, `agent/turn_finalizer.py`, `agent/turn_context.py`, `agent/turn_iteration_prep.py`, `agent/agent_init.py`, `agent/system_prompt.py`, `agent/skills_index_delta.py`, `agent/memory_context.py`, `agent/context_compressor.py`, `agent/verification_stop.py`, `agent/verify_hooks.py`, `agent/turn_stop_gates.py`, `agent/repetition_guard.py`, `agent/empty_response_guard.py`, `agent/reasoning_carriers.py`, `agent/learn_prompt.py` — 2026-10-22
- `tools/session_search_tool.py`, `tools/fuzzy_match.py`, `tools/file_operations_lint.py`, `tools/arg_coercion.py`, `tools/tool_result_storage.py`, `tools/tool_output_limits.py`, `tools/environments/base_session_env.py`, `tools/skill_manager_guards.py` — 2026-10-22
- `plugins/model-providers/{deepseek,zai,kimi-coding,custom}/__init__.py` — 2026-10-22
- `hermes_cli/config_defaults.py` — 2026-10-22
- `tests/fixtures/prompt_surface/{surfaces.json,prompts/*,tools/*}` — отрендеренный промпт и схемы на 2026-10-22
- `website/docs/developer-guide/{prompt-assembly,agent-loop,context-compression-and-caching,session-storage,memory-provider-plugin,programmatic-integration,relay-shared-metrics,terminal-environment-plugin}.md` — на 2026-10-22
- `website/docs/user-guide/features/{memory,skills,curator,delegation,hooks,cron,goals,mixture-of-agents}.md`, `user-guide/{security,profiles,profile-distributions,checkpoints-and-rollback}.md`, `user-guide/messaging/telegram.md` — на 2026-10-22
- `evals/compaction/results/SCORECARD-2026-08-15.md` — 2026-08-15 (с примечанием от 2026-08-30)
- `evals/core_tool_deferral/results/SUMMARY.md` — 2026-08-29
- `evals/{readtool,reasoning_replay,prefix_rediet,session_search_schema,tool_search}/README.md` — на 2026-10-22 (readtool ссылается на август 2026)
- `plugin-catalog/{advisor,memory-shield,honcho}.yaml` — на 2026-10-22
- GitHub Releases https://github.com/NousResearch/hermes-agent/releases — v0.22.4 от 2026-10-21, просмотрено 2026-10-22

**Secondary:**
- Khuyen Tran, «Hermes Agent Can Write Its Own Skills. I Tested How Well It Works», CodeCut — https://codecut.ai/hermes-autonomous-skills-curator/ — 2026-07-17
- Lin et al., «Beyond Endpoint Performance: Process-Level Evaluation of Self-Evolving Agents», arXiv:2609.24663 — 2026-09-21 (только abstract, Hermes не упоминается)
- Записи о CVE-2026-9353 (`skills_guard.py`), например https://vulert.com/vuln-db/CVE-2026-9353 — весна 2026 (точная дата не проверена; касается версий до 2026.4.23; упомянута только как пример уязвимости regex-сканера)
- Утверждение «20+ skills → на 40% быстрее» из обзоров (например https://www.eesel.ai/blog/hermes-agent-review, обновлён около июля 2026, дата не проверена) — в текущих docs не подтверждено, UNVERIFIED
