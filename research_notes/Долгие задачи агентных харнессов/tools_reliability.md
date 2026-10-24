# Дизайн инструментов и слой надёжности для длинных прогонов агента (срез 2026-10-24)

Обозначения: **[V]** — проверено в этой сессии (страница или код открыты и прочитаны); **[U]** — не проверено: пересказ поисковой выдачи, слабый источник или цифры только на графике; **[K]** — по памяти, в этой сессии не перепроверено. **НОВОЕ** — фактов нет в `research/00-synthesis.md` и досье 01–08. Где факт уже есть в досье, даю ссылку на номер досье и не повторяю его.

Контекст запроса: Pi 1.4 + дешёвые модели через шлюз a6api.com. Наблюдались: россыпь мелких bash/python-вызовов на рутинных шагах, петли (50 минут правки парсера без перезапуска проверки), обход правил из промпта, потерянные ходы на таймаутах поставщика. Шаги пайплайна известны заранее.

---

## 1. Anthropic: workflows и agents (дек. 2024) и правила написания тулов (2025): что конкретно и есть ли измеренный выигрыш

### Takeaway
По Anthropic, если шаги известны заранее, это **workflow**: «predefined code paths», а не агент. Агент оправдан, только когда подзадачи нельзя предсказать. Правила для тулов: укрупнять, давать неймспейсы, возвращать осмысленный контекст, по умолчанию ограничивать размер ответа. Их выигрыш Anthropic показывает в основном на графиках, без цифр в тексте. Числа есть только косвенные (72 vs 206 токенов, лимит 25 000 токенов).

