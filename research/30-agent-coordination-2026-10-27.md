# Исследование: вызов и координация coding-агентов

Дата обращения к источникам: 2026-10-27. Область: публичные первичные источники — официальные README и документация; отдельные материалы проекта дополнительно разбирают код. Ссылки на ветки меняются со временем и не закреплены за коммитом. Приведённые сильные и слабые стороны и критерии — экспертные предположения, не результаты сравнительного теста. Платные запросы и живые прогоны моделей не запускались. Код PRSLOY и архитектура в рамках этого исследования не менялись.

## Короткий вывод

Для PRSLOY не нужен общий «swarm» из параллельных писателей. Наиболее надёжная схема:

1. один ведущий агент владеет изменениями;
2. короткие read-only подзадачи исследуют код или собирают факты в отдельных контекстах;
3. отдельный проверяющий получает чистый контекст, diff и фактические результаты тестов;
4. проверки и права держатся кодом, а не только инструкцией модели;
5. каждая задача имеет бюджет, лимит продолжений, отмену и сохраняемый handoff;
6. параллелить можно исследование, независимые проверки и разные файлы, но не несколько писателей в один рабочий каталог.

Главный практический риск PRSLOY сейчас не в отсутствии многосессионности: сначала нужно закрыть P0/P1 #79, #76, #78 и #73. Иначе новые агенты добавят ещё одну очередь событий, ещё один источник compaction и ещё одну границу изоляции.

## Таблица сравнения

