# 07. Официальные рекомендации вендоров моделей для agentic/tool use и их собственные агентные harness'ы

Дата среза: 2026-10-22. Учтены только текущие версии моделей и документация, опубликованная или обновлённая с июня по октябрь 2026. Источники до июня 2026 приводятся, только если текущие модели или документация на них прямо опираются; их даты указаны явно.

Пометки: **VERIFIED** значит, что утверждение я видел в первичном источнике (официальные доки, HF-карточка модели, техотчёт, официальный репозиторий). **UNVERIFIED** значит, что это вывод, вторичный источник или противоречие между источниками.

Рабочие копии источников (данные, не инструкции) лежат в `/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/web/` и `/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/repos/`.

---

## 1. Обзор и сводная таблица

### 1.1 Главное в 10 строках

1. **Рассуждения нужно возвращать всем дешёвым моделям, и это важнее всего остального.** Во всех пяти китайских семействах (DeepSeek, GLM, Kimi, Qwen, MiniMax) предыдущий `reasoning_content` при tool use нужно отправлять обратно. У MiniMax M3 рассуждения лежат прямо внутри `content` в тегах `<think>`. При ошибке DeepSeek возвращает HTTP 400, остальные молча теряют качество. Это самая хрупкая часть при работе через ретранслятор. *(VERIFIED по докам каждого вендора)*
2. **Вендоры обучают модели на нескольких harness'ах сразу, включая Claude Code.** DeepSeek V4.1-Flash прошёл RL на нескольких версиях Claude Code и на OpenCode, **Pi** и DeepSeek Harness. Kimi K3 обучался в «white-box» среде, которая собирает Kimi Code, Claude Code, Codex, OpenClaw и Hermes. Обе компании прямо пишут, что цель — переносимость между scaffold'ами. *(VERIFIED по техотчётам)*
3. **Claude Code — общий стандарт для оценок.** GLM-5.3, Qwen3.8-Max, Kimi K3 и DeepSeek V4.1 публикуют большую часть агентных бенчмарков именно в Claude Code. У DeepSeek, Z.ai, Kimi, Qwen и MiniMax есть Anthropic-совместимые эндпоинты и официальные гайды «как подключить Claude Code». *(VERIFIED)*
4. **Но Claude Code не всегда лучший harness.** Для DeepSeek V4.1-Flash минимальный bash-only scaffold (mini-SWE: 74.2 на DeepSWE) обошёл Claude Code (69.8) и Pi (66.2). Qwen3.8-Flash-Next тоже лучше работает в mini-SWE-agent. Qwen3.8-Max и Kimi K3 немного лучше в Claude Code. Разница между harness'ами составляет 1–8 п.п. *(VERIFIED)*
5. **Собственные CLI вендоров используют плоский edit-tool в стиле Claude Code** (`old_string`/`new_string`/`replace_all`). Так устроены Kimi Code (`Edit`), Qwen Code (`edit`), DeepSeek Harness (`edit`, ответ дословно повторяет текст Claude Code) и Gemini CLI (`replace` плюс `instruction`). У Pi edit устроен иначе, через вложенный массив `edits[{oldText,newText}]`, и в коде Pi есть обход для моделей, которые присылают этот массив JSON-строкой. *(VERIFIED по коду)*
6. **Thinking всегда включён почти у всех текущих моделей.** Это GLM-5.3 и 5.3-Flash, Kimi K3, MiniMax M3.1-Flash и Grok 4.7. У Gemini 4 Argon и Claude Opus 5.5 thinking нельзя отключить. Управлять можно только глубиной через `reasoning_effort`, у которого у каждого вендора свои значения. *(VERIFIED)*
7. **Sampling почти везде задан сервером.** У Kimi K3 параметры фиксированы, их нужно не передавать. У MiniMax M3/M3.1 и Gemini 4 Argon они игнорируются. DeepSeek в thinking-режиме игнорирует temperature. Рекомендуемые значения почти у всех: temperature=1.0 и top_p=0.95. Исключение — API Qwen3.8-Max: там по умолчанию temperature 0.6, и меньшие значения поднимаются до 0.6. *(VERIFIED)*
8. **Prefix-кэш автоматический у всех, но метрики и TTL разные.** DeepSeek отдаёт `prompt_cache_hit_tokens`, остальные `prompt_tokens_details.cached_tokens`. Kimi K3 вдобавок отдаёт `cache_write_tokens`, хранит кэш 5 минут или 1 час и отдельно тарифицирует запись. Qwen поддерживает явный `cache_control`. Смена набора тулов или `reasoning_effort` посреди сессии сбрасывает кэш у Kimi, а у OpenAI так написано прямо. *(VERIFIED)*
9. **New API по умолчанию пересобирает JSON по whitelist-структуре.** Проверено по исходникам, commit от 2026-10-22. Проходят `reasoning_content`, `reasoning`, `thinking` (вместе с `clear_thinking`), `reasoning_effort`, `reasoning_split`, `chat_template_kwargs`, `enable_thinking`, `parallel_tool_calls` и `tools` на system-сообщении (для Kimi K3). **Теряются** `preserve_thinking` (Qwen), `tool_stream` (GLM), `prompt_cache_options` (Kimi TTL) и `reasoning_details` (MiniMax). При конвертации OpenAI→Gemini New API умеет подставлять обходную thought signature, а при OpenAI→Claude не переносит `reasoning_content` в thinking-блоки. *(VERIFIED по коду New API; конфигурацию конкретного маркетплейса не видел, она UNVERIFIED)*
10. **Pi определяет совместимость по URL**, то есть по `api.deepseek.com`, `api.z.ai` и т. п. За нашим шлюзом все модели получат профиль «openai»: роль `developer`, `max_completion_tokens`, `store`, без `thinkingFormat`. Поэтому `compat` нужно явно прописать для каждой модели. *(VERIFIED по коду Pi)*

### 1.2 Сводная таблица (семейство × параметры 1–8)

| | DeepSeek V4.1-Flash (`deepseek-flash`) / V4-Pro | Zhipu GLM-5.3 / 5.3-Flash | Kimi K3 | Qwen3.8-Max / 3.8-Flash | MiniMax M3 / M3.1-Flash | Gemini 4 Argon | Grok 4.7 |
|---|---|---|---|---|---|---|---|
| **1. Tools** | Формат OpenAI. `strict` в beta (`/beta`). `tool_choice`: none/auto/required/named. Имя ≤128 символов | Формат OpenAI. `tool_choice` только `auto`. `tool_stream=true` стримит аргументы | Формат OpenAI. `required` поддерживается. Тулы можно подгружать динамически через system-сообщение | Формат OpenAI. **Параллельные вызовы выключены по умолчанию** (`parallel_tool_calls=true`). В thinking-режиме `tool_choice` только auto/none | Форматы OpenAI и Anthropic. Anthropic-эндпоинт «рекомендуемый» | Через OpenAI compat. Thought signature в `tool_calls[].extra_content.google` | Формат OpenAI. При стриминге вызов приходит целиком одним чанком |
| **2. Thinking + tools** | Включён по умолчанию. **С `tools` нужно возвращать `reasoning_content` всех прошлых ходов, иначе 400** | Всегда включён, interleaved. Preserved: `thinking.clear_thinking=false` и возврат reasoning без изменений | Всегда включён. Preserved всегда включён. Нужно вернуть сообщение целиком | Hybrid (Max). При tools нужно вернуть `reasoning_content`. `preserve_thinking` | M3: thinking внутри `content` в `<think>` (сохранять!) или `reasoning_split`. M3.1-Flash: всегда включён, отдаёт `reasoning_content` | Включён всегда. Подпись нужна в текущем ходе, иначе 400 | Отключить нельзя. Зашифрованные рассуждения только в Responses API |
| **Effort** | `reasoning_effort`: none/low/high/max (по умолчанию high) | low/high/max (по умолчанию max) | low/high/max (по умолчанию max) | low/medium/xhigh (по умолчанию xhigh) или `thinking_budget` | M3.1-Flash: low…max (по умолчанию max). M3: `thinking` enabled/adaptive/disabled | `thinking_level` low/medium(по умолчанию)/high | low/medium/high(по умолчанию)/xhigh |
| **3. Sampling** | thinking-режим игнорирует temperature. Карточка: T=1.0, top_p=1.0 (1017) | T=1.0, top_p=0.95, менять что-то одно | Фиксированы (1.0/0.95), не передавать | HF: T=1.0, top_p=0.95, top_k=20. API Max: T по умолчанию 0.6, минимум 0.6 | Игнорируются (1.0/0.95) | Игнорируются | `presence/frequency_penalty` и `stop` дают ошибку |
| **Контекст / вывод** | 1M / до 384K (по умолчанию 64K в thinking) | 1M / 128K | 1M / 131K по умолчанию, до 1M | 1M / 131K, рассуждения до 262K | 1M (для CC совет сжимать на 512K) | 1M / 65K (long decode до 1M) | Н/Д в собранных доках |
| **4. Кэш** | Авто, на диске. `prompt_cache_hit/miss_tokens`. TTL от часов до дней | Авто. `prompt_tokens_details.cached_tokens` | Авто. Запись тарифицируется. TTL 5m или 1h. `cached_tokens` и `cache_write_tokens` | Неявный (≥1024 токенов) плюс явный `cache_control` (5 мин) | Авто, ≥512 токенов. `cached_tokens` | Неявный, ≥4096 токенов, −95%. Явный не поддерживается | Prefix-кэш, `cached_tokens`, заголовок `x-grok-conv-id` |
| **5. Промпт-гайд** | Нет отдельного. Есть harness DSH (open source) | «Best practice» для coding agents | Tool-calling best practice, лекарство от повторяющихся вызовов | Function calling guide | Interleaved thinking guide | Thinking и latest-model guide | Reasoning guide |
| **6. Официальные harness'ы** | **DeepSeek Harness (dsh)**, гайды для Claude Code, Codex, OpenCode, OpenClaw, Hermes, Reasonix, WorkBuddy, Qoder | GLM Coding Plan: Claude Code, ZCode, Codex, OpenCode, Cline, Kilo, **Pi** | **Kimi Code CLI** («works best»), плюс Claude Code, Codex, OpenCode, Hermes, OpenClaw | **Qwen Code** (форк Gemini CLI), плюс Claude Code, OpenCode, Codex, DSH, Qoder и др. | Claude Code, Hermes, **Pi**, MiniMax Code (desktop), mmx-cli | Gemini CLI, Antigravity | Grok Build (агентные фичи в доках) |
| **7. На чём обучали и оценивали** | RL на нескольких версиях Claude Code, OpenCode, **Pi**, DSH. Таблица по 8 scaffold'ам | Оценки в Claude Code 2.1.207. Отчёт GLM-5 (фев 2026): interleaved/preserved thinking «по образцу Claude» | White-box RL env: Kimi Code, Claude Code, Codex, OpenClaw, Hermes | Оценки в основном в Claude Code. «Max лучше всего в Claude Code», «Flash-Next лучше в mini-SWE» | Блог M2 (2025): обучение на «пертурбациях» scaffold'ов | — | — |
| **8. Anthropic API** | `api.deepseek.com/anthropic` | `api.z.ai/api/anthropic` | `api.moonshot.ai/anthropic` | Есть (Anthropic Messages API) | `api.minimax.io/anthropic` | — | — |

