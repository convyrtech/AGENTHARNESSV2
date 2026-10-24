# Context engineering для долгих агентных сессий: малый контекст и горячий кэш на сотнях вызовов

> Контекст задачи: один агент в одной сессии Pi 1.4 гонит 8-шаговый дизайн-пайплайн. Контекст растёт до 120–210K токенов, каждый вызов переотправляет его целиком (16–38 с на вызов, 230–680 вызовов на страницу). Шлюз a6api.com маршрутизирует к разным поставщикам: у одних 0% cache hit, у других ~99%.
>
> **Чего здесь нет, чтобы не дублировать.** Компакция Pi (триггер `contextWindow − 16384`, `keepRecentTokens=20000`, формат саммари, `ContextEditEntry`, compat-флаги кэша) описана в `research/01-pi.md` §B5–B8. Компакция Claude Code (cache-safe forking, idle compaction, что переживает компакцию, кэш за шлюзами, цифры $11.20/$1.62/$0.99) — в `research/02-claude-code-anthropic.md` §B2–B4. Свежие данные 2026 (Cursor, Factory gateway 2.12–2.37×, Cline $20 против $43, 2609.20804, CliffCompaction, Manus 2.0 −23.2% токенов) — в `research/08-practitioners-research.md` §B1–B8. Ниже первичные цифры по каждому приёму и только дельта к этим файлам.
>
> Пометки: [V] — проверено в первоисточнике в этой сессии (2026-10-24); [U] — не проверено или вторичный источник; [calc] — мой расчёт по цитированным формулам.

## 1. Manus, «Context Engineering for AI Agents: Lessons from Building Manus» (2025): точные цифры и приёмы

### Takeaway
Manus называет KV-cache hit rate главной метрикой. Обоснование: при соотношении input:output ≈100:1 и разнице цен cached/uncached в 10× стоимость определяется почти только долей кэша. Остальные приёмы обслуживают эту цель: append-only, маскирование tools вместо удаления, файловая система как память, рецитация todo.md. Все они держат префикс неизменным и одновременно не дают модели «потеряться» на ~50 вызовах инструментов.