| Проект | Источник | Проверенный факт | Сильная сторона | Слабая сторона | Что применимо к PRSLOY |
|---|---|---|---|---|---|
| **Pi** | [README](https://github.com/earendil-works/pi); [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md); [durable](https://github.com/earendil-works/pi/tree/main/packages/durable) | MIT; расширения, skills, RPC/JSON/SDK и durable-пакет; встроенных sub-agents и plan mode нет | Минимальное расширяемое ядро, append-only сессии и хорошие точки guardrail | Права, sandbox, subagents и plan workflow надо строить снаружи; без ограничения bash опасны зависания | Оставить Pi исполнительным ядром. Роли, budget guard, reviewer, handoff и политики делать вокруг него; не переписывать agent loop до замеров |
| **OpenCode** | [agents](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx); [permissions](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx); [tools](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/tools.mdx) | Есть primary agents Build/Plan и subagents General/Explore; Plan ограничивает изменения; permission принимает allow/ask/deny; есть лимит steps | Простая модель ролей и прав, которую легко объяснить пользователю | Subagent не равен полноценной независимой сессии; параллельные изменения всё равно требуют владения файлами | Взять форму `role + tool policy + max steps`; Plan должен быть read-only и сохранять артефакт, а не надеяться на prompt |
| **Claude Code** | [subagents](https://docs.anthropic.com/en/docs/claude-code/sub-agents); [agent teams](https://docs.anthropic.com/en/docs/claude-code/agent-teams); [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks); [security](https://docs.anthropic.com/en/docs/claude-code/security) | Subagent имеет свой context window, prompt, tools и permissions; teams имеют lead, общую task list и сообщения; команды experimental и имеют ограничения resume/shutdown | Сильное разделение focused subagent и team; hooks могут блокировать действие; чистый контекст ревью | Teams дороже по токенам, resume и shutdown не полностью надёжны; код Claude Code проприетарный | Перенять только идеи: focused subtask → summary, lead → task ledger, Pre/Post/Stop hooks, reviewer без контекста автора. Не копировать код и не зависеть от Claude Code |
| **Codex CLI** | [repo](https://github.com/openai/codex); [app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md); [sandbox](https://github.com/openai/codex/blob/main/docs/sandbox.md) | Apache-2.0; единое Rust-ядро и JSON-RPC app-server; thread/turn/item протокол; approvals и sandbox; stop hooks; world-state diffs; durable thread/read state | Ясный протокол между UI и ядром, детерминированные события, approval/cancel и диффы состояния | Основной wire API — Responses, не Chat Completions; multi-agent и некоторые функции зависят от экосистемы OpenAI | Взять `Thread → Turn → Item`, revision/read-state, expectedTurnId при steer, world-state diff, явные причины остановки и approval как запрос ядра к UI |
| **Gemini CLI** | [README](https://github.com/google-gemini/gemini-cli); [subagents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md) | Open-source CLI; subagents имеют отдельный context loop, prompt и tools; built-in investigator/CLI help/generalist; настройки задают model и maxTurns | Хорошая модель специализированного подагента с возвратом только результата в основной контекст | В README сообщает о замене Gemini CLI на Antigravity CLI 18.06.2026 для бесплатного уровня и пользователей Google One; поэтому это не следует считать стабильной продуктовой целью | Перенять декларативные `purpose/model/maxTurns` и автоматический или явный dispatch; не привязывать PRSLOY к продуктовой судьбе Gemini CLI |
| **Harness² / Google Research** | [repo](https://github.com/google-research/harness2); [paper](https://arxiv.org/abs/2610.14224) | Apache-2.0; делит harness на system prompt, guardrails, memory, tool guidance, subagents, skills, scripts, plugins; Propose → Probe → Compose | Доказательный способ улучшать harness по контрастам трасс, а не по ощущениям; always-on текст считается дорогим | Оффлайн-тюнинг требует много прогонов и не доказывает корректность результата; не подходит как онлайн swarm | Взять правило «сначала измерить», preference `skill/script/plugin` над длинным always-on prompt и запрет на урок без наблюдаемого evidence |
| **OpenHands** | [SDK README](https://github.com/OpenHands/software-agent-sdk); [Canvas README](https://github.com/All-Hands-AI/OpenHands/blob/main/README.md) | SDK MIT; есть Python/TypeScript/REST, Agent/Conversation/Workspace/Tools; Canvas запускает разные backends, Docker per conversation, automation | Сильная изоляция conversation/workspace и возможность продолжать работу на сервере; понятный event/server слой | Без sandbox агент получает полный доступ к машине; одинаковая host-папка всё ещё создаёт конфликты; отдельная инфраструктура тяжёлая | Взять workspace identity, conversation-scoped runtime, event log и «секрет через UI». Для Windows desktop начать с process/worktree isolation, не с Docker-зависимости |
| **Cline** | [README](https://github.com/cline/cline); [docs](https://docs.cline.bot) | Open-source CLI, desktop и IDE; human-in-the-loop approval; MCP; scheduled routines в desktop; Apache-2.0 (проверять текущий LICENSE при копировании) | Хорошая видимая граница «агент предлагает — человек подтверждает», удобный IDE/desktop поток | Большая поверхность функций и зависимость качества от provider route; параллельные авторы не решают конфликт общего дерева | Взять granular approval, mistake/loop limit и visible tool timeline; не тащить всю IDE-поверхность |
| **Roo Code** | [README](https://github.com/RooCodeInc/Roo-Code) | README сообщает, что расширение закрыто 15.05.2026; перечисляет Code/Architect/Ask/Debug/Custom modes; Apache-2.0 | Хорошая форма пользовательских режимов и вопросов с вариантами | Проект закрыт, значит свежесть и поддержка не гарантированы; не считать активным эталоном | Только идея modes и ask-with-options; код не брать без отдельной проверки лицензии и происхождения |
| **Aider** | [usage](https://aider.chat/docs/usage.html); [repo](https://github.com/Aider-AI/aider) | Pair-programming в терминале; repo map; пользователь добавляет только нужные файлы; git commit и undo; lint/test после правок; подключает разные LLM | Простая дисциплина контекста: не отправлять весь репозиторий; прозрачный diff и undo | Это в первую очередь один агент; нет полноценной координации ролей и изоляции нескольких writers | Взять scoped context, repo map, автоматический checkpoint и обязательную проверку после edit; не превращать каждую мелкую задачу в команду агентов |
| **Goose** | [README](https://github.com/aaif-goose/goose); [docs](https://goose-docs.ai/docs) | Apache-2.0; Rust desktop/CLI/API; 15+ providers; MCP extensions; общий агент для code, research и automation; входит в AAIF | Единая модель «агент как сервис» и расширения через открытый протокол | Широкая универсальность увеличивает поверхность прав и настроек; README не даёт готовой гарантии изоляции writers | Взять ACP/MCP-совместимый boundary и diagnostics, но права и sandbox держать PRSLOY-кодом |
| **OpenCode forks / Pi forks** | [OpenCode agents](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx); [Pi packages](https://github.com/earendil-works/pi/tree/main/packages) | Fork полезен только если меняет измеримый провал; сам факт fork не доказывает качество или активность | Можно быстро проверить альтернативные compaction, edit и background-task решения | Риск расхождения API, скрытой provider-логики и несовместимых лицензий | Сравнивать forks по коммиту, тестам, лицензии и воспроизводимому eval; не включать fork как зависимость без отдельного решения |

## Сравнение по ключевым вопросам

### 1. Один агент, подагенты, роли, параллельность

- **Один агент** лучше для последовательной задачи с общими файлами и частыми решениями.
- **Подагент** нужен для bounded side-task: большой вход, маленький ответ — например, найти места в коде, сравнить два API, составить список рисков. Основной агент получает summary, а не весь transcript.
- **Роль** должна быть контрактом: `purpose`, `model`, `tools`, `permissions`, `maxSteps`, `output schema`, `workspace ownership`.
- **Команда** оправдана только когда задачи действительно независимы и нужен обмен гипотезами. Она дороже и сложнее resume/shutdown.
- Для PRSLOY безопасный default: один writer + read-only исследователи + независимый reviewer. Параллельные writers — только разные worktree и явный владелец каждого файла.

### 2. Контекст, summary, compaction, handoff

Проверяемый общий паттерн у Pi/Codex/Claude Code/OpenCode: сохранять не красивый пересказ, а рабочий checkpoint. Минимальные поля handoff:

- цель и критерии готовности;
- что сделано и подтверждено командой;
- изменённые файлы и важные функции;
- решения и ограничения;
- открытые ошибки с точным сообщением;
- следующий шаг, владелец и причина, почему он ещё не сделан;
- бюджет и число оставшихся попыток.

Summary должен быть частью durable session state, а не только последним сообщением UI. Нельзя считать `agent_end` окончанием: retry, compaction и queued follow-up могут продолжить работу. Финальный сигнал должен быть отдельным `settled/aborted/failed` с причиной.

Для PRSLOY это особенно важно из-за #76: compaction активной дорогой моделью уже вызвал storm. До исправления нельзя добавлять новые автоматические continuation-пути.

### 3. Изоляция проектов, диалогов и событий

Надёжная единица — не «модель», а `project + conversation/thread + run/turn`. Каждое событие должно иметь как минимум:

`projectId, conversationId, turnId, itemId, agentId, parentId, sequence, timestamp, state`.

Смена проекта не должна менять только UI-состояние: она должна создавать новый runtime context и заново вычислять memory scope. Это прямо связано с #73. Переключение чата должно отбрасывать поздние события старого `conversationId`, а не пытаться склеивать их по времени.

### 4. Инструменты, права, подтверждения, остановка

- Allow/ask/deny должны применяться кодом, с последним подходящим правилом и явным объяснением отказа.
- Approval — это запрос ядра к UI с `requestId`, `turnId` и сроком действия; ответ должен проверяться на совпадение текущего запроса.
- Stop должен быть идемпотентным и останавливать stream, subprocess, queued continuation и дочерние агенты.
- Таймаут и отмена должны возвращаться модели как структурированная ошибка, но не запускать бесконечный retry.
- Репозиторные инструкции — данные проекта, а не доверенная политика. Они не могут расширять права или отключать sandbox.

### 5. Планирование, выполнение, ревью, тесты

Лучший переносимый процесс — не «пять агентов пишут», а ворота:

`brief/plan → bounded implementation → deterministic checks → clean-context review → final status`.

Проверяющий не должен получать уверенный финальный текст исполнителя: он видит diff, исходный критерий и факты запуска. Сильная модель проверяет слабую; слабый reviewer может ухудшить результат. Если проверка не запускалась, UI пишет «не проверено», а не «готово».

### 6. Лимиты, стоимость, повторы и циклы

Нужны независимые лимиты:

- max turns / tool rounds;
- max wall time;
- max input/output tokens;
- max money for run and child agents;
- max retries per error class;
- max same `(tool, normalized args, output fingerprint)` repetitions;
- max continuation after stop-gate.

Повторять безопасно только idempotent/read-only операции и сетевые ошибки с подтверждённым retry policy. После повторяющейся ошибки: один targeted nudge, затем остановка или человек. Compaction не должен считаться бесплатным: его стоимость и модель должны быть отдельными в ledger.

### 7. UI, логи и наблюдаемость

Пользователю нужны не внутренние рассуждения, а понятные карточки:

- кто сейчас работает и над какой подзадачей;
- что изменилось;
- сколько стоит/занимает текущий ход;
- какая проверка уже прошла;
- почему остановились;
- кнопки `Остановить`, `Продолжить`, `Откатить`, `Показать журнал`.

Журнал должен хранить полные события и tool output вне prompt с preview и ссылкой на файл. Для диагностики #79 нужны sequence gaps, duplicate item IDs, late events и смешивание conversation IDs — без публикации текста личной сессии.

## Предложения для PRSLOY

Приоритеты ниже — рекомендации к будущим задачам, не разрешение внедрять их сейчас.

| Приоритет | Улучшение | Критерий успеха |
|---|---|---|
| **P0 после блокеров** | **Durable execution contract:** ввести проверяемую модель `project → conversation → turn → item` и единый terminal state | Синтетический тест с двумя чатами, быстрыми фрагментами, late events и restart: 0 смешанных ответов, 0 потерянных terminal events; закрывает #79-класс |
| **P0 после #76** | **Безопасная compaction policy:** local/deterministic summary как первый путь; отдельная дешёвая модель только с лимитом; запрет compaction/continuation storm | Тестовая сессия с искусственным overflow делает не более 1 compaction на границу, не вызывает активную дорогую модель для summary, бюджет не уходит в отрицательное значение |
| **P0 после #73** | **Project-scoped context capsule:** project identity вычисляется один раз на runtime и передаётся memory/session/events слоям | Сквозной тест A→B→A: память A не видна B, A возвращается; параллельные открытые чаты не меняют scope |
| **P0** | **Один writer + read-only workers:** worker contract с `taskId`, `parentId`, input refs и структурированным handoff | На 20 синтетических задачах reviewer получает только handoff и нужные ссылки; основной контекст не растёт полным transcript; 0 конфликтов записи |
| **P0** | **Independent verification gate:** reviewer другой сессии/семейства получает diff, критерии и факты тестов, без финального текста исполнителя | На наборе провокаций ревьюер обнаруживает ≥90% заранее размеченных подмен тестов/заглушек; обычные задачи не дают устойчивого роста ложных отказов |
| **P1** | **Unified budget ledger:** деньги, input/output/cache tokens, turns, wall time и child-agent cost в одном run ledger | 100% дочерних вызовов имеют parent run; сумма стоимости в UI совпадает с gateway log; остановка происходит до превышения заданного бюджета с погрешностью не более одного ответа |
| **P1** | **Policy/approval engine:** allow/ask/deny по tool + аргументам + пути; approval request с requestId и expiry | Набор опасных команд/чужих программ/секретов блокируется кодом в 100% тестов; репозиторный prompt не может изменить policy |
| **P1** | **Loop and retry guard:** fingerprint аргументов и результата, один nudge, затем stop/escalate | В задачах с одинаковым tool-call цикл останавливается не позднее 3 повторов; polling с меняющимся результатом не блокируется; retry не повторяет неидемпотентную запись |
| **P1** | **Durable handoff и resume:** handoff хранится рядом с thread state и проверяется при продолжении | После принудительного завершения и restart агент продолжает с последнего подтверждённого шага, не повторяет уже подтверждённую правку и показывает открытый blocker |
| **P2** | **Task room UI:** небольшая панель ролей, статусов, бюджета, событий и stop controls без показа внутреннего reasoning | В usability-прогоне пользователь без терминала за ≤10 секунд понимает, кто работает, что проверено и как остановить; все события фильтруются по текущему conversation |

## Что не делать сейчас

1. Не запускать parallel writers в общей папке.
2. Не добавлять teams/swarm поверх неисправной очереди событий.
3. Не включать автоматический reviewer/continuation, пока #76 не закрыт и #78 не зелёный.
4. Не менять модель для compaction без отдельной записи стоимости и теста на восстановление контекста.
5. Не брать код Claude Code или закрытого Roo Code; использовать только идеи и проверять лицензии каждого конкретного файла.
6. Не считать популярность по SEO или числу forks доказательством качества.

## Блокирующее состояние PRSLOY на дату исследования

- **#79 P0:** ранее сообщалось об обрезании или смешивании ответов; сначала нужна проверка доставки и сборки событий.
- **#76 P0:** ранее сообщалось о цикле compaction/continuation и расходе баланса; сначала нужны ограничение цикла и безопасная политика compaction.
- **#78:** ранее отмечался как красный; актуальное число падающих тестов в этом исследовании не перепроверялось. До зелёного нельзя считать поведение harness стабильным.
- **#73:** ранее сообщалось о смешивании памяти проектов; до проверки исправления нельзя строить новые project/session workers.

Статус этих четырёх проблем в текущем дереве независимо не проверялся: это входные ограничения исследования, а не утверждение о сегодняшнем результате тестов. Числовые цели выше предложены для будущих испытаний и не являются замерами.

Следующий шаг после закрытия блокеров — не реализация всего списка, а отдельная бесплатная проверка на синтетических задачах: handoff, isolated reviewer, loop guard и budget ledger. Каждая функция включается только после сравнения до/после.