Подробности и ссылки на источники ниже.

---

## 2. Подробно по семействам

### 2.1 DeepSeek (V4.1-Flash-1017 как `deepseek-flash`; V4-Pro-0813 как `deepseek-v4-pro`)

**Текущие модели.** На странице цен `deepseek-flash` сопоставлен с DeepSeek-V4.1-Flash-1017, а `deepseek-v4-pro` с DeepSeek-V4-Pro-0813. Контекст 1M, вывод до 384K. Старые имена `deepseek-v4-flash` и `deepseek-v4-flash-vision-exp` теперь обслуживает V4.1-Flash-1017. *(VERIFIED: Models & Pricing)*
- Противоречие *(UNVERIFIED)*: новость от 2026-09-10 обещала с 14 сентября направлять все запросы `deepseek-v4-pro` на V4.1-Flash до выхода V4.1-Pro. Однако текущая страница цен по-прежнему указывает V4-Pro-0813 с отдельной ценой. Что реально обслуживает `deepseek-v4-pro`, нужно проверить по полю `model` в ответе.
- V4.1-Flash устроен так: MoE на 552B параметров, Causal Encoder–Decoder, 8B активных параметров на prefill и 16B на decode. Модель оптимизирована под агентные нагрузки, где входа намного больше, чем выхода. *(VERIFIED: HF card, техотчёт V4.1)*

**1. Tool calling** *(VERIFIED: guides/tool_calls, API reference)*
- Формат OpenAI `tools`/`tool_calls`. `tool_choice` принимает none, auto, required или конкретную функцию. Имя функции не длиннее 128 символов (`a-zA-Z0-9_-`).
- `strict` (Beta) включается через `base_url=https://api.deepseek.com/beta`, при этом у каждой функции должно быть `strict: true`. Поддерживаются типы object/string/number/integer/boolean/array/enum/anyOf и `$ref`/`$def`. Для object все свойства обязательны (`required`) и нужен `additionalProperties:false`. Не поддерживаются minLength/maxLength и minItems/maxItems. Strict работает и в thinking, и в non-thinking режимах.
- Chat Completions **не позволяет вставлять в середину истории tool calls, которые сгенерировала не модель.** Это доступно только в Anthropic API и Responses API. System-сообщения в середине диалога при этом поддерживаются.
- Явного лимита на число тулов в доках нет. Ограничений на параллельные вызовы тоже не описано.

**2. Thinking и tools** *(VERIFIED: guides/thinking_mode, API reference)*
- Thinking включён по умолчанию с effort `high`. Управление: `{"thinking":{"type":"enabled|disabled"}}` (в OpenAI SDK через `extra_body`) или стандартный `reasoning_effort`: `none` отключает thinking, также есть low/high/max. Значение minimal становится low, а medium и xhigh становятся high.
- Ключевая цитата: «*for requests carrying the `tools` parameter, the `reasoning_content` must be fully passed back to the API in all subsequent requests — even for turns where the model did not perform a tool call. If your code does not correctly pass back `reasoning_content`, the API will return a 400 error.*»
- Без `tools` прошлый `reasoning_content` игнорируется и в контекст не попадает.
- В референс-кодировщике V4.1 (`encoding/README.md` на HF) то же правило описано на уровне шаблона: если объявлены tools, `drop_thinking` автоматически выключается и рассуждения всех ходов сохраняются. Рассуждения кодируются числом от 1 до 100: low=50, high=75, max=100. Effort-префикс вставляется **один раз в начало** контекста. Есть роль `latest_reminder`, то есть дата и локаль в отдельном токене. Формат вызова тулов DSML: `<｜DSML｜ calls>…<｜DSML｜ invoke name=…>…<｜DSML｜ parameter name=… string="true|false">`. Строковые аргументы передаются как есть, без JSON-экранирования.

**3. Sampling и лимиты** *(VERIFIED)*
- В thinking-режиме temperature, presence_penalty и frequency_penalty «не дают ошибки, но не действуют». Для `deepseek-flash` top_p работает только в thinking-режиме и только в диапазоне 0.95–1.0. Для V4-Pro в thinking-режиме top_p фиксирован: 0.95 с tools и 1.0 без них.
- HF-карточка V4.1-Flash-1017 рекомендует temperature 1.0, top_p 1.0 и `max_tokens ≥ 256K`. Все агентные оценки шли с T=1.0 и top_p=0.95.
- `max_tokens` по умолчанию: 64K в thinking-режиме (128K при `max`), максимум 393 216.