### Cited Findings
- Дата 2025-07-18, автор Yichao «Peak» Ji (Manus) [V] — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- «the average input-to-output token ratio is around 100:1» [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Цены Claude Sonnet: «cached input tokens cost 0.30 USD/MTok, while uncached ones cost 3 USD/MTok», то есть разница 10× [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Измеренного hit rate Manus не публикует. В статье только ценовой пример [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- «A typical task in Manus requires around 50 tool calls on average» [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Фреймворк переписывали 4 раза: «we've rebuilt our agent framework four times» [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). Позже в пересказе вебинара (2025-12-04) звучит «rewritten five times in the last six months» [U, вторичный] — [Phil Schmid](https://www.philschmid.de/context-engineering-part-2)
- **Стабильный префикс.** Изменение даже одного токена инвалидирует кэш от этой точки. Явный антипример — timestamp с точностью до секунды в начале системного промпта [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Append-only.** Не редактировать прошлые actions и observations. Сериализация должна быть детерминированной: некоторые JSON-библиотеки не гарантируют порядок ключей, и кэш ломается молча [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Ручные breakpoints.** Как минимум конец системного промпта; учитывать истечение TTL. Для self-hosting — prefix caching в vLLM плюс session ID для липкой маршрутизации запросов [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Mask, don't remove.** Инструменты не удаляются посреди задачи. Вместо этого Manus «masks the token logits during decoding to prevent (or enforce) the selection of certain actions». Три режима через prefill (пример формата Hermes):
  - *Auto* — prefill только `<|im_start|>assistant`;
  - *Required* — prefill до токена tool call;
  - *Specified* — prefill до начала имени функции.

  Общие префиксы имён (`browser_`, `shell_`) позволяют ограничить группу инструментов без stateful logits processor [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Файловая система как контекст** (окна «128K tokens or more» на реальных задачах не хватает). «Restorable compression»: содержимое веб-страницы выбрасывается, URL остаётся; содержимое документа выбрасывается, путь в sandbox остаётся. Числовых лимитов нет [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Рецитация todo.md.** Переписывание todo выносит глобальный план в конец контекста, против «lost-in-the-middle» дрейфа на ~50 вызовах [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus). Позже, по пересказу вебинара: постоянно переписываемый `todo.md` «wasted tokens (~30% in earlier versions of Manus)» [U, вторичный] — [Phil Schmid, 2025-12-04](https://www.philschmid.de/context-engineering-part-2)
- **Ошибки остаются в контексте.** Неудачные actions и stack traces не вычищаются, чтобы модель обновила «убеждения» и не повторяла ошибку [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Few-shot ruts.** На пачке из 20 резюме агент впадал в повторяющийся ритм. Лечение — «structured variation»: разные шаблоны сериализации, альтернативные формулировки, небольшой шум в порядке и форматировании [V] — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- **Компакция и суммаризация (вебинар LangChain × Manus, пересказ).**
  - Compaction обратима: убирается то, что можно перечитать из среды (путь вместо 500 строк кода).
  - Summarization необратима, к ней прибегают позже.
  - Последние tool calls сохраняются «in their raw, full-detail format».
  - Иерархическое пространство действий: «~20 core tools» (atomic) → утилиты sandbox через `bash`/`mcp-cli` → код и пакеты.
  - Порог 128K и схема «oldest 20 turns → JSON, last 3 raw» у Schmid приведены как *пример автора*, не как цифры Manus [U, вторичный] — [Phil Schmid](https://www.philschmid.de/context-engineering-part-2)
- Цифру «pre-rot threshold 128K–200K», которую приписывают Peak Ji, нашёл только в корейском пересказе. В статье Schmid её нет: там «< 256k tokens for most models» как мнение автора [U] — [Phil Schmid](https://www.philschmid.de/context-engineering-part-2); [поиск, корейский пересказ](https://fastcampus.co.kr/community/102926)

### Inferences
- **Сценарий 0% hit на шлюзе — именно тот, против которого написана статья Manus** [calc]. При 100:1 и чтении кэша по 0.1× страница с ~75M входных токенов (455 вызовов × 165K, середина ваших диапазонов) стоит ≈9.2× дороже, чем при 99% hit: 0.01 + 0.99×0.1 = 0.109. Для цен чтения 0.25× (OpenAI до GPT-5.6, Gemini implicit, Grok, Moonshot) разница ≈3.9×, для 0.05× (Opus/Sonnet 5.5) — ≈16.8×.
- В дизайн-пайплайне аналог restorable compression — держать в контексте пути к `DESIGN.md`, скриншотам и HTML, а содержимое выбрасывать после использования.
- Масштаб задач разный: у Manus ~50 вызовов на задачу, у вас 230–680 на страницу. Поэтому одного «append-only + todo» мало, нужна периодическая компакция или сброс контекста на границах шагов (см. разделы 2, 5, 6).
- Маскирование логитов через prefill недоступно через OpenAI-совместимый маркетплейс без поддержки prefill и constrained decoding. Практический эквивалент — не менять список tools, а запрещать инструменты текстом в хвосте или через `tool_choice`. Важно: у Anthropic смена `tool_choice` инвалидирует кэш сообщений (раздел 8).

### Gaps
- Manus не публикует измеренный hit rate и не даёт цифр эффекта от todo.md, удержания ошибок и structured variation. Первоисточника (записи или транскрипта) вебинара с Peak Ji не нашёл, поэтому цифры 30% todo-токенов и 128–200K остаются [U].
- Независимой проверки «few-shot ruts» не найдено (то же отмечено в `08-practitioners-research.md`).

## 2. Anthropic: «Effective context engineering for AI agents» (2025), context editing, memory tool, compaction

### Takeaway
Anthropic формулирует цель так: «smallest possible set of high-signal tokens». Инструментально она закрывается четырьмя приёмами: tool result clearing («the safest lightest touch form of compaction»), компакция, внешние заметки или memory tool, субагенты с выжимкой 1–2K токенов. Единственные опубликованные числа эффекта: +39% (memory + context editing), +29% (только context editing), −84% токенов на 100-ходовом web-search эвале (Sonnet 4.5, 2025-09-29).

### Cited Findings
- Дата 2025-09-29, команда Applied AI. Context rot: «the model's ability to accurately recall information from that context decreases» по мере роста контекста. «Attention budget» расходуется каждым токеном; у трансформера «n² pairwise relationships for n tokens» [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Компакция в Claude Code** (по статье 2025 года). Сохраняются «architectural decisions, unresolved bugs, and implementation details», отбрасываются избыточные tool outputs; работа продолжается со сжатым контекстом и «the five most recently accessed files». Рекомендация: сначала максимизировать recall саммари, потом precision [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents). Актуальное поведение (до 5 файлов, файл >5K токенов — ссылкой, skills ≤5K/25K) — в `02-claude-code-anthropic.md` §B3.
- **Tool result clearing:** «One of the safest lightest touch forms of compaction». Когда результат глубоко в истории, сырой вывод редко нужен снова [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Структурированные заметки.** NOTES.md или to-do; пример с Pokémon: «for the last 1,234 steps I've been training my Pokémon in Route 1, Pikachu has gained 8 levels toward the target of 10». Агент возобновлял многочасовые последовательности после context reset [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Субагенты.** Каждый может тратить «tens of thousands of tokens or more», но возвращает «only a condensed, distilled summary of its work (often 1,000-2,000 tokens)» [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Just-in-time retrieval.** Держать «lightweight identifiers (file paths, stored queries, web links, etc.)» и грузить данные инструментами (head/tail вместо целых объектов) [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- **Числа context management** (2025-09-29, Claude Sonnet 4.5) [V] — [Claude blog «Managing context»](https://claude.com/blog/context-management):
  - memory tool + context editing «improved performance by 39% over baseline» на внутреннем agentic search эвале;
  - только context editing — 29%;
  - на 100-ходовом web search эвале context editing позволил завершить задачи, которые иначе падали от исчерпания контекста, «reducing token consumption by 84%»;
  - платформы: Claude Developer Platform, Amazon Bedrock, Vertex AI (public beta).
- **Параметры `clear_tool_uses_20250919` (текущие docs)** [V] — [Claude docs: Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing):
  - работает **server-side**: клиент хранит полную историю, API режет перед подачей модели;
  - beta header `context-management-2025-06-27`;
  - `trigger` по умолчанию **100,000 input tokens** (можно задать в `tool_uses`);
  - `keep` по умолчанию **3** последние пары tool use/result;
  - `clear_at_least` по умолчанию нет; `exclude_tools`; `clear_tool_inputs=false` (вызовы видны, чистятся только результаты);
  - вместо результата ставится плейсхолдер;
  - в ответе `context_management.applied_edits` с `cleared_tool_uses` и `cleared_input_tokens`.
- **Context editing и кэш:** «Invalidates cached prompt prefixes when content is cleared… Use the `clear_at_least` parameter… You'll incur cache write costs each time content is cleared, but subsequent requests can reuse the newly cached prefix» [V] — [Claude docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- **`clear_thinking_20251015`.** `keep` зависит от модели: Opus 4.5+, Sonnet 4.6+, Haiku 5.5+ хранят все thinking-ходы, ранние модели — только последний. Очистка thinking инвалидирует кэш с точки очистки [V] — [Claude docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- **Memory tool:** клиентский, файловый, «create, read, update, and delete files in a dedicated memory directory stored in your infrastructure» [V] — [Claude blog](https://claude.com/blog/context-management). Подробности (`/memories`, команды, инжектируемый промпт) — в `02-claude-code-anthropic.md` §B6.

### Inferences
- Для Pi через OpenAI-совместимый шлюз серверного context editing нет. Его аналог — `ContextEditEntry` в Pi (01-pi §B6), который заменяет содержимое старых tool results на плейсхолдер без потери аудита. Дефолты Anthropic — разумная стартовая точка: триггер ~100K, хранить последние 3 результата, чистить пачкой не меньше N тысяч токенов. Тогда кэш ломается раз в несколько десятков вызовов, а не на каждом ходу [calc/inference].
- Ваши 120–210K — это уже выше дефолтного триггера Anthropic (100K). То есть по меркам вендора контекст «перерос» точку, где чистка должна была начаться.

### Gaps
- Anthropic не публикует, на каком эвале и каким методом получены 39%, 29% и 84%. Числа для моделей не-Claude не публиковались.
- Точный текст плейсхолдера при clearing в docs не приведён.

## 3. Context rot и деградация на длинном контексте (Chroma 2025, NoLiMa, работы 2025–2026)

### Takeaway
Деградация с ростом входа подтверждена у всех протестированных моделей. Chroma: 18 моделей. NoLiMa: на 32K у 11 из 13 моделей качество падает ниже 50% от короткого базового уровня. Du et al.: −13.9…−85% даже при идеальном retrieval. LongMemEval: «сфокусированный» промпт ~300 токенов значительно лучше полного ~113K. Для агентных задач это означает, что 120–210K — зона риска для качества, а не только для денег.

### Cited Findings
- **Chroma «Context Rot»** (2025-07-14; Kelly Hong, Anton Troynikov, Jeff Huber) [V] — [Chroma Research](https://www.trychroma.com/research/context-rot):
  - 18 моделей: Claude Opus 4 / Sonnet 4 / 3.7 / 3.5 / Haiku 3.5; o3, GPT-4.1 / mini / nano, GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo; Gemini 2.5 Pro / 2.5 Flash / 2.0 Flash; Qwen3-235B-A22B / 32B / 8B;
  - низкое сходство needle и вопроса: «performance degrades more quickly in input length with lower similarity needle-question pairs»;
  - «Even a single distractor reduces performance relative to the baseline»;
  - «Surprisingly… structural coherence consistently hurts model performance»: перемешанный haystack давал лучшие результаты, чем связный;
  - LongMemEval, 306 промптов, focused ~300 токенов против full ~113K: «Across all models, we see significantly higher performance on focused prompts compared to full prompts»;
  - repeated words, от 25 до 10,000 слов: «As context length increases, performance consistently degrades across all models»;
  - 194,480 вызовов, 8 длин × 11 позиций.
- **NoLiMa** (Modarressi et al., arXiv 2502.05167, v1 2025-02-07, v3 2025-07-09, ICML 2025) [V] — [arXiv](https://arxiv.org/abs/2502.05167):
  - 13 моделей с заявленным окном ≥128K;
  - «At 32K, for instance, 11 models drop below 50% of their strong short-length baselines»;
  - GPT-4o падает с 99.3% до 69.7%;
  - reasoning-модели и CoT не спасают.
- **«Context Length Alone Hurts LLM Performance Despite Perfect Retrieval»** (Du et al., arXiv 2510.05381, 2025-10-06) [V] — [arXiv](https://arxiv.org/abs/2510.05381):
  - 5 моделей, задачи math, QA и coding;
  - качество падает на «13.9%–85%» при росте входа в пределах заявленного окна, даже когда нужная информация гарантированно найдена;
  - лечение — попросить модель сначала **рецитировать** найденные доказательства (длинная задача превращается в короткую): GPT-4o +до 4% на RULER.
- Anthropic сама признаёт context rot и «attention budget» (2025-09-29) [V] — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Свежие агентные данные 2026 есть в `08-practitioners-research.md` §B6 и §B4: 2609.01660 (логит-наклон −0.69 против −0.44 при урезании окна); 2609.20804 (разрыв «управляемый контекст против неуправляемого» 35.7 → 2.7 п.п. при росте окна от 32K до 128K) [V там].
- Мнение без измерений: эффективное окно «< 256k tokens for most models» при номинальном 1M (Phil Schmid, 2025-12-04) [U] — [philschmid.de](https://www.philschmid.de/context-engineering-part-2)

### Inferences
- Для дизайн-пайплайна особенно опасны два эффекта Chroma. Первый — дистракторы: старые варианты макета, отклонённые направления и прошлые замечания критика семантически близки к текущему. Второй — связный haystack. Оба говорят, что старые итерации надо выносить из контекста (в файлы), а не просто держать.
- Рецитация (Du et al.; todo.md у Manus) — дешёвое средство: перед каждым шагом агент коротко переписывает текущее ТЗ, решения и критерии в конец контекста.
- Прямых измерений «качество дизайна в зависимости от длины контекста» не существует (см. Gaps). Перенос с needle- и coding-задач на визуальный дизайн — экстраполяция.

### Gaps
- Не нашёл исследований деградации на длинном контексте именно для мультимодальных и дизайн-агентов (скриншоты + HTML).
- Новых отчётов Chroma о context rot после 2025-07 нет (подтверждено и в 08).

## 4. OpenHands condensers: измеренные цифры стоимости и качества

### Takeaway
OpenHands (2025-04-09): LLM-summarizing condenser даёт «up to 2x» снижение стоимости на ход, переводит рост стоимости из квадратичного в линейный и не ухудшает solve rate (54% против 53% на подмножестве SWE-bench Verified). Независимая работа JetBrains на OpenHands показала: при правильном окне observation masking (M=58) достигает того же, что LLM-summary.

### Cited Findings
- Блог OpenHands, 2025-04-09, автор Calvin Smith [V] — [OpenHands blog](https://www.openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents):
  - «Up to 2x per-turn API cost reduction»; после включения конденсации средняя стоимость хода «less than half» базовой;
  - без конденсации стоимость «scales quadratically over time», с конденсацией — «scales linearly» (при событиях сходного размера);
  - подмножество SWE-bench Verified: с конденсацией «solves an average of 54%», базовый вариант «only solves an average of 53%»;
  - суммаризируются старые взаимодействия, последние сохраняются как есть; в саммари цели пользователя, прогресс, оставшаяся работа, для кода — «critical files and failing tests»;
  - конденсация срабатывает только по порогу размера, поэтому сохраняются выгоды prompt caching с «amortizing rebuilding costs across multiple turns»;
  - цена: иногда +1 ход на саму конденсацию. Числовых порогов и замеров latency в посте нет.
- Текущие дефолты SDK: `max_size=240` событий, `keep_first=2` [V в `08-practitioners-research.md`, код `software-agent-sdk@df393e3`]
- OpenHands в «Complexity Trap» (Gemini 2.5 Flash без thinking, 50 задач SWE-bench Verified, лимит 250 ходов) [V] — [arXiv 2508.21433v3 §5.1](https://arxiv.org/html/2508.21433v3):
  - окно masking из SWE-agent (M=10) в OpenHands «drastically» ухудшило результат;
  - после подбора M=58 masking сравнялся с LLM-Summary по стоимости и solve rate (точные числа только на графике).
- OpenHands отмечает, что запросы >200K токенов в OpenHands «very unlikely» благодаря конденсации [U, пересказ поиска] — [OpenHands blog: LLM models at cost](https://www.openhands.dev/blog/access-state-of-the-art-llm-models-at-cost-via-openhands-gui-and-cli)

### Inferences
- Главный урок OpenHands для кэша — **порог плюс пачка**. Конденсировать редко и сразу много, чтобы одна инвалидация кэша амортизировалась на десятки ходов. То же делают `clear_at_least` у Anthropic и пакетное удаление картинок в Claude Code.
- Параметры masking не переносятся между scaffold'ами (M=10 против M=58), значит окно надо калибровать на своём пайплайне.

### Gaps
- OpenHands не публикует пороги конденсатора на момент замера 2025-04, точные цифры токенов и latency, а также результаты на полном SWE-bench Verified.
- Список типов конденсаторов в текущем коде (observation masking, browser output и т. п.) в этой сессии проверить не удалось: GitHub API репозитория закрыт для сессии.

## 5. Компакция Pi и Claude Code: дельта к research/01-pi.md и 02-claude-code-anthropic.md

### Takeaway
Механизмы описаны в репозитории. Новое здесь — следствия для вашей нагрузки. Порог Pi `contextWindow − 16384` при окнах 200K+ означает, что в диапазоне 120–210K компакция почти никогда не срабатывает. А сама компакция в Pi — некэшируемый вызов: история сериализуется в текст, cache writes отключены. В Claude Code компакция идёт через cache-safe fork, где префикс совпадает с родителем.

### Cited Findings
- Pi: триггер `contextTokens > contextWindow − reserveTokens` с `reserveTokens=16384`; хранит последние `keepRecentTokens=20000`. Саммаризатор получает разговор, **сериализованный в текст** `[User]: … [Tool result]: …`, tool results обрезаны до 2000 символов, cache writes для запросов саммари отключены [V в `research/01-pi.md` §B5]
- Pi `ContextEditEntry` (0.87.0, 2026-09-21) — append-only замена или выброс сообщения для модели без изменения сырой истории [V в `research/01-pi.md` §B6]
- Pi: для `openai-completions` `supportsMidConvoSystemMessages=false` по умолчанию. Любая смена секции системного промпта схлопывается в ведущее system-сообщение и даёт промах кэша [V в `research/01-pi.md` §B2]
- Claude Code: компакция «повторяет system prompt, tools и историю родителя и дописывает инструкцию в конце» (cache-safe forking); idle compaction при >200K и простое ~54 мин до истечения 1-часового TTL; пример стоимости 2.8M токенов: $11.20 / $1.62 / ~$0.99 [V в `research/02-claude-code-anthropic.md` §B2–B3]
- Качество компакций разных вендоров (Factory, 2025-12-16; 36,611 сообщений из продакшен-сессий, сотни точек компакции, судья GPT-5.2, шкала 0–5) [V] — [Factory Research](https://factory.com/news/evaluating-compression):
  - Factory anchored iterative summarization: overall **3.70**, accuracy 4.04;
  - Anthropic SDK compaction: **3.44** / 3.74 (саммари ~7–12K символов, перегенерируется целиком);
  - OpenAI `/responses/compact`: **3.35** / 3.43 (непрозрачный вывод);
  - сжатие 98.6% / 98.7% / 99.3%;
  - «artifact trail» у всех 2.19–2.45: отслеживание файлов не решено;
  - пример: 178 сообщений, 89K токенов, recall-проба «какая была исходная ошибка» — 4.8 / 3.9 / 3.2;
  - «The right optimization target is not tokens per request. It is tokens per task.»

### Inferences
- [calc] Порог Pi при окне 200K ≈183.6K, при 256K ≈239.6K, при 1M ≈983.6K. Ваш наблюдаемый диапазон 120–210K — это сессия, которая растёт до потолка и компактится один раз в самом конце (или не компактится вовсе). То есть всё время работает в зоне context rot (раздел 3) и платит за полный префикс.
- [inference, U] Компакцию в Pi можно сдвинуть раньше, занизив `contextWindow` модели в `models.json` (например, 100K даёт триггер ~84K) или через extension. Каждая компакция Pi — один полностью некэшированный prefill ~(порог − 20K) токенов плюс генерация саммари. Это дешевле, чем десятки вызовов по 150K+ без кэша, но дороже cache-safe fork у Claude Code.
- [inference] Для 8-шагового пайплайна естественнее не компакция, а **сброс контекста на границе шага с handoff-артефактом**: стабильный system prompt + `DESIGN.md`/план + бриф шага. Это соответствует Anthropic (context reset + structured handoff, субагенты с выжимкой 1–2K) и Manus (ФС как память). Структура саммари по Factory (intent / file modifications / decisions / next steps) — лучший известный шаблон handoff. Отдельно стоит вести индекс артефактов (пути к скриншотам и файлам), раз artifact trail проваливают все методы.

### Gaps
- Нет опубликованных замеров качества компакции Pi против других.
- Нет данных, как часто Pi 1.4 в вашей конфигурации реально компактил: нужно смотреть логи сессий (`compaction` entries).

## 6. Исследования 2025–2026: observation masking против LLM-суммаризации для SWE-агентов

### Takeaway
«The Complexity Trap» (JetBrains/TUM, 2025): простое маскирование старых observations (последние 10 ходов полностью) **вдвое режет стоимость** относительно сырого агента и по solve rate равно LLM-суммаризации или чуть лучше. Суммаризация удлиняет траектории на 13–15% и съедает часть экономии. Гибрид экономит ещё 7–11%. AgentDiet (FSE 2026): −39.9…−59.7% входных токенов без потери качества.

### Cited Findings
- «The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management». Lindenbauer, Slinko, Felder, Bogomolov, Zharov; arXiv 2508.21433, v1 2025-08-29, v3 2025-10-27 [V] — [arXiv abs](https://arxiv.org/abs/2508.21433):
  - «a simple environment observation masking strategy halves cost relative to the raw agent», solve rate «matching, and sometimes slightly exceeding» LLM summarization;
  - гибрид: «further reduces costs by 7% and 11% compared to just observation masking or LLM summarization, respectively».
- Таблица 1 (SWE-agent, SWE-bench Verified, n=500): solve rate % / стоимость задачи $ [V] — [arXiv HTML v3](https://arxiv.org/html/2508.21433v3)

  | Модель | Raw | Masking | LLM-Summary |
  |---|---|---|---|
  | Qwen3-32B | 17.0 / 1.12 | 15.0 / 0.55 (−50.9%) | 16.0 / 0.50 (−55.4%) |
  | Qwen3-32B thinking | 23.0 / 0.51 | 24.6 / 0.46 | 24.8 / 0.51 |
  | Qwen3-Coder 480B | 53.4 / 1.29 | **54.8 / 0.61 (−52.7%)** | 53.8 / 0.64 (−50.4%) |
  | Gemini 2.5 Flash | 32.8 / 0.41 | 35.6 / 0.18 (−56.1%) | 36.0 / 0.24 (−41.5%) |
  | Gemini 2.5 Flash thinking | **40.4** / 0.56 | 36.4 (−9.9%†) / 0.24 | 31.4 (−22.3%†) / 0.25 |

- **Параметры** [V] — [arXiv HTML v3](https://arxiv.org/html/2508.21433v3):
  - masking — скользящее окно M=10 ходов с полными observations, лучшее для SWE-agent;
  - LLM-Summary — сжимает N=21 ход за раз и держит последние M=10, прогрев N+M=31;
  - гибрид (только Qwen3-Coder 480B, SWE-bench Verified-50): N=43, M=W=10, +2.6 п.п. к Raw; со «старыми» N=21 эффективность хуже.
- **Удлинение траекторий** суммаризацией [V] — [arXiv HTML v3](https://arxiv.org/html/2508.21433v3):
  - Gemini 2.5 Flash: 52 хода против 44 у masking (+15%) и 50 у Raw (+4%);
  - Qwen3-Coder 480B: +15% к Raw, +13% к masking.
- **Стоимость вызовов саммари** (доля от общей): 2.86% (Qwen3-32B), 0.65% (thinking), 7.20% (Qwen3-Coder 480B), 6.71% (Gemini Flash), 5.24% (Flash thinking). У каждого вызова саммари уникальная последовательность, поэтому кэш переиспользуется только для системного промпта саммаризатора. Цены Alibaba для Qwen3-32B не различают hit и miss, что завышает её стоимость [V] — [arXiv HTML v3](https://arxiv.org/html/2508.21433v3)
- Блог JetBrains Research «Cutting Through the Noise: Smarter Context Management for LLM-Powered Agents» (2025-12). Работа представлена на Deep Learning 4 Code workshop, NeurIPS 2025, 2025-12-06; код и датасет траекторий открыты [V по листингу поиска; пост целиком не читал] — [JetBrains Research blog](https://blog.jetbrains.com/research/2025/12/efficient-context-management/); [HF dataset](https://huggingface.co/datasets/JetBrains-Research/the-complexity-trap/blob/main/README.md)
- **AgentDiet** («Reducing Cost of LLM Agents with Trajectory Reduction», Xiao, Gao, Peng, Xiong; arXiv 2509.23586; FSE 2026) [V по аннотации из поиска; полный текст не читал] — [arXiv](https://arxiv.org/abs/2509.23586v1); [FSE 2026](https://conf.researchr.org/details/fse-2026/fse-2026-research-papers/137/Reducing-Cost-of-LLM-Agents-with-Trajectory-Reduction):
  - удаление «useless, redundant, and expired information» в Trae Agent;
  - −39.9…−59.7% входных токенов и −21.1…−35.9% общей стоимости «while maintaining the same agent performance»;
  - Claude 4 Sonnet и Gemini 2.5 Pro; SWE-bench Verified и Multi-SWE-bench Flash;
  - мотивация: в сентябре 2025 у Claude 4 Sonnet на OpenRouter лишь ~1% токенов — сгенерированные моделью [U, пересказ поиска].
- 2026: 2609.20804 (элизия + recall + суммаризация дешевле всех в 7 из 8 панелей; сильные модели «almost never call recall») и CliffCompaction (2609.26779, компакции не пересжимаются, до −50% стоимости) [V в `08-practitioners-research.md` §B4]

### Inferences
- Для вашего пайплайна первый шаг — **observation masking старых tool outputs** (HTML-дампы, логи сборки, выводы детекторов, base64 картинок), а не LLM-саммари. Он детерминирован, не требует лишнего вызова и не удлиняет траекторию.
- [inference] Скользящее окно «маскировать то, что выпало из последних M ходов» на каждом ходу меняет историю на границе окна, и на кэш-провайдерах промах будет каждый ход на хвосте ~M ходов. Значит маскировать надо **пачками** (раз в K ходов, как `clear_at_least`). В статье это не исследовано: её стоимость считалась по ценам, где для Qwen hit не отличался от miss.
- Пример Gemini 2.5 Flash thinking (masking −9.9 п.п., summary −22.3 п.п.) показывает: для некоторых моделей любое сжатие вредит качеству. Нужен A/B на своём эвале по каждой модели.

### Gaps
- Нет исследований masking против summarization на дизайн- и мультимодальных агентах.
- В «Complexity Trap» нет анализа взаимодействия masking с префиксным кэшем по ходам.

## 7. Контексты с картинками: как скриншоты и contact sheets раздувают контекст, как это лечат

### Takeaway
Картинки — самые дорогие «старые observations». У Claude 4.7+ одно изображение стоит до 4,784 визуальных токенов, а каждая картинка в истории переотправляется на каждом ходу. Стандартный приём — держать только N последних изображений, остальные заменять текстовой заглушкой или описанием. При этом добавление или удаление картинки инвалидирует кэш сообщений, поэтому удалять нужно пачками. Эталонная реализация Anthropic при включённом кэше вообще не удаляет изображения.

### Cited Findings
- **Стоимость картинки у Claude (текущие docs)** [V] — [Claude docs: Vision](https://platform.claude.com/docs/en/build-with-claude/vision):
  - `⌈width/28⌉ × ⌈height/28⌉` визуальных токенов (патч 28×28);
  - high-res tier (Claude 4.7+): long edge ≤2,576 px, ≤4,784 токенов; standard: ≤1,568 px, ≤1,568 токенов;
  - примеры: 1000×1000 → 1,296; 1920×1080 → 2,691 (high-res) / 1,560 (standard); 2000×1500 → 3,888 / 1,564; 3840×2160 → 4,784 / 1,560;
  - high-res «up to roughly three times more visual tokens».
- **Лимит, важный для долгих сессий:** если в одном запросе >20 изображений, к **каждому** применяется более строгий лимит размеров. Считаются и картинки из прошлых ходов, и вложенные в `tool_result`. Ошибка `invalid_request_error` с «many-image requests»; рекомендация — ≤2000 px по каждой стороне или ≤20 картинок. До 100 изображений на запрос для моделей с окном 200K, 600 для остальных; запрос ≤32 MB [V] — [Claude docs: Vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- Base64-картинки переотправляются байтами на каждом ходу. Docs рекомендуют Files API (`file_id`), чтобы payload не рос [V] — [Claude docs: Vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- **Кэш и картинки:** «Images (adding/removing anywhere in prompt)» инвалидирует уровень messages (tools и system остаются). «Cache hits require 100% identical prefix segments, including all text and images» [V] — [Claude docs: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **Эталонный computer-use loop Anthropic** (`anthropic-quickstarts`, текущая main) [V] — [loop.py](https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/loop.py):
  - `_maybe_filter_to_n_most_recent_images` удаляет старые скриншоты пачками: «for better cache behavior, we want to remove in chunks»;
  - **но при включённом prompt caching** лимит обнуляется: «Because cached reads are 10% of the price, we don't think it's ever sensible to break the cache by truncating images»;
  - 3 breakpoint'а на 3 последних user-хода плюс 1 на system.
- **Claude Code:** при лимите удаляет **пачку** самых старых изображений, одна инвалидация на пачку [V в `02-claude-code-anthropic.md` §B4]
- **Claude Code issue #27869** (2026-02-23, v2.1.50, Chrome MCP) [V, оценки репортёра, не замеры API] — [GitHub](https://github.com/anthropics/claude-code/issues/27869):
  - 18 скриншотов (42–291 KB base64 каждый) составили 64% байтов сессии;
  - ~279K токенов на вызов против ~20K у свежей сессии (~13×); 5 скриншотов → ~80K (4×);
  - предложено держать 2–3 последних и заменять остальные плейсхолдером `[Screenshot from 2h ago — evicted to save context]`;
  - закрыт ботом как «not planned» 2026-05-17 без ответа мейнтейнеров; сообщество использует хуки-стрипперы.
- **cua.ai SDK:** опция `only_n_most_recent_images` автоматически добавляет `ImageRetentionCallback` [U, пересказ поиска] — [cua.ai docs](https://cua.ai/agent-sdk/agent-loops). Оценка из того же поиска: 15 шагов × 1,200 токенов на скриншот = ~144K при полной истории против ~50K при последних 3 [U, вторичный калькулятор] — [apicostcalc](https://apicostcalc.com/computer-use-agent-cost-calculator.html)
- **ReVision** (Abaskohi et al., arXiv 2605.11212, v1 2026-05-11, v3 2026-06-05): вместо выброса целых кадров обученный селектор убирает избыточные патчи между соседними скриншотами. Qwen2.5-VL-7B, 5 скриншотов в истории: −46% токенов, +3% success к варианту без удаления; OSWorld, WebTailBench, AgentNetBench. С простым выбросом старых кадров не сравнивали [V] — [arXiv](https://arxiv.org/abs/2605.11212)

### Inferences
- [calc] Набор скриншотов вашего пайплайна (`shot.mjs` из `13-design-pipeline.md`: 1440 top, full page, 390 mobile, 3 кадра hero) на Claude 4.7+ по формуле docs:
  - 1440×900 → 52×33 = 1,716 токенов;
  - 390×844 → 14×31 = 434;
  - full page 1440×~6000 ужимается до ~618×2576 → 23×92 ≈ 2,116 (текст при такой ширине, вероятно, нечитаем);
  - 3 кадра hero ≈ 5,148;
  - итого ≈9.4K токенов на цикл рендер-критики; 2 цикла ≈19K. Если они висят в истории следующие ~200 вызовов, это ~3.8M входных токенов на страницу только на картинки.
  - Плюс 6 картинок на цикл: к 4-му циклу превышен порог 20 изображений на запрос, и включается строгий лимит размеров (риск ошибки «many-image requests»).
- [inference] Разрешение спора «удалять картинки или беречь кэш» для вас:
  - при ~99% hit и чтении по 0.1× держать картинки дёшево по деньгам, но они продолжают давить на качество (раздел 3) и упираются в лимит 20;
  - при 0% hit картинки надо выбрасывать агрессивно.
  - Практичный вариант — **describe-then-drop на границе шага**: критик или vision-модель пишет текстовый вердикт (замечания, координаты, оценки) в файл; скриншоты в главном контексте заменяются плейсхолдером с путём к файлу; удаление делается пачкой один раз на шаг.
- Для full-page лучше резать на тайлы ≤1568 px или давать только верх и мобильный кадр: ужатая до 618 px полная страница стоит токенов, но вряд ли полезна.

### Gaps
- Не нашёл первичных измерений describe-then-drop (качество против полного хранения картинок) ни у вендоров, ни в статьях. Это предложение основано на плейсхолдерах из issue #27869 и стратегии Manus «restorable compression».
- Формулы токенизации картинок у не-Claude моделей маркетплейса (GPT, Gemini, Qwen-VL, Kimi) в этой сессии не проверял.

## 8. Как строить промпт, чтобы префиксный кэш работал у разных провайдеров, и что его ломает

### Takeaway
Кэш у всех провайдеров — точное совпадение префикса. Порядок слоёв: tools → system → история, статика сначала, динамика в хвост, только дописывание. Ломают кэш:
- timestamps и ID в промпте;
- недетерминированный порядок JSON-ключей и tools;
- смена набора tools, модели, `tool_choice` или параметров thinking;
- добавление или удаление картинок;
- компакция и редактирование истории;
- истечение TTL;
- **маршрутизация на другую машину или поставщика.**

Последний пункт, скорее всего, объясняет ваши 0% у части поставщиков a6api: кэш живёт на конкретной машине или аккаунте поставщика, и шлюз без «липкой» маршрутизации теряет его.

### Cited Findings
- **Anthropic** (текущие docs) [V] — [Claude docs: Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  - иерархия `tools → system → messages`: изменение уровня инвалидирует его и все последующие;
  - инвалидируют: определения tools (всё); web search, citations, speed (system и messages); `tool_choice`, картинки, параметры thinking, effort, выброшенные thinking-блоки (messages);
  - максимум 4 breakpoint'а; минимальная длина 512 токенов (Opus/Sonnet 5.5 и др.) … 4,096 (Opus 4.5/4.6, Haiku 4.5); короче — молча без кэша;
  - TTL 5 мин (обновляется при каждом использовании, отсчёт от начала запроса) или 1 ч;
  - цены: запись 1.25× (5 мин) / 2× (1 ч); чтение 0.1×, но 0.05× для Opus/Sonnet 5.5 и 0.025× для Fable/Mythos 5.1;
  - **lookback 20 позиций**: подряд идущие `tool_use` считаются одной позицией, подряд идущие `tool_result` — тоже. Если ход добавил ≥20 блоков, следующий запрос не найдёт прошлую запись. Для агентных циклов нужен второй breakpoint;
  - automatic caching (top-level `cache_control`) ставит breakpoint на последний блок. Ловушка: при изменчивом суффиксе (timestamps, per-request контекст) он попадёт на меняющийся блок;
  - на поддерживаемых моделях `{"role":"system"}` внутри `messages` меняет инструкции **без** инвалидации;
  - изоляция кэша: по организации, на Claude API ещё и по workspace;
  - «If a side agent or user pause can exceed 5 minutes, use the 1-hour TTL».
- **OpenAI** (текущие docs) [V] — [OpenAI docs: Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching):
  - кэш автоматический, минимум 1,024 видимых токена (GPT-5.6+);
  - «Cached states live on individual machines»; трафик **>15 запросов в минуту** на префикс вызывает overflow-маршрутизацию; маршрут — хэш начальных токенов, включая tool definitions;
  - `prompt_cache_key` до GPT-5.6 помогает собрать связанные запросы на одну машину (~15 RPM на ключ), но «doesn't pin requests to a machine or guarantee a hit»;
  - retention `in_memory` ~5–10 мин простоя (до 1 ч), `24h`; у GPT-5.6+ минимум 30 мин или 12 ч;
  - скидка «up to 95%»; на GPT-5.6+ чтение 0.1× (0.05× у GPT-6.1 Sol);
  - явные breakpoints `prompt_cache_breakpoint` только на GPT-5.6+, до 4 записей на запрос;
  - `text.format` (схема structured output) входит в префикс;
  - до GPT-5.5 cached tokens округляются вниз до кратного 128.
- **DeepSeek** [V] — [DeepSeek API docs: KV cache](https://api-docs.deepseek.com/guides/kv_cache):
  - дисковый кэш, включён по умолчанию;
  - hit только при полном совпадении «cache prefix unit». Юниты сохраняются в конце user input, в конце вывода модели и с фиксированным шагом. Пример: после A+B запрос A+C — промах;
  - best-effort, «does not guarantee a 100% hit rate»; очистка через «a few hours to a few days»;
  - поля usage `prompt_cache_hit_tokens` и `prompt_cache_miss_tokens`.
- **Мультипровайдерный шлюз — механика OpenRouter** [V] — [OpenRouter docs: Prompt caching](https://openrouter.ai/docs/features/prompt-caching):
  - **provider sticky routing**: после кэшированного запроса следующие запросы той же модели идут к тому же поставщику; сессия истекает после 10 мин простоя;
  - включается только если чтение кэша у поставщика дешевле обычного input; не используется при явном `provider.order`;
  - ключ группировки — хэш первого system/developer и первого не-system сообщения, либо `session_id` (тело или `x-session-id`, ≤256 символов);
  - после ошибки sticky-поставщика запрос перемаршрутизируется;
  - множители чтения: Anthropic 0.1× (запись 1.25×/2×), DeepSeek 0.1×, Gemini implicit 0.25× (TTL «3-5 minutes», минимум 1024 Flash / 4096 Pro), Grok 0.25×, Moonshot 0.25×, Groq (Kimi K2) 0.5×, Alibaba Qwen только explicit (1.25×/0.1×, 5 мин), Z.AI ~0.2×;
  - диагностика: `prompt_tokens_details.cached_tokens`, `cache_write_tokens`, `cache_discount`.
- **«Don't Break the Cache»** (Lumer et al., PwC; arXiv 2601.06007, v1 2026-01-09, v2 2026-01-31; DeepResearch Bench) [V] — [arXiv HTML v2](https://arxiv.org/html/2601.06007v2):
  - экономия стоимости / улучшение TTFT по стратегиям:

    | Модель | Full context | System prompt only | Excl. tool results |
    |---|---|---|---|
    | GPT-5.2 | 79.3% / 9.5% | 81.4% / 10.5% | 79.6% / 13.0% |
    | Claude Sonnet 4.5 | 77.8% / 21.8% | 78.5% / 22.9% | 78.1% / 20.9% |
    | Gemini 2.5 Pro | 38.3% / 6.0% | 41.4% / 6.1% | 27.8% / −2.9% |
    | GPT-4o | 47.8% / −8.8% | 45.9% / 30.9% | 46.8% / 28.1% |

  - «naively enabling full-context caching can paradoxically increase latency» из-за записей кэша для контента, который не переиспользуется;
  - ломают кэш timestamps, session ID и user-данные в system prompt, динамические tool definitions («any change to the available tool set invalidates the cached prefix»);
  - регрессия TTFT у промптов ~500 токенов (ниже минимума);
  - расхождение в самой статье: в аннотации TTFT 13–31%, в таблице и §4.1 — 6–31%.
- **Claude Code** — реальные поломки кэша: точный timestamp, недетерминированный порядок tool definitions, изменение параметров tool; правила «static first / dynamic last», не менять модель и tools посреди сессии, шлюз, вырезающий `cache_control`, переводит всю историю в uncached [V в `02-claude-code-anthropic.md` §B1–B2]
- **Pi** — `cacheControlFormat:"anthropic"` автодетектится только для openrouter + `anthropic/*`; для произвольного relay compat надо прописывать явно; `prompt_cache_key=sessionId` только для api.openai.com [V в `01-pi.md` §B8]
- Цена cache-blind шлюза: Factory 2.12–2.37× (ходы 61–200); Cline: один и тот же eval $20 против $43 в зависимости от маршрута [V в `08-practitioners-research.md` §B1]

### Inferences
- [inference] Вероятные причины 0% hit у части поставщиков a6api (проверять по `cached_tokens` в каждом ответе):
  - (а) шлюз или поставщик балансирует запросы по разным аккаунтам, регионам или машинам: у OpenAI кэш машинно-локальный, у Anthropic изолирован по организации и workspace, у DeepSeek best-effort;
  - (б) для Claude теряется `cache_control`: Pi не шлёт его на неизвестный relay, или шлюз его вырезает;
  - (в) поставщик кэш не поддерживает или не тарифицирует;
  - (г) Pi схлопывает mid-convo system в ведущее сообщение (`openai-completions`), что меняет префикс;
  - (д) пауза >5 мин (рендер, генерация картинок, человек) при TTL 5 мин у Anthropic и TTL 3–5 мин у Gemini implicit.
- [inference] Требования к шлюзу:
  - липкая маршрутизация по `session_id` (как у OpenRouter) или фиксация поставщика на сессию;
  - проброс `cache_control` и `prompt_cache_key`;
  - отдача `cached_tokens`;
  - при отсутствии липкости — явный pin поставщика с ~99% hit для длинных сессий.
- [inference] Правила сборки контекста для Pi-сессии:
  1. system prompt и список tools неизменны всю сессию: без дат, ID и счётчиков; tools в детерминированном порядке; JSON с отсортированными ключами;
  2. динамика (текущий шаг, todo, бриф) только дописывается в хвост как user или custom message;
  3. не менять модель, `tool_choice`, thinking и effort внутри сессии; модель меняется только на границе шага или сброса, где кэш теряется всё равно;
  4. маскирование tool outputs и картинок — пачками с порогом (как `clear_at_least`), не каждый ход;
  5. для Claude — breakpoint на конце статики плюс автоматический или скользящий на хвосте; второй breakpoint, если ход добавляет ≥20 блоков;
  6. TTL 1 ч, если между вызовами бывают паузы >5 мин.
- Результат «Don't Break the Cache» о том, что system-only кэширование лучше full-context, получен на DeepResearch Bench, где tool results не переиспользуются между сессиями. В append-only агентном цикле каждый следующий вызов переиспользует весь предыдущий префикс, и full-context кэш должен окупаться. Переносить этот вывод на ваш пайплайн напрямую нельзя.
- [calc] Латентность: кэш сокращает только prefill. Измеренный выигрыш TTFT 6–31% (2601.06007) — не кратный. Из 16–38 с на вызов заметную часть, вероятно, занимает генерация вывода, поэтому уменьшение самого контекста (разделы 5–7) нужно для скорости не меньше, чем кэш.

### Gaps
- Публичной документации a6api.com о маршрутизации, липкости, пробросе `cache_control` и `prompt_cache_key` не нашёл (специально не искал из-за лимита вызовов; вероятно, её нет в открытом доступе). Нужно спросить вендора или проверить экспериментом.
- Размер prefix unit у DeepSeek (часто упоминается «64 токена») на текущей странице docs не указан, поэтому не подтверждён.
- Данных о латентности prefill в зависимости от доли кэша для конкретных моделей маркетплейса нет. Нужен собственный замер: TTFT при холодном и горячем кэше на 150K.
