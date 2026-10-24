# Скорость агентного харнеса на длинных задачах: меньше и быстрее вызовов модели (срез 2026-10-24)

Контекст: у нас 8 шагов, 230–680 последовательных вызовов по 16–38 с, обычно одно мелкое действие на вызов; 70–80% времени уходит на ожидание модели. **Что уже есть в репо и здесь не повторяется** (только ссылки): codemode в Pi, ~40% меньше prompt-токенов, QuickJS, параллельные tool calls по умолчанию, сериализация правок одного файла (`research/01-pi.md` §C, §A); Code Mode в Codex и issue #35050, «батчинг дал −27…−45% weighted usage» (`03-codex-openai.md` C3); статья 2607.10569, code_only −24.6%/−19.9%, но +14.4% на правках у Claude (`08-practitioners-research.md` C6); параллельные read-only тулы в Claude Code и Codex (`02`, `03`); экономика кэша DeepSeek (×50) и Claude Code ($11.20 → $1.62) (`00-synthesis.md` ADR-1); effort для дизайна: 28 мин на max против 1 мин на low (`13-design-pipeline.md` P9); DeepSeek V4.1 Flash — TTFT ~1 с, 206 ток/с (`10-model-roles.md`).
Метки: [V] — видел в первоисточнике; [U] — вторичный источник или пересказ поиска, по первоисточнику не проверял.

## 1. «Code mode»: модель пишет один скрипт, который вызывает много тулов

### Takeaway
Документированный эффект code mode — это экономия **токенов контекста** (37% у Anthropic на сложных задачах, 98.7–99.9% на огромных каталогах MCP/API) и **проходов инференса** («20+ вызовов в одном блоке = минус 19+ проходов»). Измеренных цифр **wall-clock** у Anthropic и Cloudflare нет. Обязательна песочница. На правках кода выигрыша нет (см. 08 C6).