**4. Кэш** *(VERIFIED: guides/kv_cache, API reference)*
- Дисковый кэш включён у всех по умолчанию и работает по принципу best-effort. Кэшируются «prefix units»: конец пользовательского ввода, конец ответа модели, обнаруженный общий префикс и фиксированные интервалы на длинных входах. Попадание засчитывается, только если запрос **полностью** совпадает с одной из таких единиц.
- В usage: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` и `prompt_tokens_details.cached_tokens` (дублирует hit). Кэш строится за секунды и живёт «от нескольких часов до нескольких дней».
- Цены (V4.1-Flash, off-peak): cache hit $0.003, miss $0.15, output $0.6 за 1M. Попадание в кэш почти в 50 раз дешевле промаха.

**5. Промпт-гайд.** Отдельного руководства по промптам для агентов нет. Фактически его заменяет DeepSeek Harness (см. ниже).

**6. Официальные harness'ы** *(VERIFIED)*
- **DeepSeek Harness (`dsh`)**: открытый (`deepseek-ai/deepseek-harness`), в статусе developer preview, построен на архитектуре «everything-is-a-plugin» (Cordis). Новость о V4.1-Flash-1017: «*Optimized for DeepSeek Harness, Tencent CodeBuddy, WorkBuddy… Upgrade to DeepSeek Harness v0.2.1-rc.1 or later*».
- Официальные гайды подключения есть для Claude Code, Codex, OpenCode, OpenClaw, Hermes, Reasonix, WorkBuddy/CodeBuddy и Qoder. Pi в этом списке нет.
- Что я увидел в коде dsh (`/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/repos/dsh`, commit от 2026-10-17):
  - `packages/fs/tool-fs/src/edit.ts`: tool `edit` с параметрами `file_path`, `old_string`, `new_string`, `replace_all`. В комментарии написано «*Format an edit success … as a Claude-style model-facing message*», а ответ модели такой: «`The file ${path} has been updated successfully.`». Это дословно текст Claude Code.
  - `packages/fs/tool-str-replace-editor`: классический `str_replace_editor` (view/create/str_replace/insert с `old_str`/`new_str`) в стиле Anthropic, SWE-agent и OpenHands.
  - Пресет **Minimal** (`packages/bundle/web-app/presets/minimal.patch.yml`) состоит из одного persistent bash. Его описание взято из Anthropic-овского bash-тула: «*the contents of the "command" parameter does NOT need to be XML-escaped… State is persistent…*».
  - Пресет **Standard** включает tool-fs (read/write/edit), tool-fs-search (glob/grep), bash, subagent, todo, web, skill и другие. В плановом режиме сказано: «*The tool catalog stays the same across modes for request-cache stability*». То есть каталог тулов не меняется ради кэша.

**7. На чём обучали** *(VERIFIED: DeepSeek_V41_Tech_Report.pdf, §5.1.2, §5.3.4, App. B.1)*
- «*We scale RL runs in two dimensions, i.e., training compute and the number of scaffolds.*» На рис. 8 есть кривые «Multi-version Claude Code RL» и «Multi-scaffold RL»: «*across heterogeneous scaffolds, including OpenCode, **Pi**, and DeepSeek Harness in Standard and PTC modes*».
- Данные для coding agent собирались из сессий сотрудников и партнёров плюс из GitHub-репозиториев. Для general agent строились mock-тулы, «*reproduce the interfaces and behaviors of real-world tools*».
- Таблица 4 (DeepSWE v1.1, Resolved, max effort, T=1.0, top_p=0.95):

| Claude Code | Codex | OpenCode | **Pi** | mini-SWE | DSH Minimal | DSH Standard | DSH PTC |
|---|---|---|---|---|---|---|---|
| 69.8 | 65.6 | 65.5 | **66.2** | **74.2** | 72.6 | 70.5 | 67.6 |

  На Terminal-Bench 2.1: Claude Code 88.0, Pi 86.1, mini-SWE 90.3, DSH Minimal 90.6.
- Конфигурации: Pi v0.84.2 «*RPC mode with file and shell tools plus a search extension*», mini-SWE «*single bash tool*». Вывод отчёта: «*agentic capabilities transfer well across scaffold families… not tightly coupled to a single scaffold design*».

**8. Anthropic API.** `https://api.deepseek.com/anthropic`. Имена `claude-opus*` сопоставляются с `deepseek-v4-pro`, остальные `claude*` с `deepseek-flash`. `budget_tokens` игнорируется. Thinking-блоки поддерживаются, `redacted_thinking` нет. `cache_control` и `is_error` у tool_result игнорируются. *(VERIFIED)*

**Через ретранслятор.** `reasoning_content` в сообщениях проходит через New API, поле есть в DTO. `reasoning_effort` тоже проходит. `thinking` проходит как raw-поле. `prompt_cache_hit_tokens` и `cached_tokens` проходят. `prompt_cache_miss_tokens` в DTO New API отсутствует, его можно вычислить. *(VERIFIED по коду; поведение конкретного маркетплейса UNVERIFIED)*

### 2.2 Zhipu / Z.ai GLM-5.3 и GLM-5.3-Flash/FlashX

**Модели** *(VERIFIED: docs.z.ai)*
- GLM-5.3 (HF: 2026-08-25, обновлена 2026-10-14) использует ту же базовую модель, что GLM-5.2, а весь прирост получен на post-training. Только текст, 1M контекста, 128K вывода.
- GLM-5.3-Flash: 320B параметров, из них 18B активных. Гибрид sparse и linear attention, нативно мультимодальная, 1M/128K. FlashX выдаёт около 200 tok/s.

**1. Tools** *(VERIFIED: function-calling, migrate-to-glm-new)*
- Формат OpenAI. `tool_choice` «*default is auto (only supports auto)*».
- Аргументы при стриминге приходят только при `stream=true` и `tool_stream=true`, их нужно склеивать из `delta.tool_calls[*].function.arguments`.
- Совет по описаниям тулов: «*Single responsibility… Complete description… provide detailed documentation and examples for each function*».
- Лимит на число тулов не указан.
- Важно для ретранслятора: Qwen Cloud перепродаёт GLM и пишет, что там GLM без `tool_stream: true` «*will not return tool_calls*». Для glm-5.3 у них по умолчанию `true`. *(VERIFIED: docs.qwencloud.com function-calling)* Если маркетплейс берёт GLM у такого посредника, это реальный риск.

**2. Thinking** *(VERIFIED: GLM-5.3 page, thinking-mode)*
- Thinking «*always operates with reasoning enabled… Disabling reasoning is no longer supported*». `reasoning_effort` low/high/max, по умолчанию max. Если передать `thinking.type:"disabled"`, запрос упадёт.
- **Interleaved thinking** работает по умолчанию: «*thinking blocks should be explicitly preserved and returned together with the tool results*».
- **Preserved thinking**: «*enabled by default on the Coding Plan endpoint and disabled by default on the standard API endpoint… set `"clear_thinking": false`, and you must return the complete, unmodified reasoning_content… must exactly match the original sequence… otherwise performance may degrade and cache hit rates may be affected*».
- В открытом chat template GLM-5.3 `clear_thinking` по умолчанию `false` (HF card).

**3. Sampling** *(VERIFIED)*
- temperature 1.0 и top_p 0.95 по умолчанию, «*not recommended to adjust both simultaneously*».
- Для Flash рекомендовано «*temperature: 1, top_p: 0.95, reasoning_effort: max… recommend `thinking.clear_thinking: false`… `tool_stream: true`*».
- В бенчмарках GLM для DeepSWE стоит T=0.95 и top_p=1.0, для Claude Code-бенчей T=1.0 и top_p 1.0/0.95.

**4. Кэш** *(VERIFIED: cache)*
- Неявный и автоматический, `usage.prompt_tokens_details.cached_tokens`, цена «обычно 50% от стандартной».
- TTL и минимальный префикс не указаны *(не найдено)*.

**5. Гайд.** Есть «Best Practice for Coding Agents»: Goal, Context, Constraints и Done-when; план перед исполнением; правила проекта в конфиг-файлах.

**6. Harness'ы** *(VERIFIED)*
- GLM Coding Plan «*can be applied to … ZCode, Claude Code, Codex, OpenCode, AutoClaw, OpenClaw*». Отдельная страница есть для **Pi Coding Agent** (`/devpack/tool/pi`).
- Для Claude Code рекомендуют `glm-5.3-flash[1m]` и `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`, effort max по умолчанию.
- Эндпоинты:
  - OpenAI (стандартный): `https://api.z.ai/api/paas/v4`
  - OpenAI (coding): `https://api.z.ai/api/coding/paas/v4`
  - Anthropic: `https://api.z.ai/api/anthropic`
  - Responses: `https://api.z.ai/api/v1`

**7. Обучение и оценки** *(VERIFIED: HF GLM-5.3 footnotes; GLM-5 tech report arXiv 2602.15763, **февраль 2026**; карточка 5.3 его цитирует, поэтому он включён)*
- Terminal-Bench 2.1/3.0, ALE, CyberGym, ExploitGym, PostTrainBench и SWE-Marathon оценивались «*in Claude Code 2.1.207*», DeepSWE в mini-swe-agent.
- Отчёт GLM-5: interleaved и preserved thinking введены со ссылкой на Claude («*Preserved thinking was also adopted by Claude since Opus 4.5*»). Agentic RL идёт через «*Multi-Task Rollout Orchestrator … joint training of complex agentic frameworks*». Конкретные схемы тулов для RL не названы *(не найдено)*. CC-Bench-V2 «*fully automated via Claude Code and other agent harnesses*».

**Через ретранслятор.** `thinking` вместе с `clear_thinking` проходит через New API: поле `THINKING` хранится как RawMessage. `tool_stream` **не проходит**, его нет в whitelist. Значит, стриминговых аргументов тулов может не быть, а у некоторых посредников вызовов тулов не будет вовсе. *(VERIFIED по коду; поведение апстрима UNVERIFIED)*

### 2.3 Moonshot Kimi K3

**Модель** *(VERIFIED: platform.kimi.ai; HF moonshotai/Kimi-K3; k3_tech_report.pdf)*
- 2.8T параметров, 104B активных. Слои KDA + Gated MLA, нативное зрение, 1M контекста.
- `max_completion_tokens` по умолчанию 131 072, максимум 1 048 576.