### Cited Findings
- **Определения** (2024-12-19): «Workflows are systems where LLMs and tools are orchestrated through predefined code paths», агенты — системы, где «LLMs dynamically direct their own processes and tool usage» [V] — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Главное правило: «finding the simplest solution possible, and only increasing complexity when needed»; сложность добавлять, «only when it demonstrably improves outcomes» [V] — [там же](https://www.anthropic.com/engineering/building-effective-agents)
- Пять паттернов workflow и когда какой брать [V] — [там же](https://www.anthropic.com/engineering/building-effective-agents):
  - **prompt chaining** — задача «can be easily and cleanly decomposed into fixed subtasks», между шагами программные «gates»;
  - **routing** — классификация входа и передача специализированному обработчику;
  - **parallelization** — sectioning (независимые части) или voting (несколько прогонов одной задачи);
  - **orchestrator-workers** — когда «subtasks aren't pre-defined, but determined by the orchestrator»;
  - **evaluator-optimizer** — «one LLM call generates a response while another provides evaluation and feedback in a loop», если критерии оценки ясны.
- Агенту нужны условия остановки: «it's also common to include stopping conditions (such as a maximum number of iterations) to maintain control» [V] — [там же](https://www.anthropic.com/engineering/building-effective-agents)
- Про фреймворки: «Incorrect assumptions about what's under the hood are a common source of customer error» [V] — [там же](https://www.anthropic.com/engineering/building-effective-agents)
- **ACI-приложение, poka-yoke:** «Change the arguments so that it is harder to make mistakes». На SWE-bench модель путалась в относительных путях после смены каталога. Тул перевели на абсолютные пути, после чего «the model used this method flawlessly». Команда «spent more time optimizing our tools than the overall prompt» [V] — [там же](https://www.anthropic.com/engineering/building-effective-agents)
- **«Writing effective tools for agents — with agents»** (2025-09-11), правила [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents):
  - **Укрупнять.** Пример: один `schedule_event` вместо `list_users` + `list_events` + `create_event`. У каждого тула одна ясная цель.
  - **Неймспейсы** по сервису и ресурсу (`asana_search`, `asana_projects_search`). Префикс или суффикс влияет на результат, и это нужно проверять на своей модели.
  - **Осмысленный контекст:** `name`, `file_type` вместо `uuid`, `mime_type`. Человекочитаемые идентификаторы снижают галлюцинации.
  - **Параметр `response_format`** (`concise`/`detailed`). В примере короткий ответ занял 72 токена против 206.
  - **Экономия токенов:** пагинация, фильтры, диапазоны, усечение с разумными дефолтами. Цитата: «For Claude Code, we restrict tool responses to 25,000 tokens by default».
  - **Усечение и ошибки:** при усечении подсказывать более эффективную стратегию; ошибки делать конкретными и с указанием, что исправить, а не голым кодом или трейсбеком.
  - **Описания** писать «как для нового сотрудника», параметры называть однозначно (`user_id`, а не `user`). Пример: Claude дописывал «2025» к поисковым запросам, пока не исправили описание тула.
- Измеренный выигрыш в статье про тулы. Sonnet 3.5 вышел на SOTA SWE-bench Verified после доработки описаний тулов, но процентов в тексте нет. На held-out наборах для внутренних Slack- и Asana-MCP версии тулов, оптимизированные Claude, обошли написанные людьми, но цифры только на графиках [U: числа в тексте не приведены] — [там же](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Расхождение во времени: в 2025-09 у Claude Code было 25 000 токенов на ответ тула, по текущим докам Claude Code — 30K inline, сверх лимита файл + превью 2K (досье 02, ADR-5) [V] — [writing-tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
- **НОВОЕ. Длинные прогоны, «Effective harnesses for long-running agents»** (2025-11-26) [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents):
  - Три сбоя: попытка «one-shot the app»; поздний экземпляр видит прогресс и «declare the job done»; сессия начинается с «a feature half-implemented and undocumented».
  - Лечение структурой. Initializer-агент пишет JSON-список из «over 200 features» со статусом failing. Дальше каждая сессия делает по одной фиче, ведёт `claude-progress.txt` и коммитит в git.
  - Правило в промпте: «It is unacceptable to remove or edit tests».
  - JSON выбрали, потому что «the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files».
  - End-to-end проверку Claude делал хорошо, только когда его явно просили использовать браузерную автоматизацию.

### Inferences
- Наш пайплайн с известными шагами по классификации Anthropic — prompt chaining + routing + evaluator-optimizer с программными gates. Свободный агентный цикл нужен только внутри отдельного шага (например, «починить парсер»), и то с бюджетом.
- Наблюдение «агент сам выясняет, как вызвать модель-судью, и сам собирает сравнительную таблицу» прямо противоречит правилу укрупнения. Это должны быть тулы уровня задачи: `judge(candidates, rubric) → {verdict, scores, rationale}` и `build_comparison(items, columns) → path`. Модели нужно передавать короткий осмысленный результат (`response_format=concise`), а не давать ей собирать его из bash.
- Poka-yoke для наших тулов: абсолютные пути, enum вместо свободной строки, обязательные поля вместо «умных» дефолтов. Для статусов шагов — JSON-файл состояния, в котором модель может менять только поле `status`.

### Gaps
- Точных цифр выигрыша от консолидации и неймспейсов у Anthropic нет: только графики Slack/Asana без значений в тексте.
- Не нашёл, как Anthropic отдельно измеряла эффект `response_format` на успех задачи, а не на токены.

---

## 2. SWE-agent ACI (2024): как высокоуровневые команды и guardrails меняли успех; mini-swe-agent (2025) и контраргумент «bash хватает»

### Takeaway
В SWE-agent на GPT-4 Turbo интерфейс решал больше, чем промпт. Агент только с shell решал 11.0% задач против 18.0% у полного ACI. Отказ от lint-гарда на правке стоил −3.0 п.п., отсутствие edit-команды — −7.7 п.п. Для сильных моделей 2025–2026 годов bash-only (mini-swe-agent, >74% на Verified) почти не проигрывает. Для слабых свежие данные (досье 08, C4) по-прежнему показывают выигрыш от готовых тулов.

### Cited Findings
- Даты SWE-agent: v1 2024-05-06, v2 2024-05-30, v3 2024-11-11. Abstract: pass@1 12.5% на SWE-bench и 87.7% на HumanEvalFix, «far exceeding the previous state-of-the-art achieved with non-interactive LMs» [V] — [arXiv 2405.15793](https://arxiv.org/abs/2405.15793)
- **НОВОЕ (точные цифры абляций), SWE-bench Lite, GPT-4 Turbo.** Полный ACI = 18.00% (54/300): summarized search, просмотрщик на 100 строк, lint на правке, в истории последние 5 наблюдений. Таблица абляций [V] — [arXiv 2405.15793v3 (HTML)](https://arxiv.org/html/2405.15793v3):

  | Абляция | Решено | Δ к полному ACI |
  |---|---|---|
  | Edit без linting | 15.0% | −3.0 |
  | Без edit-команды | 10.3% | −7.7 |
  | Iterative search | 12.0% | −6.0 |
  | Без поисковых тулов | 15.7% | −2.3 |
  | Просмотрщик на 30 строк | 14.3% | −3.7 |
  | Просмотр всего файла | 12.7% | −5.3 |
  | Полная история вместо последних 5 наблюдений | 15.0% | −3.0 |
  | Без демонстрации | 16.3% | −1.7 |

- Базовые линии [V] — [там же](https://arxiv.org/html/2405.15793v3):
  - shell-only GPT-4 Turbo: 11.00% на Lite ($1.46); без демонстрации 7.33% ($0.79);
  - RAG GPT-4 Turbo: 1.31% на full ($0.13) и 2.67% на Lite;
  - RAG Claude 3 Opus: 3.79% на full и 4.33% на Lite ($0.25);
  - SWE-agent GPT-4 Turbo: 12.47% на full ($1.59) и 18.00% на Lite ($1.67);
  - SWE-agent Claude 3 Opus: 10.46% на full ($2.59) и 13.00% на Lite ($2.18).
- **НОВОЕ. Правки и восстановление** [V; одна цифра искажена в копии] — [там же](https://arxiv.org/html/2405.15793v3):
  - у 51.7% траекторий GPT-4 Turbo хотя бы одна правка провалилась (абсолютное число в копии искажено);
  - правка в итоге проходит в 90.5% случаев, а после одной неудачной — только в 57.2%.
- **НОВОЕ. Бюджет и длина траектории** [V] — [там же](https://arxiv.org/html/2405.15793v3):
  - лимит «we set the per-instance budget to $4»; при превышении накопленные правки отправляются автоматически;
  - успешные прогоны: медиана $1.21 и 12 шагов; неуспешные: в среднем $2.52 и 21 шаг;
  - 93.0% решённых задач отправлены до исчерпания бюджета, среди всех задач — 69.0%.
- **mini-swe-agent** [V] — [GitHub SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent):
  - «Just some 100 lines of python for the agent class»; «Does not have any tools other than bash»; «doesn't even need to use the tool-calling interface»;
  - каждое действие — отдельный `subprocess.run`, без stateful shell; результат «scores >74%» на SWE-bench Verified;
  - тезис: «as LMs have become more capable, a lot of this is not needed at all».
- Лимиты mini-swe-agent в коде (@04d809c, 2026-09-03): в классе агента `step_limit: int = 0` (без лимита) и `cost_limit: float = 3.0`; в `config/default.yaml` `step_limit: 0`, `cost_limit: 0.`. Проверка лимитов: `if 0 < step_limit <= n_calls or 0 < cost_limit <= cost`. Интерактивный агент при превышении спрашивает новые лимиты у человека [V, код] — [mini-swe-agent default.py](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py)
- Уже в досье, не дублирую:
  - DeepSeek V4.1-Flash: mini-SWE 74.2 против Claude Code 69.8 на DeepSWE (07);
  - 2609.20804: для 30B готовые тулы дают +15.0 п.п. на SWE-Bench, для 550B bash-only лучше на +3.6, а стоимость ниже на 53% (08, C4);
  - пилот mini-swe-agent против нативных CLI на n=10 (08, A1).

### Inferences
- Абляции SWE-agent прямо показывают, что делать нашим тулам:
  - выдача короткая и сжатая (summarized search лучше iterative на 6 п.п.);
  - окно просмотра ограничено (весь файл стоил −5.3 п.п.);
  - правки защищены линтером (−3.0 п.п. без него);
  - история сжата (полная история −3.0 п.п.).
  Для дешёвых моделей 2026 года это по-прежнему релевантно, для фронтира — меньше.
- 57.2% после первой неудачной правки против 90.5% в среднем — эмпирическое основание для правила «после N провалов смени стратегию или эскалируй» (ADR-4 «2 провала → write», ADR-3 loop-guard).
- Разрыв в длине траекторий (неуспех ≈ 21 шаг, успех ≈ 12) поддерживает бюджет шагов **на этап**: если этап вышел за 2× медианы успешного прогона, считать его вероятным провалом и эскалировать, а не ждать.
- Контраргумент mini-swe-agent относится к сильным моделям на SWE-bench-подобных задачах. У нас дешёвые модели и неинженерные рутинные шаги (судья, сравнения), и там выигрыш от высокоуровневых тулов ожидаемо выше.

### Gaps
- Свежих (2025–2026) повторений абляции ACI на дешёвых открытых моделях с lint-гардом не нашёл. В досье 08 (C7) это помечено как «не измерено в 2026».
- Точный процент mini-swe-agent и модель, на которой он получен, на странице README не указаны («>74%»).

---

## 3. Детерминированные пайплайны с LLM-шагами в продакшене: когда хардкодить шаги

### Takeaway
OpenAI и Anthropic сходятся: если критерии «агентности» (суждение, неподдерживаемые правила, неструктурированные данные) не выполнены, «a deterministic solution may suffice». Начинать нужно с одного агента. Рантаймы (LangGraph, Temporal, Claude Code workflows) дают ретраи на уровне узла/activity, таймауты, в том числе «без прогресса», и детерминированный replay. Это и есть место для известных заранее шагов.

### Cited Findings
- **OpenAI «A practical guide to building agents»** (метаданные PDF: CreationDate 2025-04-07) [V] — [cdn.openai.com PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf):
  - **Когда агент оправдан.** Три критерия: сложное принятие решений, «Difficult-to-maintain rules», «Heavy reliance on unstructured data». Иначе: «Before committing to building an agent, validate that your use case can meet these criteria clearly. Otherwise, a deterministic solution may suffice».
  - **Цикл run.** «lets agents operate until an exit condition is reached. Common exit conditions include tool calls, a certain structured output, errors, or reaching a maximum number of turns».
  - **Один агент сначала.** «maximize a single agent's capabilities first… often a single agent with tools is sufficient».
  - **Перегрузка тулами.** «The issue isn't solely the number of tools, but their similarity or overlap. Some implementations successfully manage more than 15 well-defined, distinct tools while others struggle with fewer than 10 overlapping tools».
  - **Модели.** Прототип строить на самой сильной модели, чтобы получить базовый уровень, затем «try swapping in smaller models to see if they still achieve acceptable results».
  - **Человек.** Подключать при «Exceeding failure thresholds: Set limits on agent retries or actions… escalate to human intervention» и при «High-risk actions».
  - **Графовые фреймворки.** Отмечено, что декларативные графы «can quickly become cumbersome… as workflows grow more dynamic».
- **НОВОЕ. LangGraph** (текущий `main`, на PyPI версия 1.2.17) [V, код] — [langgraph/types.py](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/types.py), [_internal/_config.py](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/_internal/_config.py):
  - `RetryPolicy` на узел, дефолты: `initial_interval=0.5`, `backoff_factor=2.0`, `max_interval=128.0`, `max_attempts=3` (включая первую попытку), `jitter=True`, `retry_on=default_retry_on`.
  - `TimeoutPolicy` на попытку узла: `run_timeout` — «Hard wall-clock cap… never refreshed by progress signals»; `idle_timeout` — «Maximum time… a single node attempt may go without observable progress»; обновляется на событиях графа или на `runtime.heartbeat()`.
  - `DEFAULT_RECURSION_LIMIT` = `"10007"` (через env `LANGGRAPH_DEFAULT_RECURSION_LIMIT`). Исторически дефолт был 25 [K], то есть лимит суперстепов по умолчанию фактически снят.
- **НОВОЕ. Temporal, дефолтная retry-политика Activity** [V] — [docs.temporal.io/encyclopedia/retry-policies](https://docs.temporal.io/encyclopedia/retry-policies):
  - Initial Interval 1 s, Backoff Coefficient 2.0, Maximum Interval = 100 × Initial (100 s), Maximum Attempts — без лимита, Non-Retryable Errors — пусто;
  - общую длительность ретраев рекомендуется ограничивать через Schedule-To-Close, а не через Maximum Attempts.
- Claude Code dynamic workflows (2026-06-02). Модель пишет JS-скрипт с `agent()`/`parallel()`/`pipeline()`, промежуточные результаты живут в переменных скрипта, replay детерминированный. Мотив — «Agentic laziness… Self-preferential bias… Goal drift». Подробно в досье 02 [V в досье 02] — [claude.dev](https://claude.dev/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code/)
- Структура против свободы на длинных задачах. У Anthropic (2025-11-26) решающим оказалось «incremental approach… one feature at a time» плюс внешний JSON-файл состояния [V] — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Inngest (step-функции с ретраями) и Temporal-интеграции агентных SDK в этой сессии не открывал (см. Gaps).

### Inferences
- Для нашего пайплайна по умолчанию это **оркестратор в коде**: список шагов → для каждого шага LLM-вызов или ограниченный агентный подцикл → программный gate (схема, тесты, скрипт-проверка) → переход. Агент не решает, какой шаг следующий: это делает код.
- Каждому шагу задать политику как у LangGraph/Temporal: `max_attempts`, backoff, `run_timeout` и, главное, `idle_timeout` — «нет наблюдаемого прогресса N минут». Под прогрессом понимать изменение артефакта или прогон проверки, а не просто токены. Это закрывает кейс «50 минут правок без перезапуска проверки».
- Дефолты 2026 года у зрелых рантаймов (LangGraph 10007, Temporal — без лимита попыток, OpenHands 500 итераций, Kimi CLI 1000 шагов) почти снимают глобальные лимиты. Реальный контроль переносится на таймауты и бюджеты конкретного шага плюс детекторы застревания, а не на общий кап шагов.

### Gaps
- Не проверял Inngest AgentKit и Temporal + OpenAI Agents SDK: дефолты ретраев и примеры «durable agent» остались непрочитанными.
- Опубликованных измерений «workflow против свободного агента» на одной и той же задаче (pass rate / стоимость) в этой сессии не нашёл. Есть только принципы и кейсы.

---

## 4. Детекция петель и застревания; бюджеты на шаг; что происходит при превышении

### Takeaway
Зрелые харнессы ловят три класса петель:
1. идентичные вызовы подряд (Roo: 3; Gemini/Qwen: 5; OpenHands: 3–4);
2. циклы длиной 2–5 (Gemini) и чередование (OpenHands: 6);
3. «семантическое» топтание на месте — LLM-проверка (Gemini: после 30 ходов, каждые 5–15 ходов, порог 0.9).

Петли «правлю, но не проверяю» никто из них детерминированно не ловит. При срабатывании почти все останавливают ход и отдают управление человеку. Автоэскалацию к более сильной модели в открытых харнессах не нашёл; в исследованиях она есть (step-level cascade, 2026).

### Cited Findings
- **НОВОЕ. Gemini CLI `loopDetectionService.ts`** (main, прочитан 2026-10-24) [V, код] — [gemini-cli](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/loopDetectionService.ts):
  - **Петля вызовов.** `TOOL_CALL_LOOP_THRESHOLD = 5`; проверяются циклы длиной k = 1…5, для каждого нужно k × 5 совпадений; окно — 25 записей.
  - **«Chanting» в тексте.** `CONTENT_CHUNK_SIZE = 50` символов, `CONTENT_LOOP_THRESHOLD = 10` повторов, средняя дистанция ≤ 250 символов. Код-блоки, таблицы, списки и заголовки исключаются или сбрасывают счётчик.
  - **LLM-проверка.** `LLM_CHECK_AFTER_TURNS = 30`; интервал от 5 до 15 ходов (по умолчанию 10), считается как `round(5 + 10 × (1 − confidence))`; модели передаются последние 20 записей; порог `LLM_CONFIDENCE_THRESHOLD = 0.9`. Отдельная модель `loop-detection-double-check` перепроверяет результат, если первая уверена на ≥ 0.9.
  - **При срабатывании** сервис сам ничего не прерывает: он логирует `LoopDetectedEvent`, а решение принимает вызывающий код. `clearDetection()` позволяет сделать recovery-ход, при этом счётчик срабатываний сохраняется.
- Qwen Code (форк Gemini CLI, @013b805, 2026-10-22): тот же `TOOL_CALL_LOOP_THRESHOLD = 5`, есть `maxSessionTurns` [V, код] — [qwen-code](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/loopDetectionService.ts)
- **НОВОЕ. Roo Code** [V, код] — [ToolRepetitionDetector.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/tools/ToolRepetitionDetector.ts), [provider-settings.ts](https://github.com/RooCodeInc/Roo-Code/blob/main/packages/types/src/provider-settings.ts):
  - `DEFAULT_CONSECUTIVE_MISTAKE_LIMIT = 3`, настраивается через `consecutiveMistakeLimit`, 0 = без лимита.
  - `ToolRepetitionDetector(limit = 3)` сравнивает канонический JSON вызова с отсортированными ключами. При достижении лимита: `allowExecution: false` + `askUser` с ключом `mistake_limit_reached`. Счётчик сбрасывается, «to allow recovery if user guides the AI past this point».
  - В update-notes упоминается настройка «Error & Repetition Limit» с возможностью полностью отключить диалоги «Roo is having trouble» [U: версия заметки не подтверждена] — [docs.roocode.com](https://docs.roocode.com/update-notes/v3.11.9)
- **OpenHands SDK** (@df393e3, 2026-10-22) [V, код]:
  - пороги StuckDetector 4/3/3/6 + петля ошибок context window — в досье 08, A4;
  - **НОВОЕ:** `max_iterations` по умолчанию 500 (`settings/model.py`), `max_iteration_per_run=500` (`conversation.py`);
  - при срабатывании детектора `execution_status = ConversationExecutionStatus.STUCK`, и цикл run останавливается (`local_conversation.py:770–787`) — [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)
- **НОВОЕ. Kimi CLI** (@9ab1286, 2026-09-22): `max_steps_per_turn` по умолчанию 1000, `max_retries_per_step` 3, `max_ralph_iterations` 0 (−1 = без лимита) [V, код] — [kimi-cli config.py](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/config.py)
- Сводка лимитов из досье: Claude Code SDK — `maxTurns` и `maxBudgetUsd`, Stop-хуки с капом 8 (02); у Codex лимита шагов нет (03); у Hermes `max_turns: None`, потому что «caps caused silent mid-task truncation» (05); Cline — mistake limit 3 → остановка и вопрос пользователю, loop-детектор сделан output-aware (08, A4); OpenCode — permission `doom_loop` (08).
- SWE-agent (2024): денежный бюджет $4 на задачу, при превышении автоматически отправляется накопленный патч [V] — [arXiv 2405.15793v3](https://arxiv.org/html/2405.15793v3)
- **НОВОЕ. Step-level cascade для computer-use агентов** (2026-04-29). По умолчанию работает дешёвая политика, к сильной модели эскалируют лёгкие обученные мониторы:
  - **Stuck Monitor** — деградация прогресса по недавней истории рассуждений и действий;
  - **Milestone Monitor** — смысловые чекпоинты для редкой проверки дрейфа («silent semantic drift»).
  Цифр в abstract нет; поисковая выдача приписывает работе «61.4% cost reduction» [U] — [arXiv 2604.27151](https://arxiv.org/abs/2604.27151)
- OpenAI guide: при «Exceeding failure thresholds» — эскалация к человеку [V] — [PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)

### Inferences
- Детектор для нашего loop-guard, взяв лучшее у каждого:
  - fingerprint (tool, канонический JSON аргументов), лимит 3 (Roo/OpenHands);
  - циклы длиной 2–5 (Gemini);
  - учёт хэша вывода, чтобы не убивать polling (Cline);
  - дешёвая LLM-проверка «есть ли прогресс» после 30 ходов с адаптивным интервалом (Gemini).
- Ни один из перечисленных детекторов не поймал бы наш кейс «50 минут правок парсера без перезапуска проверки»: вызовы разные, текст не повторяется. Нужен отдельный **детектор «правок без проверки»**: N подряд write/edit по одному артефакту без запуска проверочной команды шага → блок следующей правки (не просто подсказка), пока не будет запущена проверка. Это прямой аналог ECLoop (раздел 7).
- Действия при превышении — лестница, а не просто стоп:
  1. разовая подсказка;
  2. блок действия на уровне тула;
  3. эскалация к сильной модели с брифом (досье 08, I3);
  4. стоп со статусом и передача человеку.
  Готовый «шаг 3» в открытых харнессах не найден — это наш код.

### Gaps
- Публичных измерений false positive / false negative для StuckDetector OpenHands и детектора Gemini CLI не нашёл, кроме кейса Cline с polling (08).
- Не открывал полный текст 2604.27151: точные цифры экономии и пороги мониторов не подтверждены.

---

## 5. Надёжность поставщиков: ретраи, фолбэки, таймауты на первый токен, hedging, опубликованные доли ошибок

### Takeaway
Шлюзы дают три независимых механизма:
1. ретраи с backoff по типу ошибки;
2. failover на другого поставщика той же модели, включая быстрый — по таймауту до первого чанка;
3. fallback на другую модель списком.

Опубликованные доли ошибок на один запрос у поставщиков одной открытой модели — от 0% до 14.8% (бенчмарк 2026-09). На длинном прогоне из сотен вызовов без ретраев это гарантированные потери ходов. В Pi 1.4 ретраи есть, но таймаут простоя по умолчанию 5 минут, и регэксп «повторяемых» ошибок может не совпасть с текстом ошибок шлюза.

### Cited Findings
- **НОВОЕ. LiteLLM Router** [V] — [docs.litellm.ai/docs/routing](https://docs.litellm.ai/docs/routing):
  - **Ретраи:** `num_retries`; приоритет — заголовок `x-litellm-num-retries` > тело запроса > `litellm_params` деплоя > `litellm_settings`. RateLimitError повторяется с экспоненциальным backoff, остальные ошибки — сразу.
  - **`RetryPolicy` по типу исключения:** `TimeoutErrorRetries`, `RateLimitErrorRetries`, `InternalServerErrorRetries`, `ServiceUnavailableErrorRetries`, `BadRequestErrorRetries`, `ContentPolicyViolationErrorRetries` и др.
  - **Cooldown:** деплой выводится из ротации после `allowed_fails` = 3 (дефолт) на `cooldown_time` = 5 s (дефолт). Есть `AllowedFailsPolicy` по типам ошибок.
  - **Фолбэки:** `fallbacks`, `context_window_fallbacks`, `content_policy_fallbacks`, `default_fallbacks`; `max_fallbacks` = 5.
  - **Маршрутизация:** по умолчанию `simple-shuffle` («Default and Recommended for Production»), также `least-busy`, `latency-based-routing`, `cost-based-routing`.
  - **Pre-call checks** отсеивают деплои с недостаточным окном контекста.
  - Hedging на странице не упоминается.
- **НОВОЕ. OpenRouter, выбор поставщика** [V] — [openrouter.ai/docs/…/provider-selection](https://openrouter.ai/docs/guides/routing/provider-selection):
  - **По умолчанию:** сначала поставщики без «significant outages in the last 30 seconds»; среди них выбор по цене с весом обратного квадрата цены (поставщик за $1 в 9 раз вероятнее поставщика за $3); остальные — фолбэки.
  - **Поля:** `order`, `allow_fallbacks` (по умолчанию `true`), `sort` (`price`/`throughput`/`latency`), `only`, `ignore`, `quantizations`, `max_price`, `require_parameters` (по умолчанию `false`), `data_collection`.
  - **Пороги производительности:** `preferred_min_throughput` и `preferred_max_latency` по p50/p75/p90/p99 в окне 5 минут. Тех, кто не проходит, переносят в конец списка, но не исключают.
- **НОВОЕ. OpenRouter, фолбэк моделей** [V] — [openrouter.ai/docs/…/model-fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks):
  - массив `models` перебирается по порядку при любой ошибке: длина контекста, модерация, rate limit, недоступность;
  - оплата — по модели, которая фактически ответила; поле `model` в ответе показывает, кто ответил.
- **НОВОЕ. Vercel AI Gateway** [V] — [provider-options (2026-10-02)](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options), [provider-timeouts (2026-09-10)](https://vercel.com/docs/ai-gateway/models-and-providers/provider-timeouts):
  - по умолчанию поставщик выбирается «based on a combination of recent uptime and latency»; доступны `order`, `only`, `sort` (`cost`/`ttft`/`tps`);
  - `sessionAffinity` (по умолчанию `true`) держит разговор на поставщике, у которого лежит его prompt-кэш;
  - `providerTimeouts` от 1 000 до 789 000 мс: «For streaming requests, AI Gateway clears the timeout when it receives the first stream chunk», то есть это **таймаут до первого чанка**, после которого идёт failover на следующего поставщика. Только для BYOK; «you may still be charged for timed-out requests»;
  - в метаданных ответа `providerAttempts` с `error: "PROVIDER_TIMEOUT"` и `configuredTimeoutMs`.
- **НОВОЕ. Доли ошибок поставщиков одной модели.** Openbenchmarks (2026-09-03): GLM 5.3 Flash, 10 хостов, 600 запросов на каждого, таймаут 20 s, одна попытка, конкурентность 1. Сайт с неизвестным оператором, сырые записи выложены на GitHub [U] — [openbenchmarks.com](https://openbenchmarks.com/inference/most-accurate-llm-api-provider):

  | Поставщик | Доля операционных ошибок |
  |---|---|
  | Fireworks AI, Telnyx, Modal, Baseten | 0.0% |
  | Z.AI | 0.2% |
  | Together AI | 1.0% |
  | Parasail | 1.3% |
  | DeepInfra | 4.0% (транспортные ошибки 3.7%) |
  | Novita AI | 4.0% (HTTP 429 3.8%) |
  | Nebius | 14.8% (прочие 4xx/5xx 11.5%, таймауты 2.8%) |

- Практик о 10 000 вызовов: таймауты 2–5%, 429 — 1–3%, нарушения схемы 1–4%, итого 5–15% провалов с первой попытки; поставщики не названы [U] — [dev.to](https://dev.to/correctover/llm-api-reliability-in-production-what-10000-calls-taught-us-about-failure-patterns-1pg8)
- Уже в досье: Kimi K3 под Pi — 25 из 62 прогонов оборваны ошибками стрима; Cline — 5 провалов из-за 429 OpenRouter исчезли после backoff; GLM-5.2 74.2% у CoreWeave против 61.8% через OpenRouter (08, A3 и D).
- **НОВОЕ. Что умеет Pi 1.4.0** (установленный пакет, `docs/settings.md`, `dist`) [V, код] — [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent):
  - **Ретраи:** `retry.enabled: true`, `retry.maxRetries: 3`, `retry.baseDelayMs: 2000` (2 → 4 → 8 s), `retry.maxAgentDelayMs: 60000`; ретраи провайдер-уровня `retry.provider.maxRetries: 0`.
  - **Таймаут:** `httpIdleTimeoutMs: 300000`, то есть 5 минут простоя заголовков/тела до ошибки; `retry.provider.timeoutMs` по умолчанию равен ему.
  - **Условие ретрая:** только при `stopReason === "error"` и совпадении `RETRYABLE_PROVIDER_ERROR_PATTERN`. В него входят `timed? out`, `timeout`, `429|500|502|503|504|520|524`, `stream was interrupted`, `upstream_stream_read_error`, `socket hang up` и др. HTTP 408 и 499 в списке нет.
  - **Исключения:** `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` (`billing`, `quota exceeded`, `insufficient_quota`, `available balance`…) ретрай запрещает, и он проверяется первым.
- Hedging. Классика — Dean & Barroso, «The Tail at Scale» (CACM, 2013-02): hedged-запрос после короткой задержки снизил p99.9 с 1 800 мс до 74 мс ценой примерно 2% лишних запросов [K] — [CACM](https://cacm.acm.org/research/the-tail-at-scale/). Для LLM API есть только блоги и README библиотек: «75–96% снижения P99 при 5–10% накладных» со ссылкой на ту же работу [U] — [crucible_hedging README](https://readme.hex.pm/crucible_hedging/0.4.1). Ни LiteLLM, ни OpenRouter, ни Vercel в прочитанных доках hedging не предлагают [V, по отсутствию].

### Inferences
- «Потерянные ходы на таймаутах без ретрая» в Pi 1.4 вероятнее всего объясняются одной из трёх причин:
  1. текст ошибки a6api не совпадает с регэкспом: например 408/499, нестандартная формулировка, ошибка внутри HTTP 200 или пустой ответ без `stopReason: error`;
  2. сообщение содержит слово из non-retryable-списка (например `billing`);
  3. зависший стрим ждёт полные 5 минут `httpIdleTimeoutMs`, прежде чем вообще станет ошибкой.
  Это гипотезы: нужно собрать реальные тексты ошибок шлюза и сверить их с регэкспом.
- Минимальный слой надёжности:
  - **таймаут до первого токена** (как `providerTimeouts` у Vercel, 10–30 s в зависимости от модели) отдельно от idle-таймаута между чанками (30–60 s) и от общего таймаута хода;
  - ретраи по классам ошибок (как `RetryPolicy` LiteLLM);
  - failover на другого поставщика **той же модели** внутри шлюза, с привязкой к сессии ради кэша (как `sessionAffinity` у Vercel);
  - смену **модели** — только на границе шага (ADR-8).
- Hedging для агентных ходов дорог: дублирование длинного префикса без кэша оплачивается дважды. Разумно применять его только на коротких запросах без кэша (судья, классификатор) и только по таймауту TTFT.

### Gaps
- Не нашёл публичной статистики именно по a6api.com и по доле ошибок на **агентный прогон** (а не на запрос) у какого-либо маркетплейса.
- Цифры ModelUptime (99.28% средний uptime, 177 инцидентов в мае 2026) пришли только из поисковой выдачи — не проверены, в выводах не использую.
- Цифры «The Tail at Scale» взяты по памяти, в этой сессии не перепроверены.

---

## 6. Лестницы эскалации: дешёвая модель первой, сильная при провале (каскады, FrugalGPT-подобные схемы, маршрутизация 2024–2026)

### Takeaway
Классические каскады дают большую экономию на одиночных запросах (FrugalGPT: до 98%; RouteLLM: «over 2 times»). Свежий анализ 2026 года показывает, что выгода — в двух уровнях, а третий и далее почти ничего не добавляет: 118 из 135 сравнений без прироста. Для агентов каскад работает на уровне шага с мониторами застревания. Ключевое условие — сигнал эскалации должен разделять «верно/неверно» именно для текущей модели.

### Cited Findings
- **FrugalGPT** (2023-05-09): «match the performance of the best individual LLM (e.g. GPT-4) with up to 98% cost reduction» или «improve the accuracy over GPT-4 by 4% with the same cost» [V] — [arXiv 2305.05176](https://arxiv.org/abs/2305.05176)
- **RouteLLM** (v1 2024-06-26, v4 2025-02-23): «reduces costs—by over 2 times in certain cases—without compromising the quality» [V] — [arXiv 2406.18665](https://arxiv.org/abs/2406.18665). Цифры по бенчмаркам (≈85% экономии на MT Bench, 45% на MMLU, 35% на GSM8K при 95% качества GPT-4) взяты из блога LMSYS 2024-07 [K] — [lmsys.org](https://lmsys.org/blog/2024-07-01-routellm/)
- **НОВОЕ. «Is Escalation Worth It? On the Depth of LLM Cascades»** (v1 2026-05-07, v2 2026-10-05) [V] — [arXiv 2605.06350](https://arxiv.org/abs/2605.06350):
  - двухмодельный каскад дал +2.1…+8.2 п.п. средней точности против выбора одной модели (5 бенчмарков, 9 deferral-скоров, пул из 8 моделей);
  - более двух моделей не улучшили среднюю точность в 118 из 135 сравнений, максимум +0.43 п.п.;
  - эскалация окупается, когда скор уверенности «separates correct from incorrect answers for the current model better than it does for later models». Если скор отражает общую сложность запроса, выигрыш от глубины пропадает.
- **НОВОЕ. Step-level cascade для агентов** (2026-04-29): дешёвая политика по умолчанию, эскалация по Stuck/Milestone-мониторам; цифры экономии не подтверждены [U] — [arXiv 2604.27151](https://arxiv.org/abs/2604.27151)
- C3PO (2025-11): самообучаемая оптимизация каскада при вероятностных ограничениях стоимости; abstract не открывал [U] — [arXiv 2511.07396](https://arxiv.org/pdf/2511.07396)
- Уже в досье (не дублирую):
  - Fusion: премиум-лид + исполнитель — $1.35 / 63.1 против $3.51 / 63.6;
  - «smart friend» работает, только если primary умеет эскалировать;
  - cache-blind переключение стоит 2.1–2.4× от «всё на флагмане», cache-aware — 0.19–0.28× (Factory, 2026-08) (08, I1–I3; ADR-8).
- OpenAI guide: «build your agent prototype with the most capable model… then try swapping in smaller models» — обратный порядок: сверху вниз при разработке, а не в рантайме [V] — [PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)

### Inferences
- Для пайплайна с известными шагами: **двухуровневая лестница на шаг** (дешёвая → сильная), третий уровень — человек. Глубже не строить: 118/135 против.
- Сигналы эскалации — детерминированные и специфичные для текущей модели: провал программного gate шага, срабатывание loop-guard или детектора «правок без проверки», выход за бюджет шага, ошибка схемы после ремонта. Самооценку дешёвой модели не использовать: досье 08 (I3) — слабая модель плохо понимает, когда звать.
- Эскалировать на границе шага с брифом (вход шага + что пробовали + вывод проверки), а не продолжать ту же историю на другой модели. Так не ломается кэш (ADR-8), и сильная модель не получает «заражённую» историю.
- Прецедент из разработки (OpenAI): сначала прогнать пайплайн на сильной модели, получить эталон по каждому шагу, затем понижать модель пошагово. Это и есть способ найти, какие шаги можно отдать дешёвой модели.

### Gaps
- Не нашёл работ 2025–2026 с каскадом «дешёвая → сильная» на SWE-bench-подобных агентных задачах с опубликованной экономией в $. Поиск дал только общие каскады и computer-use.
- Цифры RouteLLM по бенчмаркам взяты по памяти и не перепроверены.

---

## 7. Принуждение в коде против правил в промпте: хуки, permission-слои и доказательства нарушения промпт-правил

### Takeaway
Вендоры прямо позиционируют хуки как «deterministic control… rather than relying on the LLM». Исследования 2025–2026 показывают:
- правила в длинных агентных инструкциях соблюдаются плохо (AgentIF: в среднем 11.9 ограничений на инструкцию; τ-bench: pass^8 < 25%);
- блок на уровне исполнения повышает и соблюдение (AgentLTL: 5 из 7 моделей), и успех задач (ECLoop: +4.8…+11.8 п.п. на SWE-bench Verified при −12.1% токенов).

Структурированные условия работают лучше эквивалентного текста.

### Cited Findings
- **НОВОЕ. Claude Code hooks guide:** «Claude Code runs them at specific points in its lifecycle, which gives you deterministic control: certain actions always happen rather than relying on the LLM to choose to run them». PreToolUse с exit 2 блокирует вызов, stderr уходит модели как обратная связь; при параллельных хуках «The deny takes precedence»; у `Stop`/`PostToolUse` есть `decision: "block"` [V] — [code.claude.com/docs/en/hooks-guide](https://code.claude.com/docs/en/hooks-guide)
- Уже в досье 02: «never»-правила в CLAUDE.md нарушаются «under pressure, in a long session… or due to a prompt injection» → хуки и permissions (claude.com, 2026-06-18).
- **НОВОЕ. Pi 1.4.0, пример `permission-gate.ts`:** `pi.on("tool_call", …)` возвращает `{ block: true, reason }` для `rm -rf`, `sudo`, `chmod/chown 777`. Без UI блокирует по умолчанию: «Dangerous command blocked (no UI for confirmation)». Рядом примеры `protected-paths.ts`, `confirm-destructive.ts`, `dirty-repo-guard.ts` [V, код] — [пакет @earendil-works/pi-coding-agent 1.4.0, examples/extensions](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- **НОВОЕ. ECLoop** (2026-07-30). «Premature commitment»: агенты «submit patches before examining enough repository evidence». Слой между агентом и репозиторием выводит условия-доказательства для каждого типа правки и сабмита и откладывает действие, пока условия не выполнены [V] — [arXiv 2607.28815](https://arxiv.org/abs/2607.28815):
  - все 500 задач SWE-bench Verified, 2 модели × 2 скаффолда: Pass@1 +4.8…+11.8 п.п. без переобучения;
  - токены до −12.1%;
  - структурированные условия лучше эквивалентного текстового резюме.
- **НОВОЕ. AgentLTL** (2026-07-01): «block-and-warn» на уровне харнесса «improves compliance on five of seven models»; дообучение с trace-reward даёт +38 п.п. точности и +17.5 п.п. соблюдения на отложенных паттернах. Базовые доли нарушений в abstract не приведены [V, только abstract] — [arXiv 2607.02599](https://arxiv.org/abs/2607.02599)
- **AgentSpec** (2025-03): DSL правил триггер → предикат → принуждение в рантайме. По пересказу выдачи — предотвращение небезопасных исполнений в «over 90%» случаев у code-агентов; правила, сгенерированные o1, — precision 95.56% и recall 70.96% [U: abstract не открыт] — [arXiv 2503.18666](https://arxiv.org/abs/2503.18666)
- **AgentIF** (2025-05-22): 707 инструкций из 50 агентных задач, средняя длина 1 723 слова (максимум 15 630), в среднем 11.9 ограничений; модели «generally perform poorly», особенно на сложных структурах ограничений и спецификациях тулов [V] — [arXiv 2505.16944](https://arxiv.org/abs/2505.16944)
- **τ-bench** (2024-06-17): агенты обязаны следовать доменным правилам; gpt-4o «succeed on <50% of the tasks», «pass^8 <25% in retail» [V] — [arXiv 2406.12045](https://arxiv.org/abs/2406.12045)
- OpenAI guide: «Think of guardrails as a layered defense mechanism»; детерминированные меры («blocklists, input length limits, regex filters»); рейтинг риска тулов (read/write, обратимость, финансовый эффект) запускает «pausing for guardrail checks before executing high-risk functions or escalating to a human» [V] — [PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
- Anthropic (2025-11-26): данные в JSON вместо Markdown, потому что модель реже «inappropriately change or overwrite» JSON. Это структурное принуждение без кода [V] — [Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Harness²: «инструкцию модель может пропустить, строку в результате тула — нет» (ADR-6, досье 06).

### Inferences
- Наше наблюдение «правила из промпта обходились, остановили только блоки в коде» совпадает со всеми источниками. Правило «одно правило — одна точка принуждения»:
  - инварианты (какие файлы трогать, какие команды запрещены, обязательный прогон проверки перед следующим шагом) — `tool_call`-хук Pi с `{block, reason}`;
  - `reason` формулировать как подсказку: что сделать вместо этого (так же, как stderr у exit 2 в Claude Code).
- Самое ценное для наших петель — не запреты, а **условия-доказательства в стиле ECLoop**:
  - «нельзя править артефакт шага ещё раз, пока после прошлой правки не запущена проверка шага»;
  - «нельзя завершить шаг, пока gate не зелёный».
  Это и есть блок для кейса «50 минут без перезапуска проверки», а по данным ECLoop он ещё и экономит токены.
- Состояние пайплайна (какие шаги пройдены, критерии) держать в JSON, который модель не может переписать целиком: только поле статуса через тул. По Anthropic это снижает «объявление победы», а по Roo/Gemini — даёт харнессу точку проверки.

### Gaps
- Не нашёл количественного бенчмарка «доля нарушений правил из системного промпта у дешёвых открытых моделей в длинных агентных прогонах» на 2026 год. AgentIF и τ-bench — на моделях 2024–2025 года.
- Полные тексты AgentLTL и AgentSpec не открывал: базовые доли нарушений без принуждения не подтверждены.