### Cited Findings
- **Anthropic «Code execution with MCP» (2025-11-04)** [V]: тулы MCP показываются как файлы TS-API (`./servers/google-drive/getDocument.ts`); агент читает только нужные определения; фильтрует, агрегирует и джойнит данные в коде. Пример: «reduces the token usage from 150,000 tokens to 2,000 tokens» — «time and cost saving of 98.7%». На таблице в 10 000 строк агент «sees five rows instead of 10,000». Измерений латентности нет; есть только качественное утверждение, что условия и циклы, выполненные в песочнице, экономят «time to first token». — [Anthropic Engineering](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Риски по тому же посту [V]: нужна «secure execution environment with sandboxing, resource limits, and monitoring»; это «operational overhead and security considerations that direct tool calls avoid». PII можно токенизировать до того, как её увидит модель. — [Anthropic Engineering](https://www.anthropic.com/engineering/code-execution-with-mcp)
- **Anthropic «Advanced tool use» (2025-11-24), Programmatic Tool Calling** [V]:
  - «Average usage dropped from 43,588 to 27,297 tokens, a 37% reduction on complex research tasks»;
  - «When Claude orchestrates 20+ tool calls in a single code block, you eliminate 19+ inference passes»;
  - точность: внутренний knowledge retrieval 25.6% → 28.5%, GIA 46.5% → 51.2%;
  - пример бюджета: 200KB сырых данных → 1KB результата;
  - **когда не использовать**: «simple single-tool invocations», задачи, где «Claude should see and reason about all intermediate results», «quick lookups with small responses».
  — [Anthropic Engineering](https://www.anthropic.com/engineering/advanced-tool-use)
- Там же, смежное [V]:
  - Tool Search Tool — «85% reduction in token usage» (сохраняется 191,300 токенов контекста против 122,800); точность Opus 4: 49% → 74%, Opus 4.5: 79.5% → 88.1%;
  - Tool Use Examples: «72% to 90% on complex parameter handling».
  — [Anthropic Engineering](https://www.anthropic.com/engineering/advanced-tool-use)
- **Cloudflare «Code Mode: the better way to use MCP» (2025-09-26; Kenton Varda, Sunil Pai)** [V]:
  - тезис: «LLMs are better at writing code to call MCP, than at calling MCP directly»; tool-calling токены — синтетика в обучении, а TypeScript модели видели много;
  - в цепочках промежуточные результаты без кода проходят через модель и тратят «time, energy, and tokens»;
  - **численных замеров нет**;
  - песочница: новый V8-isolate на каждый сниппет, старт «in a handful of milliseconds using only a few megabytes of memory»; `fetch()`/`connect()` бросают ошибку; доступ только через bindings к подключённым MCP; ключи держит супервизор;
  - ограничение v1: весь сгенерированный TS-API лежит в контексте.
  — [Cloudflare blog](https://blog.cloudflare.com/code-mode/)
- **Cloudflare «Code Mode: give agents an entire API in 1,000 tokens» (2026-02-20)** [V по выдержкам поиска с blog.cloudflare.com + InfoQ 2026-04]:
  - два тула, `search()` и `execute()`, дают доступ ко всему API Cloudflare (2,500+ эндпоинтов) за ~1,000 токенов;
  - «An equivalent MCP server without Code Mode would consume 1.17 million tokens» (−99.9%, подсчёт tiktoken);
  - в том же посте встречается и «over 2 million tokens» — **внутреннее расхождение базовой цифры**;
  - `execute()` выполняет пагинацию, условия и цепочки вызовов «in a single cycle, cutting round-trip overhead»;
  - Glama намерил 1,069 токенов.
  — [Cloudflare blog](https://blog.cloudflare.com/code-mode-mcp/); [InfoQ](https://infoq.com/news/2026/04/cloudflare-code-mode-mcp-server); [Glama](https://glama.ai/mcp/servers/ubnx8r8i7p)
- **CodeAct, «Executable Code Actions Elicit Better LLM Agents» (ICML 2024; arXiv v1 2024-02-01)** [V]: на 17 LLM «up to 20% higher success rate» против JSON/текстовых действий (API-Bank + собственный бенчмарк). Сокращение числа действий в абстракте **не указано**. — [arXiv 2402.01030](https://arxiv.org/abs/2402.01030)
- **smolagents (Hugging Face)** [V]:
  - README: CodeAgent «uses 30% fewer steps (thus 30% fewer LLM calls)»; ссылка ведёт на CodeAct, в абстракте которого этой цифры нет, так что первоисточник 30% я не проверил;
  - безопасность: «The built-in `LocalPythonExecutor` is **not a security sandbox**… can be bypassed and must not be used as a security boundary»; песочницы — Blaxel, E2B, Modal, Docker;
  - в блоге 2024-12-31 бенчмарк CodeAgent против ToolCallingAgent есть только картинкой («code works better»), чисел в тексте нет.
  — [GitHub smolagents](https://github.com/huggingface/smolagents); [HF blog](https://huggingface.co/blog/smolagents)

### Inferences
- Для нашего пайплайна code mode полезен там, где есть **цепочки механических действий без суждения между ними**: прочитать N файлов, сгенерировать/скопировать ассеты, запустить сборку, снять скриншоты, проверить размеры. Каждая такая цепочка сейчас стоит N вызовов по 16–38 с. «Минус 19+ проходов» Anthropic — это ровно наш сценарий «один вызов = одно мелкое действие».
- Там, где модель должна увидеть результат перед следующим шагом (правки по визуальному ревью, исправление ошибок сборки), code mode не помогает: Anthropic сам ставит это в «когда не использовать», а 08 C6 показывает «edit friction».
- Codemode в Pi уже есть (QuickJS, без сети). Значит, эксперимент дешёвый; главный риск — сериализация вызовов слабыми моделями (Codex #35050, см. 03).

### Gaps
- Не нашёл ни одного первоисточника 2025–2026 с замером **wall-clock** code mode против прямых вызовов: только токены и число проходов.
- Не нашёл, как часто code-скрипт падает на середине с частичными побочными эффектами и что делать с откатом. Проверять на наших снапшотах (ADR-12).

## 2. Параллельные tool calls и параллельные субагенты

### Takeaway
«Up to 90%» у Anthropic подтверждено, но оно про **исследовательские** запросы (3–5 субагентов параллельно, у каждого 3+ тула параллельно) и стоит ×15 токенов против чата; про кодинг сам Anthropic пишет, что параллелизуемых задач там меньше. В кодинге параллельный поиск контекста даёт большой выигрыш (8 вызовов за ход, ≤4 хода вместо 10–20). Параллельные писатели дают до ×2.10 только при аккуратной нарезке по графу зависимостей.

### Cited Findings
- **Anthropic multi-agent research system (2025-06-13)** [V]:
  - «These changes cut research time by up to 90% for complex queries». Это принцип 8 «Parallel tool calling transforms speed and performance»; две причины: «the lead agent spins up 3-5 subagents in parallel rather than serially» и «the subagents use 3+ tools in parallel»;
  - качество: «outperformed single-agent Claude Opus 4 by 90.2%» (лид Opus 4, субагенты Sonnet 4);
  - цена: «agents typically use about 4× more tokens than chat», «multi-agent systems use about 15× more tokens than chats»; «token usage by itself explains 80% of the variance» (BrowseComp);
  - ограничения: плохо подходит, когда агентам нужен общий контекст или много зависимостей; «most coding tasks involve fewer truly parallelizable tasks than research».
  — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Cognition SWE-grep / SWE-grep-mini (Windsurf Fast Context; 2025-10)** [V по выдержкам; дату на странице не проверял]:
  - «agent trajectories were often spending >60% of their first turn just retrieving context»;
  - модель обучена делать 8 параллельных вызовов (grep, glob, read) за ход, максимум 4 последовательных хода, тогда как «agentic search can commonly take 10-20 serial turns»;
  - инференс на Cerebras: SWE-grep-mini >2,800 ток/с, SWE-grep >650 ток/с;
  - на выходе список файлов с диапазонами строк (детерминированная награда для RL).
  — [Cognition blog](https://cognition.ai/blog/swe-grep); [Windsurf docs](https://docs.windsurf.com/context-awareness/fast-context.md)
- **Cursor Composer (2025-10-29)** [V]: «generation speed four times faster than similar models»; модель обучена «maximize parallelism whenever possible» в тулах; «response speed is a critical component for interactive development». Ни ток/с, ни времени хода в тексте нет. — [Cursor blog](https://cursor.com/blog/composer)
- **LLMCompiler (ICML 2024; v1 2023-12-07, датированный первоисточник)** [V]: планировщик строит DAG вызовов, исполнитель запускает их параллельно. Против ReAct: «up to 3.7x» по латентности, «up to 6.7x» по стоимости, «up to ~9%» по точности. — [arXiv 2312.04511](https://arxiv.org/abs/2312.04511)
- **«When Parallelism Pays Off: Cohesion-Aware Task Partitioning for Multi-Agent Coding» (2026-05-31)** [V, абстракт]:
  - до ×2.10 по wall-clock, до +14.0% pass rate, до −35% стоимости API на 28 задачах (DevEval, CodeProjectEval);
  - сравнение с последовательным и с «file-based parallel» вариантами, не с одиночным агентом;
  - общение между агентами «incurs extra cost and can sometimes offset the efficiency gains»; выигрыш максимален на «most dependency-dense projects».
  — [arXiv 2606.00953](https://arxiv.org/abs/2606.00953)
- Механика параллельных вызовов в Pi, Claude Code и Codex, а также `parallel_tool_calls` выключенный по умолчанию у Qwen — см. 01 §A, 02, 03, 07 (не дублирую).

### Inferences
- У нас 8 шагов идут строго последовательно, но **внутри шага** много независимых чтений, генераций и проверок (например, ассеты или секции страницы). Это кандидаты на параллельные tool calls в одном ответе модели и на параллельные read-only субагенты. Писатель остаётся один (ADR-7).
- Порядок величины: если ~30–50% наших вызовов — независимые чтения или проверки и модель научится батчить их по 3–8 за ход, число вызовов падает примерно на четверть или треть. Это оценка, а не замер. Без явной подсказки в промпте модели батчат плохо (Codex #35050: «only a little over 100» из ~1600 сгруппировано).
- Параллельные субагенты стоят ×4…×15 токенов; для нас это оправдано только на шагах «исследование/референсы», не на сборке.

### Gaps
- Нет независимого замера ускорения параллельных read-only тулов в Claude Code или Codex: есть только описание механики.
- Нет данных, как DeepSeek V4.1 Flash, Kimi K3.1, Qwen 3.8 через a6api батчат параллельные вызовы. Это эксперимент A8 из 00-synthesis.

## 3. «Умная модель планирует, быстрая исполняет»: architect/editor, fast apply, speculative edits

### Takeaway
Architect/editor у Aider — это прежде всего рычаг **качества и цены** (85.0% против 79.7%; R1+Sonnet 64.0% за $13.29 против o1 61.7% за $186.5), а не скорости: на каждую правку уходит два последовательных вызова, и сам Aider называет лучшие конфигурации «quite slow». Скорость дают специализированные apply-модели: 1,000 → 4,500 → 10,500 ток/с за счёт speculative decoding на исходном файле.

### Cited Findings
- **Aider architect/editor (2024-09-26, датированный первоисточник)** [V]:
  - o1-preview + o1-mini (whole) — 85.0%; o1-preview + DeepSeek (whole) — 85.0%; o1-preview + Sonnet 3.5 (diff) — 82.7%; o1-preview один — 79.7%;
  - Sonnet 3.5 один — 77.4%, Sonnet + Sonnet — 80.5%; gpt-4o-mini один — 55.6%, в паре с собой — 60.2%;
  - про скорость: лучшие whole-конфигурации «quite slow, so probably not practical for interactive use».
  — [aider.chat](https://aider.chat/2024/09/26/architect.html)
- **Aider R1 + Sonnet (2025-01-24)** [V]: R1+Sonnet — 64.0%, $13.29; o1 — 61.7%, $186.5; R1 — 56.9%, $5.42; Sonnet — 51.6%, $14.41; DeepSeek V3 — 48.4%, $0.34. В посте: «14X less cost» против o1. — [aider.chat](https://aider.chat/2025/01/24/r1-sonnet.html)
- **Cursor «Editing Files at 1000 Tokens per Second» (2024-05-14, датированный первоисточник)** [U, по выдержке поиска; пост целиком не открывал]: «speculative edits» — вариант speculative decoding, где черновиком служит исходный файл. ~1000 ток/с (~3500 символов/с) на 70B-модели; ~13× против ванильного Llama-3-70B и ~9× против прежнего GPT-4 speculative edits. — [Cursor blog](https://cursor.com/blog/instant-apply)
- **Morph Fast Apply (2025-09-15)** [V, вендор]:
  - morph-v3-fast — «10,500+ tok/sec» на запрос (было ~4,500); morph-v3-large — ~5,000 ток/с; один B200; модель ~7B;
  - большинство правок файлов — «1-3 seconds» с учётом сети, холодные одиночные запросы;
  - против search-and-replace: несколько мест правятся за один проход, «roughly 35% faster end-to-end» на их бенчмарках (вендорская цифра);
  - техники: speculative decoding, фьюзинг ядер, урезанный словарь.
  — [Morph blog](https://www.morphllm.com/blog/morph-breaks-10k-barrier.md)
- Запуск Morph на HN: v3-fast 4500+ ток/с, v3-large 2500+ ток/с [U]. Точность на OpenRouter 96%, на сайте Morph 98% — **расхождение** [U]. — [HN](https://hn.svelte.dev/item/44490863); [OpenRouter](https://openrouter.ai/morph/morph-v3-fast)
- **Relace Apply 3 (релиз 2025-09-26)** [U]: листинг OpenRouter — «10,000 tokens/sec on average» (вендорская формулировка); агрегатор modelgrep — 2.8k ток/с p50 (методика неизвестна); **противоречие** ×3.5. Цена $0.85/$1.25 за 1M, окно 256K. — [OpenRouter Relace](https://openrouter.ai/ko-KR/relace); [modelgrep](https://www.modelgrep.com/best/fastest/relace); [pricepertoken](https://pricepertoken.com/pricing-page/model/relace-relace-apply-3)
- Связанный паттерн «премиум-лид + дешёвый исполнитель» (Fusion: $1.35 / 63.1 против $3.51 / 63.6) и `jev-router` Pi — в 00 ADR-7 и 01 §D (не дублирую).

### Inferences
- Для скорости нашего пайплайна architect/editor на каждую правку **вреден**: два вызова вместо одного. Полезен вариант «план один раз на шаг»: премиум пишет план и критерии на весь шаг, быстрый исполнитель делает много мелких действий. Это уже наша гипотеза D2/B4.
- Fast apply окупается, только если правки крупные (переписывание секций HTML/CSS). Тогда основная модель выдаёт «ленивый» сниппет с `// ... existing code ...` за меньшее число токенов, а apply-модель сливает его за 1–3 с. На a6api этих моделей, скорее всего, нет; потребуется отдельный провайдер (проверить).
- Вместо отдельной модели можно ускорить «целиком переписать файл» через speculative decoding на стороне провайдера (predicted outputs). Через шлюз это, скорее всего, недоступно [U].

### Gaps
- Не нашёл независимого (не вендорского) замера точности и скорости Morph или Relace 2026 года.
- Не нашёл данных о том, есть ли у a6api или у провайдеров DeepSeek, Kimi, Qwen аналог predicted outputs или speculative edits.

## 4. Prompt caching: латентность (TTFT) и стоимость

### Takeaway
Попадание в кэш сокращает в первую очередь **prefill**, то есть TTFT на длинных промптах. Цифры вендоров: Anthropic — 100K токенов, 11.5 с → 2.4 с (−79%); DeepSeek — 128K, 13 с → 0.5 с; на коротких промптах эффект мал (10K: 1.6 → 1.1 с, −31%). Скидка на кэшированный вход: −90% у Anthropic и DeepSeek, до −95% у OpenAI.

### Cited Findings
- **Anthropic prompt caching** (анонс 2024-08-14, GA 2024-12-17; на странице claude.com/blog извлечённая дата «2025-08-14» противоречит апдейту 2024-12-17 на той же странице) [V]:
  - заголовок: «reducing costs by up to 90% and latency by up to 85% for long prompts»;
  - таблица TTFT:

| Сценарий | TTFT без кэша | TTFT с кэшем | Цена |
|---|---|---|---|
| Chat with a book, 100K токенов | 11.5 с | 2.4 с (−79%) | −90% |
| Many-shot, 10K токенов | 1.6 с | 1.1 с (−31%) | −86% |
| Multi-turn, 10 ходов с длинным system | ~10 с | ~2.5 с (−75%) | −53% |

  — [Claude blog](https://claude.com/blog/prompt-caching)
- **OpenAI prompt caching (текущие доки, 2026)** [V]:
  - процента по латентности на текущей странице **нет**, только «Reduce the time spent processing input before the response starts»;
  - кэшированный вход «discounted up to 95%»: 0.1× для GPT-5.6+, 0.05× для GPT-6.1 Sol;
  - минимум 1,024 токена;
  - TTL на GPT-5.6+ — `prompt_cache_options.ttl` = `"30m"` (по умолчанию) или `"12h"`;
  - **подводный камень**: «Cached states live on individual machines, where traffic above 15 requests per minute can lead to overflow routing» — держать ~15 RPM на ключ/префикс, а больший трафик делить на несколько ключей.
  — [OpenAI docs](https://developers.openai.com/api/docs/guides/prompt-caching)
- **DeepSeek context caching (2024-08-02, датированный первоисточник)** [V]:
  - «the first token latency is cut from 13s to just 500ms» на промпте 128K;
  - «slashing API costs by up to 90%», без оптимизации в среднем >50%;
  - только точное совпадение префикса с первого токена, единица 64 токена, «does not guarantee 100% cache hits», очистка «within a few hours to days».
  — [DeepSeek API news](https://api-docs.deepseek.com/news/news0802)
- **Транспорт как продолжение кэширования: OpenAI WebSocket mode для Responses API (2026)** [V-доки]:
  - «For rollouts with 20+ tool calls, we have seen up to roughly 40% faster end-to-end execution»;
  - клиент шлёт только новые элементы + `previous_response_id`; состояние держится в «connection-local in-memory cache»; есть прогрев `generate: false`;
  - соединение живёт до 60 мин, до 16 одновременных ответов;
  - с `store=false` после закрытия соединения кэш теряется — `previous_response_not_found`.
  — [OpenAI docs](https://developers.openai.com/api/docs/guides/websocket-mode)
- InfoQ (2026-05-07) [V-вторично]:
  - Vercel — «up to 40% latency reduction»; Cline — «39% improvement in multi-file workflows»; Cursor — «gains of up to 30%»;
  - «repeated network round-trip times became a dominant source of latency» по мере ускорения инференса;
  - сам пост OpenAI (по сводке новостей от 2026-04-22) вернул 403 и не прочитан.
  — [InfoQ](https://infoq.com/news/2026/05/openai-websocket-responses-api)

### Inferences
- Наши 16–38 с на вызов при одном мелком действии нельзя объяснить декодом: 300 токенов при 206 ток/с — это ~1.5 с. Остаются prefill на промахе кэша (при 50–130K контекста — единицы секунд и до ~13 с, судя по цифрам выше), reasoning-токены и очередь у шлюза или провайдера. **Первое действие — разложить время каждого вызова на TTFT, reasoning_tokens, cached_tokens и decode по логам** (эксперимент A2).
- Если cache-hit через a6api низкий (разные бэкенды, TTL, лимиты RPM на префикс), его подъём — самый дешёвый рычаг скорости: −75…−95% TTFT на длинном контексте без потери качества.
- WebSocket mode — только OpenAI Responses API; к нашему chat-completions шлюзу неприменим. Применимы keep-alive/HTTP2 к шлюзу и отсутствие лишних прокси-хопов. Сколько это экономит, не измерено.

### Gaps
- Нет свежих (2026) цифр TTFT hit/miss от DeepSeek V4.x, Kimi K3.x, Qwen 3.8; данные DeepSeek 2024 года сделаны на V2-эпохе.
- Неизвестно, сохраняет ли a6api session affinity к одному бэкенду (без неё кэш у провайдера промахивается).

## 5. Меньше раундов: батчинг правок, «богатые» тулы, стриминг исполнения, спекулятивные тулы

### Takeaway
Меньше раундов можно получить четырьмя способами: (1) несколько изменений в одном вызове (multi-edit, fast apply — по Morph ~35% быстрее search-and-replace); (2) тулы, делающие больше за раз (поиск с 8 параллельными вызовами, search+execute у Cloudflare); (3) запуск тула, как только его вызов закончился в стриме (Codex; fine-grained streaming у Anthropic); (4) спекулятивное исполнение предсказанных вызовов: в исследованиях 2026 года −18.6…−44.9% wall-clock, у PASTE −43.5% среднего времени задачи.

### Cited Findings
- **PASTE, «Parallelizing Tool Execution and LLM Generation for Low-Latency Agent Serving» (v1 2026-03-19, v3 2026-06-16)** [V, абстракт]:
  - предсказывает будущие вызовы по повторяющимся паттернам агента и исполняет их, пока LLM ещё генерирует; результаты «isolated until confirmed by the LLM»;
  - среднее время задачи −43.5%, наблюдаемая латентность тулов ниже в 1.8×;
  - выдача поиска называла −48.5% и «1.8× throughput» — **расхождение с абстрактом v3**, беру абстракт;
  - как обращаться с тулами с побочными эффектами, в абстракте не сказано.
  — [arXiv 2603.18897](https://arxiv.org/abs/2603.18897)
- **Speculative Macro Commit (2026-09-03)** [V, абстракт]:
  - маленькая модель-драфтер проигрывает будущие цепочки действий «on an isolated environment snapshot»; если следующий вызов основной модели совпал с первым шагом черновика, остальные шаги принимаются;
  - τ²-Bench Telecom: −18.59% латентности против последовательного исполнения, −10.23% против Speculative Actions, точность «matches»;
  - AppWorld: −44.9% wall time против последовательного, −7.7% против SA, «small reduction in task completion».
  — [arXiv 2609.03236](https://arxiv.org/abs/2609.03236)
- Другие работы о спекуляции [U, только сводка поиска]:
  - SPAgent (поисковые агенты) — до ×1.65 end-to-end ([arXiv 2511.20048](https://arxiv.org/abs/2511.20048));
  - DualSpec — разные политики для разных типов действий ([arXiv 2603.07416](https://arxiv.org/abs/2603.07416));
  - Speculative Interaction Agents — асинхронный I/O + спекулятивные вызовы ([arXiv 2605.13360](https://arxiv.org/abs/2605.13360));
  - speculative tool use в vLLM — до ~196 ток/с прироста throughput при 32 параллельных агентах gpt-oss-120b ([arXiv 2512.15834](https://arxiv.org/abs/2512.15834)).
- **Anthropic fine-grained tool streaming (доки, 2026)** [V]: `eager_input_streaming: true` на тул убирает серверную буферизацию и валидацию JSON и «reduces the time to the first fragment of a large parameter, such as a document or a block of code». Риск: «you might receive partial or invalid JSON»; при `max_tokens` параметр обрезается; при невалидном JSON нужно вернуть `is_error` с `{"INVALID_JSON": ...}`. Числовых замеров нет. — [Claude docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming)
- **Anthropic token-efficient tool use** (запуск с Claude 3.7 Sonnet, 2025-02) [U-сводка доков]:
  - в среднем −14% output-токенов, до −70%, и, как следствие, меньше латентность;
  - в Claude 4 включено по умолчанию по новой версии доков; старая версия страницы говорила обратное — **противоречие версий**;
  - не работает с `disable_parallel_tool_use`.
  — [Claude docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/token-efficient-tool-use); [Claude blog](https://claude.com/blog/token-saving-updates)
- Батчинг правок: Morph — «roughly 35% faster end-to-end» против search-and-replace, где «each chunk is a separate tool call» (вендорский замер) [V, вендор]. — [Morph blog](https://www.morphllm.com/blog/morph-breaks-10k-barrier.md). Multi-edit `edits[]` в Pi и запуск тула сразу по окончании его элемента в стриме у Codex — см. 01 §C и 03 (не дублирую).
- Cloudflare: `execute()` выполняет пагинацию, условную логику и цепочки вызовов «in a single cycle, cutting round-trip overhead» [V-выдержка]. — [Cloudflare blog](https://blog.cloudflare.com/code-mode-mcp/)

### Inferences
- Для нашего пайплайна самые дешёвые меры без смены моделей: (а) **составные тулы под наши шаги**, например «собрать + скриншот + проверить консоль» одним вызовом вместо 3–4; «записать N файлов» одним вызовом; (б) в промпте исполнителя прямое требование батчить независимые действия; (в) начинать исполнение read-only тулов, не дожидаясь конца ответа модели.
- Спекуляцию стоит применять только к **read-only** и идемпотентным тулам (чтение, grep, скриншот, lint). Для записи нужен снапшот (у SMC — изолированный снапшот окружения). Пока это исследовательская техника: в харнесах 2026 года, которые я видел, её нет.

### Gaps
- Нет данных, как PASTE и SMC обходятся с тулами, меняющими состояние: абстракты молчат.
- Нет замера fine-grained streaming в секундах.

## 6. Латентность reasoning/thinking и когда его выключать

### Takeaway
Измеренного сравнения «thinking on/off» в секундах на многоходовых tool-циклах я не нашёл. Есть косвенные данные: effort сокращает output-токены на 48–76% при сохранении качества (Opus 4.5), fast mode Claude даёт до ×2.5 скорости вывода за ×6 цены, OpenAI рекомендует `none` для задач без многошаговых вызовов. Для наших механических шагов главный кандидат на ускорение — reasoning-токены.

### Cited Findings
- **Opus 4.5 effort (2025-11-24)** [U — вторичные источники цитируют Anthropic; анонс Anthropic не открывал]: на medium effort Opus 4.5 «matches Sonnet 4.5's best SWE-bench Verified score» при «76% fewer output tokens»; на максимальном effort превосходит его на 4.3 п.п. при −48% токенов. — [DeepLearning.AI The Batch](https://charonhub.deeplearning.ai/claude-opus-4-5-retakes-the-coding-crown-at-one-third-the-price-of-its-predecessor/)
- **Claude Code fast mode (запуск 2026-02-07)** [U — сводка доков и прессы]: та же Opus с другими настройками API, «up to 2.5x faster» вывод. Цена Opus 4.6/4.7 — $30/$150 за 1M (×6 к $5/$25), Opus 4.8 — $10/$50. Измеренной латентности в доках нет. — [Claude Code docs](https://code.claude.com/docs/en/fast-mode); [Simon Willison](https://simonwillison.net/2026/Feb/7/claude-fast-mode/)
- **OpenAI reasoning guide** [U — сводка поиска]: `none` — для «latency-critical tasks that do not benefit from any reasoning or multi-chained tool calls»; `low` — для задач с tool use, планированием, поиском. — [OpenAI docs](https://developers.openai.com/api/docs/guides/reasoning)
- Иллюстративный (не измеренный) расклад от вендора инфраструктуры General Compute (2026-05-08) [U, вендор продаёт API]: вызов тула — 30–50 токенов вывода, TTFT 400–800 мс, prefill 10K на 70B-модели 0.6–2 с, наивное constrained decoding +1–3 с на 50 токенов. — [General Compute](https://www.generalcompute.com/blog/tool-calling-latency-the-bottleneck-no-one-talks-about)

### Inferences
- Если в 16–38 с наших вызовов основную часть составляют reasoning-токены (при ~200 ток/с 2–5K токенов размышлений — это 10–25 с), то перевод механических шагов (копирование, запись по готовому плану, запуск сборки) на `low`/`none` или в non-thinking режим может сократить время вызова в разы. Это гипотеза; её проверяет разложение `usage.reasoning_tokens` по нашим логам.
- Ограничения из репо: effort и thinking фиксируются на сессию ради кэша (ADR-1; у Kimi смена effort «invalidates the KV cache»). Поэтому «выключить thinking на механических шагах» = отдельная сессия или субагент-исполнитель для механики, а не переключение посреди сессии. У DeepSeek без возврата `reasoning_content` будет HTTP 400 (ADR-2).

### Gaps
- Нет секундных замеров on/off для DeepSeek V4.1 Flash, Kimi K3.1 Pro, Qwen 3.8 Max на tool-циклах; нужен наш эксперимент.
- Первоисточник Anthropic с цифрами 76%/48% не открывал.

## 7. Бенчмарки и инженерные посты 2025–2026 о сквозном времени агентных задач

### Takeaway
Стандартного бенчмарка, изолирующего вклад харнеса в wall-clock, нет. Есть описательные цифры: 9–11 мин на задачу в интерактивных и CLI-бенчмарках, 34–43 мин на длинных задачах. Дольше и дороже не значит лучше (DeepSWE). Retrieval съедает >60% первого хода. Подтверждённые инженерные рычаги ускорения: параллельный поиск, сокращение раундов (WebSocket до −40% при 20+ вызовах), кэш, быстрые специализированные модели.

### Cited Findings
- **TraceLab, характеристика нагрузок coding-агентов (2026-06-29)** [V, абстракт]: ~350,000 LLM-шагов в ~4,300 сессиях (≈81 шаг на сессию — мой подсчёт), ~430,000 вызовов тулов (≈1.2 на шаг), «long contexts with short outputs», переиспользование префикса «high but imperfect». — [arXiv 2606.30560](https://arxiv.org/abs/2606.30560). Из выдачи поиска: человек — 92.3% wall-clock сессии, генерация LLM — 3.3%, тулы — 4.8% [U, в абстракте этого нет; относится к интерактивным сессиям, не к нашему автономному пайплайну].
- [U, только сводка поиска, статьи не открывал]:
  - **WildClawBench** (2026-05): «Claude Code is the most latency-bound setting in our suite», 9.1–10.2 мин на задачу по четырём моделям ([arXiv 2605.10912](https://arxiv.org/abs/2605.10912));
  - **SWE-Together** (2026-06): gpt-5.5 эффективнее всех по токенам и времени, 10.7 мин на задачу, с оговоркой о влиянии инфраструктуры эндпоинта ([arXiv 2606.29957](https://arxiv.org/abs/2606.29957));
  - **SWE-Serve** (2026-09): 43.3 мин в среднем на задачу против 34.3 мин у DeepSWE, сравнение описательное ([arXiv 2609.26777](https://arxiv.org/abs/2609.26777));
  - **DeepSWE** (2026-07): ни число токенов, ни время работы, ни стоимость не коррелируют сильно с pass rate ([arXiv 2607.07946](https://arxiv.org/abs/2607.07946)).
- Cognition: «>60% of their first turn just retrieving context» → 8 параллельных вызовов, ≤4 хода [V]. — [Cognition blog](https://cognition.ai/blog/swe-grep)
- OpenAI WebSocket mode: до ~40% быстрее при 20+ вызовах; Cline −39% на multi-file, Cursor до 30% [V-доки / V-вторично InfoQ]. — [OpenAI docs](https://developers.openai.com/api/docs/guides/websocket-mode); [InfoQ](https://infoq.com/news/2026/05/openai-websocket-responses-api)
- Anthropic: до −90% времени исследования за счёт параллелизма [V]. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

### Inferences
Сводная приоритизация рычагов для нашего пайплайна. Всё ниже — вывод, требующий замера.

1. **Замер раньше оптимизации.** Разложить каждый из 230–680 вызовов на TTFT, cached_tokens, reasoning_tokens, output_tokens и время тула. Без этого неясно, что съедает 16–38 с: промахи кэша, размышления или очередь шлюза.
2. **Кэш-hit через a6api** (если низкий): −75…−95% TTFT на длинном контексте, без потери качества (Anthropic, DeepSeek).
3. **Thinking low/none для механических шагов** через отдельную сессию или исполнителя: потенциально в разы на вызов, если reasoning доминирует (Opus 4.5: −76% токенов без потери качества на medium).
4. **Меньше вызовов**: составные тулы под шаги пайплайна, обязательный батчинг независимых действий в промпте (параллельные tool calls), codemode Pi для механических цепочек. Ориентиры: «минус 19+ проходов на 20 вызовов» (Anthropic), 10–20 → 4 хода (Cognition), −30% шагов (smolagents/CodeAct, первоисточник цифры не проверен).
5. **Параллельные read-only субагенты** — только на шагах исследования и референсов (×4…×15 токенов).
6. **Исследовательское**: спекулятивное исполнение read-only тулов (−18…−45% wall-clock в статьях 2026 года), fast apply для крупных правок (1–3 с на правку, вендор).

Подводные камни: песочница для кода (smolagents local executor — «not a security sandbox»); частичные побочные эффекты упавших скриптов; модели сериализуют вызовы без явной подсказки; кэш ломается от смены тулов или effort посреди сессии; OpenAI переполняет кэш при >15 RPM на префикс; architect/editor на каждую правку удваивает раунды; параллельные писатели конфликтуют (общение «can offset the efficiency gains»); спекулятивное исполнение тулов с побочными эффектами.

### Gaps
- Нет бенчмарка, сравнивающего харнесы по wall-clock на одних моделях и железе. SWE-Serve и SWE-Together сами называют свои сравнения описательными.
- TraceLab и WildClawBench в полном тексте не читал: доли времени LLM/тул для **автономных** сессий не извлечены.
- Нет публичных данных о сквозном времени именно дизайн- и web-пайплайнов, сопоставимых с нашими 2–5 ч.