**1. Tools** *(VERIFIED: kimi-k3-quickstart, kimi-k3-tool-calling-best-practice, tool-call-repeat)*
- Формат OpenAI. `tool_choice:"required"` поддерживается. Совет: требовать вызов на первом ходу, затем вернуться к `auto`. Смена `tool_choice` «*does not invalidate the prefix cache*».
- **Динамическая загрузка тулов**: system-сообщение без content, но с полем `tools`. Тул становится доступен с этой позиции.
- Для больших каталогов рекомендуют объявить один `search_tools` и подгружать найденные тулы. «*don't put every tool definition into the request — they eat up context and make the model more likely to pick the wrong tool*».
- Борьба с повторами: проверить раскладку сообщений (assistant добавлен как есть, `tool_call_id` совпадает). При 3 одинаковых вызовах подряд добавить `<system-reminder>You are repeating the exact same tool call…</system-reminder>`, при 5 добавить усиленный вариант.

**2. Thinking** *(VERIFIED)*
- «*K3 always has thinking mode enabled*». `reasoning_effort` low/high/max, по умолчанию max. «*Kimi K3 was trained in the preserved thinking history mode… requires the complete assistant message… passed back… including `reasoning_content` and `tool_calls`*» (HF card).
- Из техотчёта (прил., формат XTML): «*Kimi K3 supports only preserved thinking: … the think channel is always retained in the history—kept even when its content is empty*».
- Аргументы тулов в нативном формате типизированы, строки передаются «как есть»: «*Free-form text such as code is therefore a first-class citizen rather than an escaped JSON string*».
- Effort и объявления тулов являются «глобальными опциями» в начале контекста: «*modifying them invalidates the KV cache anyway*». А `tool_choice` и `response_format` добавляются после сообщений.

**3. Sampling** *(VERIFIED)*
- «*`temperature=1.0`, `top_p=0.95`, `n=1`, `presence_penalty=0`, and `frequency_penalty=0` are fixed; omit them from requests.*» Рассуждения считаются в `max_tokens`.

**4. Кэш** *(VERIFIED: context-caching)*
- Автоматический. **Запись в кэш тарифицируется отдельно**: для kimi-k3 $3/M при TTL 5m и $6/M при 1h, попадание $0.30/M, промах $3/M.
- TTL задаётся через `prompt_cache_options: {mode:"implicit", ttl:"5m"|"1h"}`, по умолчанию 5m, каждое попадание продлевает срок. Кэш хранится блоками, неполный блок считается промахом.
- Usage: `prompt_tokens_details.cached_tokens` и `prompt_tokens_details.cache_write_tokens`. При стриминге нужен `stream_options.include_usage=true`.
- Рекомендации: стабильное держать в начале, изменяемое в конце, без timestamp'ов в префиксе. Кэш общий внутри организации.

**5. Промпт-гайд.** Перечисленные выше страницы best practice.

**6. Harness'ы** *(VERIFIED)*
- «*Kimi K3 works best with Kimi Code CLI as its agent framework*» (HF card).
- Старый Python-репозиторий `MoonshotAI/kimi-cli` **архивирован**. Текущий CLI — `MoonshotAI/kimi-code` на TypeScript, commit от 2026-10-22.
- Есть официальные гайды для Claude Code (через Anthropic-эндпоинт), Codex, OpenCode, Hermes и OpenClaw.
- Код Kimi Code (`packages/agent-core-v2/src/agent/tools`):
  - Тулы `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `Agent`, `Task*`, `AskUserQuestion`, `FetchURL`, `WebSearch`, `ReadMediaFile`. Имена и семантика как в Claude Code.
  - `Edit` принимает `path`, `old_string`, `new_string`, `replace_all`. Описание: «*Edit is mandatory for every incremental change… DO NOT use Write or Bash `sed`. Read the target file before every Edit… DO NOT issue consecutive Edit calls on the same file*».
  - `Read` принимает `line_offset`, `n_lines`, `max_chars`, `column_offset`. Вывод `<line-number>\t<content>`, в конце блок `<system>`.
  - `Bash` содержит таблицу «*cat/head/tail → Read; sed/awk → Edit; grep/rg → Grep*».
  - Системный промпт (`app/agentProfileCatalog/system.md`): «*Make independent tool calls in parallel in one response… Text wrapped in `<system-reminder>` tags is an authoritative directive from the harness*».
  - Наблюдение *(UNVERIFIED происхождение)*: в монорепо есть пакет `@moonshot-ai/pi-tui`, «Minimal terminal UI framework with differential rendering». По названию и описанию он похож на форк TUI из Pi.

**7. Обучение** *(VERIFIED: k3_tech_report.pdf §4.2.1)*
- «*Training with a single fixed agent harness can cause a model to overfit to a particular tool schema… we develop a unified white-box RL environment… can instantiate mainstream harnesses such as Kimi Code, Claude Code, Codex, OpenClaw, and Hermes… we dynamically construct different harness configurations for different task groups*».
- Таблица 3: Kimi Code Bench 2.0 даёт **73.7 в Claude Code и 72.9 в Kimi Code**. Coding Experience даёт 59.9 в Claude Code и 56.6 в Kimi Code. DeepSWE: 67.5 в Kimi Code и 67.3 в mini-SWE-agent.

**8. Anthropic API.** `https://api.moonshot.ai/anthropic`. TTL задаётся через top-level `cache_control.ttl`. *(VERIFIED)*

**Через ретранслятор.** `reasoning_content` проходит. `tools` на system-сообщении тоже проходит: в DTO New API есть отдельное поле с комментарием «*Kimi K3 dynamic tool loading*». `prompt_cache_options` **теряется**, поэтому TTL останется 5m. `cache_write_tokens` в usage проходит. Если шлюз или Pi сами подставят temperature или top_p, поведение K3 не определено: в доках написано «omit», но не сказано, будет ли ошибка. Это нужно проверить. *(VERIFIED по коду / UNVERIFIED поведение)*

### 2.4 Alibaba Qwen 3.8 (Qwen3.8-Max, Qwen3.8-Flash)

**Модели** *(VERIFIED: HF Qwen3.8-2.4T-A95B от 2026-08-08, Qwen3.8-Flash-Next от 2026-08-24, qwencloud.com)*
- `qwen3.8-max` построен на Qwen3.8-2.4T-A95B, в API добавлены «*vision input & non-thinking support, 1M context*».
- `qwen3.8-flash` построен на Qwen3.8-Flash-Next: 125B параметров, 6B активных, плюс n-gram embedding. Это «экспериментальная» архитектура будущего Qwen4.
- Max в API: 1M контекста, до 131K вывода, до 262K рассуждений. Цена $2/$6, неявный кэш $0.25.

**1. Tools** *(VERIFIED: docs.qwencloud.com function-calling)*
- «*By default, the model returns one tool call per response… set `parallel_tool_calls` to `true`*». **Параллельные вызовы выключены по умолчанию.**
- «*The Qwen series models do not support setting `tool_choice` to "required"*». В thinking-режиме допустимы только `auto` и `none`. Чтобы форсировать конкретный тул, нужно выключить thinking. Совет: «*Write clear, specific descriptions*».
- При суммаризации результатов нужно убирать `tool_choice`, иначе модель продолжит возвращать tool_calls.

**2. Thinking** *(VERIFIED: thinking.md, function-calling.md, HF)*
- Включается `enable_thinking`. Для Max режим hybrid. У открытых весов 2.4T отключить thinking нельзя.
- `reasoning_effort`: xhigh (по умолчанию), medium, low. Альтернатива — `thinking_budget`. Использовать оба сразу на qwen3.8-max нельзя, будет ошибка.
- «*When passing the assistant message back in subsequent requests, you must include the `reasoning_content` field*» (function calling + thinking).
- `preserve_thinking`: «*By default, models do not read `reasoning_content` from the `messages` array… Set `preserve_thinking` to `true`*». В списке моделей стоит «`qwen3.8-max`, …, `qwen3.8-omni-flash` (enabled by default)». Относится ли пометка «enabled by default» к Max и Flash, неясно *(UNVERIFIED)*. HF-карточка говорит, что `preserve_thinking` «*is enabled by default for all workloads*», но это про открытые веса.
- Совет из карточки Flash-Next: «*lower reasoning effort does not always reduce overall task completion time… more failures, and repeated retries*».
- В thinking-доке Qwen Cloud сказано: «*When thinking mode is enabled, the valid range for `max_tokens` is [1, 32768]*». Это противоречит заявленным 131K вывода *(UNVERIFIED, проверить)*.

**3. Sampling** *(VERIFIED, но источники противоречат друг другу)*
- HF (open weights): thinking — T=1.0, top_p=0.95, top_k=20, min_p=0, presence_penalty=0 (поднимать до 0–2 при зацикливании). Instruct — T=0.7, top_p=0.8, presence 1.5. Длина: 262 144 на рассуждения и 131 072 на ответ.
- API Qwen Cloud для qwen3.8-max: «*temperature: Defaults to 0.6 in thinking mode. Values below 0.6 are automatically adjusted to 0.6*».

**4. Кэш** *(VERIFIED: context-cache)*
- **Неявный кэш**: автоматический, отключить нельзя, минимум 1024 токена, попадание стоит около 20% цены, TTL «неопределённый».
- **Явный кэш**: маркер `"cache_control":{"type":"ephemeral"}` в content-блоке сообщения. TTL 5 минут, продлевается при попадании. Создание стоит 125%, попадание 10%. Поиск идёт на 20 блоков назад.
- **Session cache**: для Responses API, заголовок `x-dashscope-session-cache: enable`.
- В Chat Completions явный и неявный кэш взаимоисключающие. Usage: `prompt_tokens_details.cached_tokens` и `cache_creation_input_tokens`.

**5. Гайд.** Function calling и thinking-гайды плюс «Explicit Cache Best Practices».

**6. Harness'ы** *(VERIFIED)*
- **Qwen Code** — «*Official terminal-based AI coding tool*», форк Gemini CLI: в файлах заголовки «Copyright 2025 Google LLC». Commit от 2026-10-22.
- Также есть гайды для Claude Code (Anthropic-эндпоинт Token Plan), OpenCode, Codex, DeepSeek Harness, WorkBuddy, QwenPaw, Cline, Qoder, Kilo и Hermes.
- Код Qwen Code (`packages/core/src/tools`):
  - Тулы `edit` (`file_path`, `old_string`, `new_string`, `replace_all`; «*Include at least 3 lines of context BEFORE and AFTER*»), `read_file`, `write_file`, `grep_search`, `glob`, `run_shell_command`, `list_directory`, `todo_write`, `agent`, `skill`, `web_fetch`, `web_search`, `lsp`, `ask_user_question` и др.
  - Системный промпт подставляет **примеры вызовов тулов в нативной нотации модели**: XML `<function=…>` для qwen-coder, JSON для qwen-vl, нативный формат Gemma 4, иначе «общий» bracket-формат (`core/prompts.ts`, `getToolCallExamples`).
  - Провайдер DashScope всегда шлёт `preserve_thinking: true`. Default-провайдер дублирует `reasoning_content` в поле `reasoning`, чтобы покрыть разные бэкенды.

**7. Обучение и оценки** *(VERIFIED: HF footnotes)*
- SWE-bench Pro, Terminal-Bench 2.1, NL2Repo, FrontierSWE, QwenSWEBench и QwenQoderBench оценивались в Claude Code.
- DeepSWE: «*Evaluated with the Claude Code and mini-SWE-agent harnesses… notably, Qwen3.8-Max performs best on Claude Code*». Для Flash-Next наоборот: «*notably, Qwen3.8-Flash-Next performs best on mini-SWE-agent*».
- SkillsBench для Qwen оценивался в OpenCode. Подробностей о том, на каких scaffold'ах шёл RL, в найденных материалах нет *(не найдено; техотчёт Flash-Next посвящён архитектуре)*.

**8. Anthropic API.** Есть (`api-reference/chat/anthropic`, Token Plan: `…/apps/anthropic`). *(VERIFIED)*

**Через ретранслятор.** `enable_thinking`, `thinking_budget`, `chat_template_kwargs` и `parallel_tool_calls` проходят через New API. `cache_control` внутри content-частей тоже проходит: поле `CacheControl` есть в `MediaContent`. **`preserve_thinking` теряется**, его нет в whitelist. Ещё одна оговорка: `thinking_budget` New API обнуляет для моделей, которые не считает «Qwen thinking-budget» моделями. *(VERIFIED по коду)*

### 2.5 MiniMax M3 и M3.1-Flash

**Модели** *(VERIFIED)*
- **MiniMax-M3**: HF от 2026-06-02, около 428B параметров и 23B активных, MiniMax Sparse Attention, 1M контекста. Техотчёт arXiv 2606.13392 описывает только архитектуру MSA.
- **MiniMax-M3.1-Flash** вышел 2026-10-19, пока только в API, веса «позже». $0.15 вход, $0.60 выход, $0.015 кэш. Заявлено 73.7 на DeepSWE v1.1.

**1. Tools** *(VERIFIED: text-m3-function-call, OpenAPI spec)*
- Форматы OpenAI и Anthropic, Anthropic-эндпоинт помечен как «recommended… supports thinking blocks, interleaved thinking».
- «*In multi-turn function call conversations, the complete model response… must be appended*».
- `parallel_tool_calls` и `strict` в OpenAPI-спеке Chat Completions не описаны *(не найдено)*.

**2. Thinking** *(VERIFIED)*
- **Критично для M3 через OpenAI API**: «*the `content` field will contain `<think>` tag content, which must be preserved completely*». Параметр `reasoning_split=true` переносит рассуждения в `reasoning_content`, но сам thinking не включает и не выключает.
- `MiniMax-M3.1-Flash` всегда отдаёт `reasoning_content` отдельно, его тоже нужно сохранять. Рассуждения адаптивные: на простом ходе поля может не быть, «*check whether the field exists… always append the full returned message*».
- M3: `thinking` принимает enabled, adaptive или disabled. В OpenAPI написано, что adaptive включён по умолчанию, а на странице Anthropic API сказано «*Thinking is off by default for MiniMax-M3*». Это противоречие *(UNVERIFIED)*.
- M3.1-Flash: effort low/medium/high/xhigh/max, по умолчанию max. `disabled` и `none` возвращают 400.
- Блог про M2 (2025, всё ещё есть в текущих доках, дату указываю явно): «*Agents require Interleaved Thinking… you must retain the full session history, including the thinking steps… much of the community feedback about performance gaps stems from accidentally discarding this vital context*».

**3. Sampling.** temperature «*Not supported yet… always use 1*», top_p «*always use 0.95*». HF M3 рекомендует T=1.0 и top_p=0.95. `max_tokens` включает рассуждения: при малом значении ответ придёт без текста. *(VERIFIED)*

**4. Кэш** *(VERIFIED: text-prompt-caching, OpenAPI example)*
- Автоматический. Порядок префикса: tools, затем system, затем сообщения. Usage: `prompt_tokens_details.cached_tokens` или `cache_read_input_tokens`.
- Минимум 512 токенов и цены знаю из выдачи поиска по официальным страницам, но этот фрагмент страницы сам не читал *(UNVERIFIED)*. Явный кэш в Anthropic API живёт 5 минут.

**5–6. Harness'ы** *(VERIFIED)*
- Официальные страницы есть для **Claude Code** (`MiniMax-M3.1-Flash[1m]`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=524288` как «*recommended 512K*», effort max), Hermes Agent и **Pi** (`pi --provider minimax --model MiniMax-M3.1-Flash`).
- Также есть десктопный **MiniMax Code** и мастер настройки `mmx-cli agent setup`.
- Старый `MiniMax-AI/Mini-Agent` с последним коммитом в феврале 2026 устарел и сюда не включён.

**7. Обучение.** Для M3 и M3.1 открытых данных о scaffold'ах нет *(не найдено)*. Для линии M2 (2025) MiniMax описывал обучение на «пертурбациях» тулов, системного промпта, окружения и scaffold'ов: «*if we changed the environment even slightly—like swapping to a different scaffolding framework—its performance would plummet*», это и решали.

**Через ретранслятор.** `reasoning_split` проходит через New API. `reasoning_details` на уровне сообщения **не проходит**. Главный риск для M3: любой «чистильщик» `<think>` в шлюзе или в Pi сломает модель. *(VERIFIED по коду / вывод)*

### 2.6 Google Gemini 4 Argon (+ 3.8 Flash), кратко

- `gemini-4-argon`: обновлён в октябре 2026, 1M контекста, вывод 65 536 (long decode до 1M в background). `thinking_level` low, medium (по умолчанию, «*Recommended for most tasks, including complex code and agentic use cases*») или high. *(VERIFIED: models, latest-model)*
- «*Remove `temperature`, `top_p`, and `top_k`… they are ignored.*» Явный кэш на Argon **не поддерживается**. Неявный включён для промптов от 4096 токенов и даёт скидку 95%. `max_output_tokens` советуют ставить ≥32 768. *(VERIFIED)*
- OpenAI compat: `reasoning_effort` minimal/low дают `low`, medium даёт `medium`, high даёт `high`. *(VERIFIED)*
- **Thought signatures**:
  - В Chat Completions подпись лежит в `tool_calls[i].extra_content.google.thought_signature`.
  - При параллельных вызовах она есть только у первого. «*Strict validation is enforced for all function calls within the current turn… omit… will fail with a 400 error*».
  - Порядок FC1, FC2, FR1, FR2 обязателен. Если чередовать вызовы и ответы, будет 400.
  - Есть обходные значения `"context_engineering_is_the_way_to_go"` и `"skip_thought_signature_validator"`.
  - *(VERIFIED: generate-content/thought-signatures)*
- New API в конвертере OpenAI→Gemini умеет при включённой настройке подставлять именно `context_engineering_is_the_way_to_go` (`relaykit/relayconvert/internal/shared/gemini/request.go`). В `ToolCallResponse` нет поля `extra_content`. Вывод: через такой маркетплейс Gemini, скорее всего, будет работать **без настоящих подписей**, то есть без 400, но с потерей непрерывности рассуждений между шагами. *(VERIFIED по коду; на маркетплейсе UNVERIFIED)*
- Gemini CLI (`packages/core/src/tools/definitions`, commit от 2026-10-21):
  - Тулы `replace` (`file_path`, `instruction`, `old_string`, `new_string`, `allow_multiple`), `read_file` (`start_line`/`end_line`), `write_file`, `grep_search`, `glob`, `run_shell_command`, `list_directory`, `google_web_search`, `web_fetch`, `write_todos`.
  - Есть **отдельные наборы описаний тулов для разных семейств моделей**: `model-family-sets/gemini-3.ts` и `default-legacy.ts`.
  - Google также продвигает Antigravity как агента.

### 2.7 xAI Grok 4.7, кратко

- `reasoning_effort`: low, medium, high (по умолчанию) или xhigh. Отключить нельзя. «*`presencePenalty`, `frequencyPenalty`, and `stop` cannot be used with reasoning models. Requests that include them return an error.*» *(VERIFIED)*
- Зашифрованные рассуждения есть только в Responses API (`reasoning.encrypted_content`).
- Prefix-кэш, `prompt_tokens_details.cached_tokens`. Заголовок `x-grok-conv-id` повышает долю попаданий. «*For reasoning models, you must include `reasoning_content` from previous responses; omitting it is the top cause of cache misses*». *(VERIFIED)*
- «*With streaming, the function call is returned in whole in a single chunk*». *(VERIFIED)*
- Через ретранслятор: заголовок `x-grok-conv-id`, скорее всего, не дойдёт *(UNVERIFIED)*.

### 2.8 Для контраста: Anthropic и OpenAI

- **Anthropic**: «*Anthropic-schema client tools — Anthropic publishes the schema and trains Claude on it*». Это bash, memory и text editor `str_replace_based_edit_tool` (`text_editor_20250728`; команды view, str_replace, create, insert; `old_str`/`new_str`). *(VERIFIED: tool-use overview, text-editor-tool)*
- Opus 5.5 и Fable 5.1 работают только в adaptive thinking: `thinking.type:"enabled"` даёт 400. «*when you return tool results, you must pass the thinking blocks… complete and unmodified*». *(VERIFIED)*
- Официальная OpenAI-совместимость Anthropic: `strict` игнорируется, `reasoning_effort` игнорируется, prompt caching не поддерживается. *(VERIFIED: api/openai-sdk)*
- New API конвертирует OpenAI-запрос в Claude и сопоставляет `reasoning_effort` с effort/thinking по таблице моделей (в `reasoning/claude.go` есть Opus 5.5 и Fable 5). Но в `to_claude_messages_req.go` нет переноса `reasoning_content` в thinking-блоки. Значит, в многошаговом цикле с тулами Claude через ретранслятор будет терять свои рассуждения. Документация Anthropic говорит, что в таком случае API «*silently disables thinking for that request*» или срезает блоки. *(вывод из кода и доков, UNVERIFIED на практике)*
- **OpenAI**: `apply_patch` (V4A diff, операции create/update/delete) описан для GPT-5.1+ (страница tools-apply-patch, текущая).
- Важно для премиум-роли: «*Reasoning models work better with the Responses API*». Сохранение рассуждений между ходами (`reasoning.context: all_turns`) есть только в Responses API, GPT-5.6 его поддерживает.
- Самые новые **GPT-6 Astra и GPT-6.1 Sol** вообще «*Chat Completions does not support function calling*». Значит, при доступе только через Chat Completions вызов тулов с reasoning у новейших моделей OpenAI недоступен. GPT-5.6 в Chat Completions поддерживается. *(VERIFIED: guides/reasoning, latest-model, models/gpt-5.6)*

---

## 3. Гипотеза «дешёвые модели надёжнее всего со схемами тулов в стиле Claude Code»

### За

1. **Claude Code — основной harness, в котором вендоры оценивают модели.** GLM-5.3 оценивается в Claude Code 2.1.207. Qwen3.8 оценивался в Claude Code почти на всех кодинговых бенчах. Kimi K3 оценивал все Claude- и GLM-модели в Claude Code и сам набрал 73.7 в Claude Code против 72.9 в Kimi Code. DeepSeek оценивал визуальные и SEC-бенчи в Claude Code. *(VERIFIED)*
2. **Claude Code прямо входит в RL-обучение.** DeepSeek V4.1 прошёл «Multi-version Claude Code RL», Kimi K3 обучался в среде, которая собирает Claude Code. *(VERIFIED)*
3. **Собственные CLI вендоров сходятся к той же форме схем.** Kimi Code `Edit(path, old_string, new_string, replace_all)`, Qwen Code `edit(file_path, old_string, new_string, replace_all)`, DSH `edit(file_path, old_string, new_string, replace_all)` с текстом ответа Claude Code и Gemini CLI `replace(file_path, instruction, old_string, new_string, allow_multiple)`. Плюс Read с номерами строк, Bash, Glob и Grep, имена в Kimi Code совпадают с Claude Code. Kimi Code и DSH переняли `<system-reminder>`. *(VERIFIED по коду)*
4. У всех пяти китайских вендоров есть Anthropic-эндпоинты и гайды «Claude Code + наша модель». Вендоры явно хотят совместимости с Claude Code. *(VERIFIED)*
5. Pi использует вложенный `edits:[{oldText,newText}]`, и в его коде есть обход: «*Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array*». Это известный класс сбоев: модели сериализуют вложенные массивы и объекты в строку. С плоскими строковыми параметрами такого не бывает. *(VERIFIED)*

### Против / уточнения

1. **Минимальные scaffold'ы бывают лучше Claude Code.** DeepSeek V4.1-Flash набирает 74.2 в mini-SWE (один bash) и 72.6 в DSH Minimal против 69.8 в Claude Code на DeepSWE. На Terminal-Bench 2.1 счёт 90.3 и 90.6 против 88.0. Qwen3.8-Flash-Next «*performs best on mini-SWE-agent*». *(VERIFIED)*
2. **Вендоры специально учат модели не зависеть от scaffold'а.** DeepSeek пишет «*not tightly coupled to a single scaffold design*», Kimi «*overfit to a particular tool schema*» (то есть с этим боролись), MiniMax в 2025 году делал «*full-trajectory generalization*». Разброс между harness'ами 1–8 п.п. Это сопоставимо с разницей между версиями Claude Code: у DeepSeek от 68.4 до 69.8. *(VERIFIED)*
3. **Pi сам входил в RL DeepSeek** и набирает 66.2 на DeepSWE и 86.1 на Terminal-Bench 2.1. Это немного ниже Claude Code (69.8 и 88.0), но не провал. Для DeepSeek это прямое доказательство, что Pi-схемы модели знакомы. *(VERIFIED)*
4. **Нативные форматы аргументов у вендоров не JSON.** У DeepSeek это DSML с `string="true"`, у Kimi XTML с типизированными аргументами. Вендоры стараются, чтобы код в аргументах не экранировался. Значит, важнее всего плоские **строковые** параметры для больших текстов, а не конкретные имена. *(VERIFIED по encoding/техотчётам)*
5. Причины деградации на дешёвых моделях, о которых пишут вендоры, — это в первую очередь **протокольные ошибки**: потеря `reasoning_content` или `<think>`, неверная раскладка tool_call_id, слишком маленький `max_tokens` и смена effort или набора тулов в середине сессии. Имена параметров тут вторичны (Kimi tool-call-repeat, MiniMax M2 blog, GLM preserved thinking). *(VERIFIED)*

### Вывод

Гипотеза **частично подтверждается**. Плоская схема в стиле Claude Code — самый безопасный общий знаменатель. Под неё модели учили и оценивали все вендоры: Read с номерами строк, `Edit(file_path, old_string, new_string, replace_all)`, Write, Bash, Glob и Grep. Но это не главный фактор надёжности и не всегда оптимум. Для DeepSeek на кодовых задачах минимальный bash-only режим даёт больше. Ни у одного семейства нет доказательств, что именно имена параметров дают большой выигрыш.

Рекомендация для ядра:
- Основной набор: плоские тулы в стиле Claude Code (`file_path`/`old_string`/`new_string`/`replace_all`), а не вложенный массив `edits[]` из Pi. Если остаётся Pi-edit, нужен толерантный парсинг. Он в Pi уже частично есть.
- Отдельный «минимальный» профиль (bash плюс `str_replace_editor`) для DeepSeek и Qwen-Flash, чтобы прогнать A/B.
- Каталог тулов неизменен в течение сессии.

---

## 4. Правила для шлюза и harness'а

### 4.1 Обязательно передавать и не обрезать

1. **Assistant-сообщения из истории возвращать байт в байт**: `content`, `reasoning_content` (или `reasoning`), `tool_calls` с тем же `id` и порядком. Для DeepSeek с tools это **рассуждения всех ходов**, даже без вызова тула, иначе 400. Для GLM это при `clear_thinking:false` «*exactly match the original sequence*». Kimi K3 требует всегда. Qwen требует при tools. Для MiniMax M3 через OpenAI API **не вырезать `<think>…</think>` из `content`**. Для M3.1-Flash сохранять `reasoning_content`, а если поля нет, сохранять сообщение как есть.
2. Если поле `reasoning_content` пустое или его нет, не придумывать его. Исключение: Pi умеет для DeepSeek добавлять пустой `reasoning_content` (`requiresReasoningContentOnAssistantMessages`). Включать это только для DeepSeek.
3. **Порядок tool results**: все ответы идут после всех вызовов, в порядке вызовов. Это обязательно для Gemini, у DeepSeek и Kimi результаты сортируются по порядку `tool_calls`. На каждый `tool_call` нужен ровно один `role:tool` с совпадающим `tool_call_id`.
4. **Usage прокидывать полностью**: `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens` (DeepSeek), `cache_write_tokens` (Kimi), `cache_creation_input_tokens` (Qwen), `reasoning_tokens`. При стриминге запрашивать `stream_options.include_usage=true`.
5. **Non-standard поля, которые New API по умолчанию режет**: `preserve_thinking`, `tool_stream`, `prompt_cache_options` и `reasoning_details`. Если ретранслятор не включает passthrough (`pass_through_request_enabled` или `PassThroughBodyEnabled` у канала), учитывать, что их нет.

### 4.2 Стабильность префикса для кэша

- Порядок: system, затем каталог тулов, затем история. Никаких timestamp'ов или случайных ID в system. Дата передаётся отдельным поздним сообщением: у DeepSeek для этого есть роль `latest_reminder`, Kimi Code передаёт дату через reminders.
- **Не менять набор тулов и `reasoning_effort` в течение сессии.** Kimi прямо пишет, что это «*invalidates the KV cache*». OpenAI советует держать effort неизменным ради кэша, DSH держит каталог одинаковым во всех режимах. Режимы plan и act переключать через текст и system-reminder, а не через смену `tools`.
- `tool_choice` можно менять (Kimi подтверждает, что кэш не сбрасывается). Новые тулы для Kimi лучше добавлять динамически в конец через system-сообщение с `tools`.
- Compaction-срезы и правки истории делать редко и крупными шагами: любая правка префикса сбрасывает кэш у всех вендоров.

### 4.3 Параметры по умолчанию для каждой роли (стартовые, подлежат проверке)

| Роль / модель | effort | temperature / top_p | Прочее |
|---|---|---|---|
| Исполнитель: `deepseek-flash` | `reasoning_effort: high`, `max` для сложного | не передавать (игнорируются) | `max_tokens` ≥ 64K, лучше 128K. tools ⇒ полный возврат `reasoning_content` |
| Исполнитель: GLM-5.3-Flash | `high` (по умолчанию max дорог) | T=1.0, top_p=0.95 (или не передавать) | `thinking:{type:"enabled", clear_thinking:false}`, `tool_choice` не форсировать |
| Исполнитель/планер: Kimi K3 | `high` или `max` | **не передавать** | `max_completion_tokens` ≥ 32K. Возвращать сообщение целиком. Детектор повторов вызовов |
| Исполнитель: Qwen3.8-Flash / Max | `medium` или `xhigh` | API: не ниже 0.6 (или не передавать). Open weights: 1.0/0.95/top_k 20 | `enable_thinking:true`, `parallel_tool_calls:true`, `preserve_thinking:true` (если дойдёт). Не использовать `tool_choice:"required"` |
| Исполнитель: MiniMax M3.1-Flash | `high` (по умолчанию max) | не передавать | Сохранять `reasoning_content`. Для M3 `reasoning_split:true`, иначе сохранять `<think>` в content |
| Планер/советник: Claude Opus 5.5 / Fable 5.1 | effort high | не передавать | Через ретранслятор лучше короткие вызовы без многошаговых tool-циклов (рассуждения теряются) |
| Планер/советник: Gemini 4 Argon | `medium` или `high` | не передавать | `max_tokens` ≥ 32K, таймаут ≥ 15 мин |
| Планер/советник: GPT-5.6 | `medium` или `high` | **не передавать** (при effort≠none) | Многошаговые tool-циклы в Chat Completions без сохранения рассуждений. Лучше одношаговые консультации |
| Планер: Grok 4.7 | `high` | не передавать penalties и `stop` | — |

### 4.4 Конфигурация Pi за шлюзом

Pi определяет совместимость по провайдеру или URL (`detectCompat` в `packages/ai/src/api/openai-completions.ts`). За нашим URL всем моделям достанутся значения по умолчанию: `supportsDeveloperRole: true`, `supportsStore: true`, `maxTokensField: "max_completion_tokens"`, `thinkingFormat: "openai"`, `supportsMidConvoSystemMessages: false`, `supportsMidConvoToolAdditions: false`. Для каждой модели нужно явно прописать `compat`:
- DeepSeek: `thinkingFormat: "deepseek"`, `requiresReasoningContentOnAssistantMessages: true`, `maxTokensField: "max_tokens"`, `supportsDeveloperRole: false`, `supportsStore: false`. Mid-conversation system можно включить, DeepSeek его поддерживает.
- GLM: `thinkingFormat: "zai"`. Pi сам шлёт `clear_thinking:false`. `zaiToolStream: true`, если поле проходит. `maxTokensField: "max_tokens"`, `supportsReasoningEffort` по необходимости. **Внимание:** в режиме `zai` Pi без заданного reasoning effort отправляет `thinking:{type:"disabled"}` (`openai-completions.ts`, около строки 896). GLM-5.3 и 5.3-Flash на это отвечают ошибкой, поэтому для GLM effort нужно задавать всегда. *(VERIFIED по коду Pi и докам Z.ai)*
- Kimi: `supportsMidConvoToolAdditions: true` (динамические тулы). Не слать sampling. `maxTokensField: "max_tokens"`.
- Qwen: `thinkingFormat: "qwen"` (`enable_thinking`).
- MiniMax: убедиться, что Pi не превращает `<think>` в content в thinking-блок без возврата. При сомнениях использовать `reasoning_split`.

---

## 5. Что проверить экспериментом через ретранслятор

Для каждой модели прогнать короткий скрипт из трёх и более ходов с tools и записать сырые JSON запросов и ответов.

1. **Возврат `reasoning_content`.** Есть ли он в ответе ретранслятора и в стриминге (`delta.reasoning_content`)? Не переименован ли в `reasoning`? Доходит ли он до апстрима при повторной отправке? Для DeepSeek с tools: убрать `reasoning_content` из истории и проверить, вернётся ли 400. Если 400 нет, ретранслятор делает что-то сам: подставляет поле или отключает thinking.
2. **MiniMax M3**: приходит ли `<think>` внутри `content` и не вырезает ли его ретранслятор. Работает ли `reasoning_split:true`.
3. **Non-standard поля**: дошли ли `preserve_thinking`, `tool_stream`, `prompt_cache_options`, `thinking.clear_thinking`, `reasoning_split` и `chat_template_kwargs`. Метод: отправить заведомо невалидное значение (например `reasoning_effort:"bogus"`) и посмотреть, какая ошибка вернётся, от апстрима или от ретранслятора.
4. **Usage и кэш**: на двух одинаковых запросах по 5–10K токенов растёт ли `cached_tokens` или `prompt_cache_hit_tokens`. Сколько кэш живёт через 6 минут, 30 минут и 2 часа. Для Kimi: приходит ли `cache_write_tokens` и списывается ли запись.
5. **Sampling**: что происходит, если передать temperature для Kimi K3, GPT-5.6 с reasoning и Gemini 4 Argon. Будет ошибка, игнорирование или ретранслятор сам подставит значения по умолчанию.
6. **Параллельные вызовы**: Qwen без и с `parallel_tool_calls:true`, GLM и DeepSeek на запросе «прочитай 3 файла».
7. **`tool_choice`**: `required` у GLM, Qwen в thinking-режиме и Kimi K3. Ожидаются ошибка, деградация до auto и работа соответственно.
8. **Стриминг аргументов тулов**: приходят ли `index` и `id` в каждом delta, склеиваются ли аргументы (GLM без `tool_stream`, Grok целиком, Gemini без `index`).
9. **Gemini через ретранслятор**: появляется ли `extra_content.google.thought_signature` в ответе. Проходит ли второй ход с tool result без 400. Есть ли признаки подстановки обходной подписи.
10. **Claude через ретранслятор**: в многошаговом tool-цикле с thinking возвращаются ли рассуждения после первого tool_result и сколько стоит ход по `reasoning_tokens`. Сравнить качество с одношаговым вызовом.
11. **Реальная модель за алиасом**: какое значение в `model` ответа и какой fingerprint, например у `deepseek-v4-pro` (V4-Pro-0813 или V4.1-Flash?), а также у «GLM 5.3», «Qwen 3.8 Max» на маркетплейсе. Не подменяет ли ретранслятор модель.
12. **A/B схем тулов** на 20–30 локальных задачах для каждой дешёвой модели:
    - (a) плоский набор в стиле Claude Code (Read, Edit, Write, Bash, Glob, Grep);
    - (b) стандартные тулы Pi (`edits[]`);
    - (c) минимальный bash плюс `str_replace_editor`.

    Метрики: доля решённых задач, невалидные аргументы (особенно строка вместо массива в `edits`), повторы вызовов, токены на задачу.
13. **Смена effort или набора тулов посреди сессии**: как падает `cached_tokens` после изменения (Kimi, DeepSeek).
14. **Max tokens у Qwen в thinking-режиме**: принимается ли значение больше 32 768.

---

## 6. Источники

Даты: «опубл.» — дата публикации из самого источника. «Снято» — дата загрузки, если на странице нет даты (вся документация загружена 2026-10-22).

**DeepSeek**
- https://api-docs.deepseek.com/guides/thinking_mode — Thinking Mode (без даты; снято 2026-10-22; описывает `deepseek-flash`, то есть актуальна после 2026-09-10)
- https://api-docs.deepseek.com/guides/tool_calls — Tool Calls, strict mode (снято 2026-10-22)
- https://api-docs.deepseek.com/guides/kv_cache — Context Caching (снято 2026-10-22)
- https://api-docs.deepseek.com/guides/anthropic_api — Anthropic API (снято 2026-10-22)
- https://api-docs.deepseek.com/quick_start/pricing — Models & Pricing (снято 2026-10-22)
- https://api-docs.deepseek.com/api/create-chat-completion — API reference (снято 2026-10-22)
- https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code — интеграция с Claude Code (снято 2026-10-22)
- https://api-docs.deepseek.com/news/news261017 — релиз V4.1-Flash-1017 (опубл. 2026-10-17)
- https://api-docs.deepseek.com/news/news260910 — релиз V4.1-Flash (опубл. 2026-09-10)
- https://api-docs.deepseek.com/news/news260813 — V4-Pro GA (опубл. 2026-08-13)
- https://api-docs.deepseek.com/news/news260424 — V4 Preview (опубл. **2026-04-24**; до июня, включён как контекст: V4-Pro всё ещё в API)
- https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash (карточка: создана 2026-09-10, обновлена 2026-10-16) и `encoding/README.md` в том же репозитории
- https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017 (опубл. 2026-10-17)
- https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/DeepSeek_V41_Tech_Report.pdf — техотчёт V4.1 (сентябрь 2026)
- https://github.com/deepseek-ai/deepseek-harness — DeepSeek Harness (commit 687f282, 2026-10-17); https://deepseek-harness.github.io/deepseek-harness/ (снято 2026-10-22)

**Zhipu / Z.ai**
- https://docs.z.ai/guides/llm/glm-5.3 ; https://docs.z.ai/guides/vlm/glm-5.3-flash ; https://docs.z.ai/guides/overview/migrate-to-glm-new (без даты; снято 2026-10-22; GLM-5.3 вышла около 2026-08-25)
- https://docs.z.ai/guides/capabilities/thinking-mode ; https://docs.z.ai/guides/capabilities/function-calling ; https://docs.z.ai/guides/capabilities/cache (снято 2026-10-22)
- https://docs.z.ai/devpack/overview ; https://docs.z.ai/devpack/latest-model ; https://docs.z.ai/devpack/tool/pi ; https://docs.z.ai/devpack/resources/best-practice (снято 2026-10-22; в индексе упомянуто изменение от 2026-10-16)
- https://huggingface.co/zai-org/GLM-5.3 (создана 2026-08-25, обновлена 2026-10-14)
- https://arxiv.org/abs/2602.15763 — «GLM-5: from Vibe Coding to Agentic Engineering» (опубл. **февраль 2026**; цитируется карточкой GLM-5.3 как техотчёт)

**Moonshot Kimi**
- https://platform.kimi.ai/docs/guide/kimi-k3-quickstart ; …/use-thinking-models ; …/kimi-k3-tool-calling-best-practice ; …/tool-call-repeat ; …/context-caching ; …/claude-code-kimi ; …/kimi-code-cli (снято 2026-10-22)
- https://huggingface.co/moonshotai/Kimi-K3 (создана 2026-06-13, обновлена 2026-09-02)
- https://github.com/MoonshotAI/Kimi-K3 — `k3_tech_report.pdf` (commit от 2026-08-06)
- https://github.com/MoonshotAI/kimi-code — Kimi Code CLI (commit 44cdf8f, 2026-10-22)
- https://github.com/MoonshotAI/kimi-cli — архивирован (последний commit 2026-09-22), только как подтверждение замены

**Qwen**
- https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B (2026-08-08, обновлена 2026-08-12) ; https://huggingface.co/Qwen/Qwen3.8-Flash-Next (2026-08-24, обновлена 2026-08-27)
- https://www.qwencloud.com/models/qwen3.8-max ; https://www.qwencloud.com/models/qwen3.8-flash (llms.txt «Checked on 2026-10-19»)
- https://docs.qwencloud.com/developer-guides/tool-calling/function-calling ; …/text-generation/thinking ; …/run-and-scale/context-cache ; …/clients-and-developer-tools/qwen-code ; …/clients-and-developer-tools/claude-code (снято 2026-10-22)
- https://github.com/QwenLM/qwen-code — Qwen Code (commit 013b805, 2026-10-22)

**MiniMax**
- https://platform.minimax.io/docs/guides/text-generation ; …/guides/text-m3-function-call ; …/api-reference/text-openai-api ; …/api-reference/text-anthropic-api ; …/api-reference/text/api/openapi-chat-openai.json ; …/api-reference/text-prompt-caching ; …/token-plan/claude-code ; …/token-plan/pi (снято 2026-10-22)
- https://www.minimax.io/blog/minimax-m31f — M3.1 Flash (опубл. 2026-10-19)
- https://huggingface.co/MiniMaxAI/MiniMax-M3 (2026-06-02, обновлена 2026-07-23) ; https://arxiv.org/abs/2606.13392 — MiniMax Sparse Attention (июнь 2026)
- https://platform.minimax.io/docs/guides/text-m2-agent-generalization — «Aligning to What?» (о M2, **2025**; включено, потому что остаётся в текущих доках как руководство по interleaved thinking)

**Google / xAI / Anthropic / OpenAI**
- https://ai.google.dev/gemini-api/docs/models ; …/latest-model ; …/models/gemini-4-argon (Argon «Latest update: October 2026») ; …/openai ; …/thinking ; …/generate-content/thought-signatures (снято 2026-10-22)
- https://github.com/google-gemini/gemini-cli (commit 09d81bf, 2026-10-21)
- https://docs.x.ai/developers/grok-4-7 ; …/model-capabilities/text/reasoning ; …/advanced-api-usage/prompt-caching/how-it-works ; …/prompt-caching/multi-turn ; …/tools/function-calling (снято 2026-10-22)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview ; …/tool-use/text-editor-tool ; https://platform.claude.com/docs/en/api/openai-sdk ; https://platform.claude.com/docs/en/build-with-claude/thinking ; …/extended-thinking (снято 2026-10-22; упоминают Opus 5.5 и Fable 5.1)
- https://developers.openai.com/api/docs/guides/tools-apply-patch (текущая страница, текст про GPT-5.1) ; https://developers.openai.com/api/docs/guides/reasoning ; https://developers.openai.com/api/docs/guides/latest-model (GPT-6) ; https://developers.openai.com/api/docs/models/gpt-5.6 (снято 2026-10-22)

**Инфраструктура (для оценки ретранслятора и Pi)**
- https://github.com/QuantumNous/new-api — commit d8e6561 (2026-10-22): `relaykit/dto/openai_request.go`, `relaykit/dto/openai_response.go`, `relay/compatible_handler.go`, `relaykit/relayconvert/internal/shared/gemini/request.go`, `relaykit/relayconvert/reasoning/claude.go`, `setting/model_setting/global.go`
- https://github.com/earendil-works/pi — commit db77405 (2026-10-22): `packages/ai/src/api/openai-completions.ts` (`detectCompat`), `packages/ai/src/providers/compat-schema.ts`, `packages/coding-agent/src/core/tools/edit.ts`
