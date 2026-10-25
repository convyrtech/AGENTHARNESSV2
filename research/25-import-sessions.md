# 25 — Перенос сессий и настроек из других агентов (срез 2026-10-25)

Вопрос владельца: при первом запуске перенести локальные сессии из Claude Code, OpenCode, Codex и всего, что
получится. «У Hermes, наверное, это есть». Выбрать разумный путь и встроить.

**Обозначения**
- **[V]** — открыл первоисточник сам: код, официальную документацию, наш файл, свой прогон.
- **[V-вторич.]** — видел в чужом открытом коде или README, который описывает третий инструмент (например,
  просмотрщик описывает, где лежит Kilo). Сам первоисточник не открывал.
- **[U]** — не проверено, оценка или мой вывод.

**Пути**
- `MR/` = `/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/mr/imp/`. Shallow-клоны от
  2026-10-25, только как данные, код не запускался. Коммиты — в «Источниках».
- `S25/` = `/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/s25/` — мои пробы Pi SDK.
- Пути без префикса — от `/home/user/agentharnessv2/`.
- Чужие транскрипты я не читал. Структуру Claude Code смотрел на транскриптах этой же облачной сессии: только
  типы записей, имена ключей и размеры, без текста.

---

## 0. Коротко

1. Чаты чужих агентов переносят **Codex** (`/import`: Claude Code, Cursor), **Cline SDK** (Claude Code, Codex, opencode) и **Goose** (файл Claude Code, Codex, Pi); всё Apache-2.0 [V].
2. **Hermes чаты не переносит**: берёт CLAUDE.md / AGENTS.md в память, правила Bash, MCP, навыки. Claude Code `/import` — тоже только настройки [V].
3. Основа для нас — адаптеры **Cline на TypeScript** и правила Codex: 30 дней, до 50 чатов, журнал с хэшем, только текст [V].
4. Новичку полезнее всего **папки проектов** и **недавние чаты, которые можно продолжить**. Навыки и MCP — мало пользы, много риска [U].
5. Чат пишем обычной сессией Pi: вся история на экране, а модели — `compaction` (пересказ кодом + хвост) и `model_change` на PRSLOY. Проверено на Pi 1.4 [V, S25].
6. Чужие форматы не документированы и меняются: у OpenCode три схемы за 2026 год, Codex жмёт старые файлы в `.jsonl.zst`, Gemini ушёл с `.json` на `.jsonl` [V].
7. Поэтому: фикстура на каждый формат, «не понял схему — пропусти»; P1 — Claude Code, Codex, Pi CLI.
8. Только чтение: ничего не запускаем, не меняем, не отправляем; `scrubSecrets` до записи; в память — только кандидаты из слов пользователя.

---

## 1. Как у других

### 1.1 Кто что переносит

| Кто | Что переносит | Чаты? | Как спрашивает | Лицензия, дата | Что берём |
|---|---|---|---|---|---|
| **Codex CLI** `/import` | Настройки, навыки, AGENTS.md (из CLAUDE.md), плагины, MCP, субагенты, хуки, команды, память, **сессии**. Источники: Claude Code и Cursor | **Да.** Последние 30 дней, до 50 штук. Только текст: вызов инструмента — пометка в тексте ≤2000 знаков, результат ≤4000, размышления выбрасываются. В конце метка `<EXTERNAL SESSION IMPORTED>`. Папка проекта должна существовать | Экран «Import setup»: три группы с галочками и счётчиками («Tools & setup», «Current project», «Chat sessions (1) — Last 30 days of chats»), «Customize selection». «Your existing setup will not be changed» | Apache-2.0, © 2025 OpenAI; код 2026-10-23 [V] | Лимиты, журнал, порядок названий, список обёрток, текстовые пометки инструментов, вид экрана |
| **Cline SDK** `session-import` | Только сессии: Claude Code, Codex, opencode | **Да.** В формат Cline с инструментами. Подпись размышлений и инструментов срезается. Пары «вызов — результат» чинятся заглушками | Диалог «Import sessions»: поиск по названию и папке, «выбрать все», уже перенесённые помечены. Вверху чата: «Imported from X… the model works from a summary of them rather than the original tool calls» | Apache-2.0, © 2026 Cline Bot Inc.; код 2026-10-23 [V] | Почти весь разбор Claude Code и Codex (TS), снимок SQLite, защита от дублей, откат при сбое |
| **Goose** Desktop | Файл сессии: свой JSON, Claude Code JSONL, Codex rollout, Pi JSONL | **Да**, по одному файлу, новый id | Кнопка «Import Session», выбор файла | Apache-2.0, © 2024 Block; код 2026-10-24 [V] | Распознавание формата по первой строке; чистка невидимых Unicode-тегов |
| **Hermes** `agent-importers` | Claude Code, Codex, Cursor, OpenClaw: CLAUDE.md / AGENTS.md / правила Cursor / `memories/*.md` → записи памяти; `Bash(...)` → allowlist; MCP → конфиг; навыки копируются; `commands/*.md` пропускаются | **Нет** | `hermes setup` проверяет `~/.claude`, `~/.codex`, `~/.cursor`, `~/.openclaw`: «Coming from another agent?» → чек-лист (все отмечены) → предпросмотр → подтверждение. `--dry-run`, бэкап `MEMORY.md` | MIT, © 2026 Nous Research; плагин 2026-10-24 [V] | Предпросмотр, «файлы с ключами не читать», вырезание секретных env и заголовков MCP, разбивка markdown на записи |
| **Claude Code** `/import codex\|gemini\|cursor` | Инструкции, MCP, команды, субагенты, навыки | **Нет** | Пикер, `--dry-run`, `--yes`; `/init` сам предлагает перенос | Проприетарно; официальные docs 2026-10-25 [V] | Только идея |
| **OpenCode** | `opencode session import <файл или ссылка>` — только свой экспорт. Читает `CLAUDE.md`, `~/.claude/CLAUDE.md`, `~/.claude/skills` как запасные | Только свои | — | MIT; код 2026-10-25, docs [V] | Идея «читать чужие правила на месте» |
| **Cursor** | Грузит навыки из `~/.claude/skills`, `~/.codex/skills` и проектных `.claude/skills`, `.codex/skills` | Нет | — | Проприетарно; docs [V] | — |
| **Crush** | Читает чужие файлы правил на месте: `.cursorrules`, `.cursor/rules/`, `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `copilot-instructions.md` | Нет | — | FSL-1.1-MIT — **только идеи** [V] | — |
| **Pi 1.4** | `/import <path>` — только JSONL Pi; в SDK `importFromJsonl()` | Только свои | — | MIT [V] | Сессии Pi CLI переносим копией |

### 1.2 Просмотрщики и счётчики (только читают)

| Что | Источников | Язык | Лицензия | Польза нам |
|---|---|---|---|---|
| **ccusage** | 18: Claude Code, Codex, OpenCode, Amp, Droid, Hermes, Pi, Goose, Kilo, Qwen, Copilot CLI, Gemini… | Rust | MIT [V] | Только токены и деньги. Хороший список путей и переменных окружения |
| **claude-code-history-viewer** | 31 | Rust (Tauri) | MIT [V] | Таблица путей; разбор Cursor `state.vscdb`, семейства Cline, Zed, Continue, Aider |
| **SpecStory CLI** | 15, в Markdown `.specstory/history/` | Go | Apache-2.0 [V] | Своя единая схема сессии (`docs/SPI-SESSION-DATA-SCHEMA.md`); кодировщик папок Claude Code |
| **agent-sessions** | 16 | Swift, macOS | MIT [V] | Поиск и «продолжить в терминале» |
| **agentsview**, **ai-sessions-mcp**, **tokscale**, **splitrail**, **cchistory** | 6–20 | Go / Rust / TS | MIT [V] | tokscale подтверждает `.jsonl.zst` у Codex; cchistory — команды из Claude Code |

**Не проверял:** Continue, AnythingLLM, Jan, Cherry Studio (AGPL), Chatbox (GPL) как импортёры. Это чат-приложения,
не агенты для кода. Zed (GPL) хранит треды в SQLite, импорта чужих чатов я не нашёл [U].

**Вывод.** «Как у Hermes» — это перенос настроек. Перенос чатов есть у Codex, Cline и Goose. Нам ближе всего
Cline: тот же язык, тот же подход «найти дёшево, разобрать при переносе».

---

## 2. Где что лежит

Windows — первым. `~` = `%USERPROFILE%`, если не сказано иначе. Стабильность: **док** — формат описан и
версионирован; **полу** — типы в открытом коде, файл не описан; **внутр.** — внутренний, меняется без
предупреждения; **обр.** — разобран обратной разработкой.

| Инструмент | Windows | macOS / Linux | Формат | Суть схемы | Стабильность | Источник |
|---|---|---|---|---|---|---|
| **Claude Code** | `%USERPROFILE%\.claude\projects\<slug>\<session-id>.jsonl`, или под `%CLAUDE_CONFIG_DIR%` | `~/.claude/projects/...` | JSONL событий | `type`: user / assistant / attachment / system / summary / ai-title / custom-title / last-prompt / mode / cost-state… Дерево `uuid` → `parentUuid`. `message.content` — блоки Anthropic: text, thinking, tool_use, tool_result, image. На строке: `cwd`, `gitBranch`, `timestamp` (ISO), `version`, `isSidechain`, `isMeta`, `isCompactSummary`. Один ответ модели идёт несколькими строками с общим `message.id`. Модель — `message.model` (`<synthetic>` = локальная заглушка). Субагенты — `<session>/subagents/` | **внутр.** Docs описывают, что внутри, но не схему. Видел версии 2.1.308–2.1.310 | docs «.claude directory» [V]; структура на своих файлах [V] |
| ↳ рядом | `history.jsonl` — набранные промпты с временем и путём проекта; `projects/<slug>/memory/*.md` — авто-память (пишет Claude); `~/.claude.json` — MCP, аккаунт, состояние проектов | то же | JSONL / MD / JSON | Транскрипты удаляются через `cleanupPeriodDays`, **по умолчанию 30 дней**; память — нет | док (назначение) | docs [V] |
| **Codex CLI** | `%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-<ts>-<uuid>.jsonl` и **`.jsonl.zst`**; `archived_sessions\`; `session_index.jsonl` (названия); `history.jsonl`. Корень — `%CODEX_HOME%` | `~/.codex/...` | JSONL, частично zstd | Строка `{timestamp, type, payload}`: `session_meta` (id, cwd, git), `turn_context` (model, cwd), `event_msg` (user_message, agent_message, token_count), `response_item` (message user/assistant, reasoning, function_call / custom_tool_call и их output), `compacted`. Возобновлённый тред пишет новый файл с тем же id | **полу.** Код сжимает файлы старше 7 дней (`rollout/src/compression.rs`); живое включение подтверждает tokscale | код [V]; tokscale [V-вторич.]; docs про хранение молчат [V] |
| **Gemini CLI** | `%USERPROFILE%\.gemini\tmp\<shortId>\chats\session-<ts>-<id>.jsonl` (раньше `.json`, папка по sha256 пути); реестр `projects.json`, в папке `.project_root`. Корень — `%GEMINI_CLI_HOME%` | `~/.gemini/tmp/...` | JSONL с патчами | `ConversationRecord`: sessionId, projectHash, startTime, lastUpdated, messages[{id, timestamp, type: user / gemini / info / error, content (Part[]), toolCalls[{name, args, result, status}], thoughts, tokens, model}]. Записи `$set` / `$patch` / `$rewindTo` | **внутр.** Docs называют только папку | код 2026-10-23, docs [V] |
| **OpenCode** | `%USERPROFILE%\.local\share\opencode\opencode.db` (+ `opencode-<канал>.db`; `%OPENCODE_DB%`, `%XDG_DATA_HOME%`); до 2026 — дерево `storage\` из JSON | `~/.local/share/opencode/...` | SQLite (WAL) | Сейчас `session_v2` (directory, title, model JSON, time_*) и `session_message` (type, seq, data JSON: user / assistant / tool / text / reasoning / compaction). До этого `session` / `message` / `part` | **внутр.**: 52 миграции с 2026-01-27 по 2026-10-24 | код [V]; Windows-путь в их скрипте `C:/Users/…/.local/share/opencode` [V] |
| **Cursor IDE** | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`; старые — `workspaceStorage\<hash>\state.vscdb` | `~/Library/Application Support/Cursor/User/…`, `~/.config/Cursor/User/…` | SQLite KV | `cursorDiskKV`: `composerData:<id>`, `bubbleId:<composerId>:<bubbleId>`; старое — `ItemTable` `composer.composerData` | **обр.** | claude-code-history-viewer [V-вторич.] |
| **Cursor Agent / CLI** | `%USERPROFILE%\.cursor\projects\<enc>\agent-transcripts\**\*.jsonl` | `~/.cursor/projects/...` | JSONL | `role`, `message.content`, текст в `<user_query>`; `cwd` бывает только в имени папки (с потерями) | **внутр.** | код Codex [V] |
| **Cline** (VS Code) | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\tasks\<id>\api_conversation_history.json`, `ui_messages.json`, `task_metadata.json`; новые версии — `%USERPROFILE%\.cline\data\` | `~/Library/Application Support/Code/…`, `~/.config/Code/…` | JSON | Сообщения Anthropic; индекс `taskHistory.json` | **внутр.** | код Cline [V]; viewer [V-вторич.] |
| **Roo / Kilo** | `…\globalStorage\rooveterinaryinc.roo-cline\tasks\…`, `…\kilocode.kilo-code\tasks\…`; Kilo CLI с 2026-05 — `~/.local/share/kilo/kilo.db` (схема OpenCode) | то же | JSON / SQLite | Как у Cline / OpenCode | **внутр.** | viewer [V-вторич.] |
| **Continue** | `%USERPROFILE%\.continue\sessions\<id>.json` (`%CONTINUE_GLOBAL_DIR%`) | `~/.continue/sessions/` | JSON | sessionId, title, workspaceDirectory, history[{message{role, content}}]; времени у сообщений нет | **внутр.** | viewer [V-вторич.] |
| **Aider** | `<проект>\.aider.chat.history.md`, `.aider.input.history` | то же | Markdown | `# aider chat started at…`, `#### ` — пользователь, `> ` — вывод | **док** (опции), но формат с потерями | aider.chat/docs [V] |
| **Goose** | `%APPDATA%\Block\goose\data\sessions\sessions.db` (`%GOOSE_PATH_ROOT%`) | `~/.local/share/goose/sessions/sessions.db` | SQLite | `sessions` (working_dir, name…), `messages` (role, content_json, created_timestamp); схема v17; до 1.10 — файлы JSONL | **внутр.** | docs Goose, код [V] |
| **Hermes** | `%LOCALAPPDATA%\hermes\state.db` (`%HERMES_HOME%`) | `~/.hermes/state.db` | SQLite (WAL) | `sessions` (cwd, model, title…), `messages` (role, content, tool_calls, timestamp, reasoning); схема v32 | **внутр.** | код [V] |
| **Pi CLI** | `%USERPROFILE%\.pi\agent\sessions\--<cwd>--\<ts>_<uuid>.jsonl` (`%PI_CODING_AGENT_DIR%`, `%PI_CODING_AGENT_SESSION_DIR%`) | `~/.pi/agent/sessions/...` | JSONL v3 | Описан в `docs/session-format.md`, старые версии мигрируются сами | **док** | Pi 1.4 [V] |
| **Наше приложение** | `%APPDATA%\PRSLOY\agent\sessions\<ts>_<uuid>.jsonl` — **плоско**, фильтр по `cwd` в заголовке | `~/.config/PRSLOY/…`, `~/Library/Application Support/PRSLOY/…` | JSONL v3 | — | — | `main/prsloy/context.ts:195`, проба S25 [V] |
| Zed, Copilot CLI, Qwen Code | `%LOCALAPPDATA%\Zed\threads\threads.db` (zstd JSON); `~/.copilot/session-state/<id>/events.jsonl`; `~/.qwen/projects/…/chats/*.jsonl` | — | — | — | **внутр.** | viewer [V-вторич.] |
| claude.ai, ChatGPT | Не на диске. Только экспорт архивом | — | — | — | — | [U] |

**Важно про папки Claude Code.** Имя папки — путь, где всё, кроме букв и цифр, заменено на `-` [V, docs]. SpecStory
воспроизводит это как `[^a-zA-Z0-9-]` → `-` [V]. Значит, кириллица, скорее всего, становится дефисами:
`C:\Проекты\сайт` и `C:\Работа\блог` дают одинаковое имя. **Путь из имени папки не восстанавливаем.** Берём `cwd`
из строк транскрипта [U про кириллицу; правило — по коду Codex и Cline, оба так делают, V].

---

## 3. Что брать и что нет

### 3.1 Ценность для новичка

| Что | Ценность | Риск | Цена | Решение |
|---|---|---|---|---|
| **Список папок проектов** (`cwd` из сессий, `workspace.json` редакторов) | Высокая: новичок не помнит, где лежит его сайт. Сразу подставляем в шаг «Выберите папку» | Низкий | Низкая | **P1** |
| **Недавние чаты** — увидеть и продолжить | Средне-высокая: «тот сайт, который я делал в Claude Code» | Средний: секреты, инъекции, объём | Средняя | **P1**: Claude Code, Codex, Pi CLI; **P2**: Gemini, Cursor Agent, OpenCode, Cline-семья, Aider |
| Проектные `CLAUDE.md` / `AGENTS.md` | Уже работают: Pi сам читает их из папки проекта и родителей (если включено правило доверия — после него) | — | 0 | **Не переносить**, только сказать «правила проекта подхватятся» [V, `agent-runtime/src/index.ts:384`] |
| Общие правила: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, правила Cursor | Средне-низкая: у новичков их почти нет. Часть пишет `/init`, а не человек | Средний: это не слова пользователя | Низкая | **P3**: только кандидаты в память с подтверждением |
| Авто-память Claude (`projects/*/memory/*.md`) | Низкая: заметки модели о себе | Средний | Низкая | **P3**, кандидаты |
| Навыки (`~/.claude/skills`, `~/.codex/skills`) | Низкая: новички их не пишут | Высокий: скрипты и инструкции чужого происхождения | Средняя | **Нет** в v1. Позже — по одному, с просмотром |
| MCP-серверы | Низкая | Высокий: ключи в `env` и заголовках, запуск чужих команд | Средняя | **Нет.** Максимум — «нашли N серверов, добавьте вручную» |
| Разрешения, хуки, плагины, субагенты, команды | Нет: у харнесса своя политика | Высокий | — | **Нет** |
| Картинки из чатов | Низкая | Секреты на скриншотах, объём (у Claude Code новые версии хранят картинки во временной папке) | — | Заглушка «[картинка не перенесена]» |

### 3.2 Что теряется при переносе чата

| Что | Судьба | Почему |
|---|---|---|
| Текст пользователя и ассистента | Переносим | Это и есть ценность |
| Вызовы инструментов | Короткая строка в тексте ответа: «• Bash: npm test», «• Edit: index.html» | Чужие имена и схемы инструментов. Так делает Codex [V] |
| Результаты инструментов | Выбрасываем; ошибку — первые 300 знаков | Объём, секреты, чужие файлы и сайты = инъекции |
| Размышления | Выбрасываем | Подписи привязаны к поставщику; Codex выбрасывает, Cline срезает подписи [V] |
| Картинки | Заглушка | См. выше |
| Ветки (правки сообщений) | Только активная ветка | Cline идёт от последней строки по `parentUuid` [V] |
| Субагенты, вложения, служебные строки | Выбрасываем | Шум; `isSidechain`, `isMeta` |
| Модель, токены, цена | Модель — в метаданных переноса; токены и цена — ноль | Не наши расходы |

---

## 4. Рекомендация для нас

### 4.1 Первый запуск и экраны

Сейчас: «Вставьте ключ» → «Выберите папку проекта» → приложение
(`renderer/lib/prsloy-first-run.ts`, `FirstRunGate.tsx`) [V]. Добавляем шаг `import` **между ключом и папкой**, и
только если что-то нашлось. Поиск дешёвый: проверить папки, взять список файлов и даты, прочитать по 64 КБ с
начала и конца файла ради названия и `cwd`. Полный разбор — только после «Перенести».

**Экран «Нашли вашу прошлую работу»**

```
Нашли на этом компьютере:
  [x] Claude Code — 3 проекта, 27 чатов за 30 дней
  [x] Codex — 1 проект, 4 чата
  [ ] Cursor — 2 проекта (чаты Cursor пока не переносим)

  Что перенести:  [x] папки проектов   [x] чаты, чтобы их можно было продолжить
  Выбрать чаты…  (список с поиском и «выбрать все», как у Cline)

Мы только читаем файлы на этом компьютере. Ничего не меняем и никуда не отправляем.
Ключи и пароли в чатах скрываем.
                                     [Перенести]   [Не сейчас]
```

- Прогресс: «Переношу… 12 из 31». Итог: «Перенесено 29 чатов из 4 проектов. 2 не вышло: файл занят — закройте
  Claude Code и нажмите «Повторить»».
- Шаг «Выберите папку» сначала показывает найденные проекты: «мой сайт — C:\Проекты\мой сайт · 12 чатов из
  Claude Code». Только существующие папки; домашняя, корень диска и временные — нет.
- «Не сейчас» — экран больше не появляется. В настройках — «Перенести из других программ» (тот же экран, в
  любой момент) и «Убрать перенесённые чаты» (по журналу).
- В списке чатов — метка «из Claude Code». В чате — плашка: «Чат перенесён из Claude Code 3 октября. Агент видит
  краткий пересказ и последние сообщения. Можно продолжать». Пересказ (`compaction`) этой плашкой и показываем.
- Ответвление и правка на сообщениях до плашки в v1 выключены.
- Тексты — через `t()`, ключи в `zh`, `en` и `ru` (`docs/llm-wiki/i18n.md`); без `window.confirm`.

### 4.2 Модули

**Пакет `app/packages/session-import/`** — чистый TypeScript, без Electron, у каждого `lib`-файла свой `.test.ts`.

| Файл | Что делает |
|---|---|
| `paths.ts` | Где искать. Windows: `USERPROFILE` → `HOMEDRIVE`+`HOMEPATH` → `os.homedir()`; `APPDATA`, `LOCALAPPDATA`. Переопределения: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`, `HERMES_HOME`, `GOOSE_PATH_ROOT` |
| `detect.ts` | Дешёвый поиск: есть ли папка, сколько файлов за N дней, название и `cwd` из головы и хвоста файла |
| `read-lines.ts` | Поток JSONL (`readline` поверх `createReadStream`; `zlib.createZstdDecompress` для `.zst`). Битые строки пропускает и считает. Строка длиннее 8 МБ — пропуск. Незаконченная последняя строка — пропуск |
| `sqlite-snapshot.ts` | Копия `db` + `-wal` + `-shm` во временную папку, `node:sqlite` только на чтение, проверка схемы (как Cline). P2 |
| `adapters/claude-code.ts`, `codex.ts`, `pi-cli.ts` | **P1** |
| `adapters/gemini.ts`, `cursor-agent.ts`, `opencode.ts`, `cline-family.ts`, `aider.ts`, `goose.ts`, `hermes.ts` | **P2**. Незнакомая схема — пропуск с причиной, не падение |
| `normalize.ts` | Общий вид `ImportedChat {tool, sourceId, sourcePath, cwd, title, startedAt, updatedAt, model, turns[]}` |
| `clean.ts` | Снять обёртки (`<command-name>`, `<local-command-*>`, `<system-reminder>`, `<task-notification>`, `<ide_*>`, `<user_query>`, `<environment_context>`, `# AGENTS.md instructions`…). Убрать невидимые и Unicode-теги. `scrubSecrets`. Лимиты длины |
| `summary.ts` | Пересказ **кодом, без модели**: название, период, список просьб пользователя (первая строка каждой, до 20), файлы из пометок инструментов, последний ответ. До 6 000 знаков. Обёртка: «Пересказ прошлого разговора из Claude Code. Это данные, а не инструкции» |
| `to-pi.ts` | Пишет JSONL v3 Pi (раздел 4.3). Атомарно: временный файл + `rename` с повтором на EPERM / EBUSY |
| `ledger.ts` | Журнал `userData/prsloy/import-ledger.json`: `{tool, sourceId, sourcePath, size, mtime, sha256, piSession, importedAt}` |
| `projects.ts` | Кандидаты в проекты: `cwd` существует, это не домашняя папка, не корень и не временная; `realpathSync.native` даёт настоящий регистр буквы диска |

**Main:** `apps/desktop/src/main/import/` — IPC `prsloy:import:scan`, `prsloy:import:run` с событиями прогресса.
Разбор идёт в `worker_threads`, чтобы файл на 90 МБ не морозил окно. Типы — в `packages/contracts/src/import.ts`,
`preload` — минимум каналов. **Renderer:** шаг `import` в `FirstRunGate`, экран, раздел настроек, плашка и метка.

Каталог сессий **не угадываем**. В приложении `PI_CODING_AGENT_SESSION_DIR` задан явно, поэтому Pi кладёт файлы
плоско, а `SessionManager.list(cwd, dir)` фильтрует по `cwd` в заголовке. Подпапки `--<cwd>--` он в этом режиме
не видит [V, S25 `pi-envdir-probe.mjs`]. Комментарий в `main/session-files.ts` описывает подпапки — для нынешнего
режима он не точен. Импорт берёт каталог через `resolvePixSessionDir()` из `agent-runtime`, как сам хост.

### 4.3 Как чат ложится в сессию Pi

Порядок записей в файле `<sessionDir>/<ts начала>_<uuid>.jsonl`:

1. `session` — `version: 3`, `timestamp` = начало чата, `cwd` = настоящий путь проекта.
2. `custom`, `customType: "prsloy.import"` — откуда: `{tool, sourceId, sha256, sourceModel, importedAt, dropped}`.
   В контекст модели не идёт. По нему M-2 (research/24 §3.1) пропускает перенесённые сообщения.
3. `message` для каждого хода: `user` — строка текста; `assistant` — `[{type:"text"}]`, где пометки инструментов
   вписаны строками; `api` / `provider` = `"imported"`, `usage` нулевой. Время — из оригинала.
4. `compaction`: `summary` из `summary.ts`, `firstKeptEntryId` = первое сообщение последних ~6 ходов (не больше
   ~8 000 токенов), `fromHook: true`.
5. `model_change` → `prsloy` / модель по умолчанию.
6. `session_info` — название: `custom-title` → `ai-title` → `summary` → первая строка пользователя, до 120 знаков
   (порядок Codex и Cline).

**Проверено на Pi 1.4.0 [V, S25 `pi-import-probe.mjs`]:**
- `SessionManager.list(cwd)` видит такой файл: имя из `session_info`, `messageCount` = 4, `created` и `modified` — из
  времени оригинала, а не из времени переноса. Порядок в списке сохраняется.
- Перед моделью только пересказ: `buildSessionContext().messages` = `[compactionSummary]`. После нового сообщения —
  `[compactionSummary, user]`. Дописывание в файл работает.
- Без `model_change` Pi берёт модель из последнего ответа: `{provider: "imported", modelId: "claude-sonnet-4-5"}`.
  Сессия попыталась бы открыться на чужой модели. С `model_change` — `{provider: "prsloy"}`. Cline чинит ту же
  проблему своим параметром «resume provider/model» [V].
- С хвостом (`firstKeptEntryId` = последний ответ) контекст = `[compactionSummary, assistant]`, после нового
  сообщения — `[compactionSummary, assistant, user]` [V, S25 `pi-tail-probe.mjs`]. Не проверено, как Pi отдаст
  поставщику ответы с `api: "imported"` из хвоста [U] — это первый тест I0 с фейковым поставщиком
  `openai-completions`.

**Почему так.** Экран показывает всю историю (ветку по `getBranch()`), а модель получает короткий пересказ и
хвост. Чужие вызовы инструментов в контекст не попадают, значит, нет проблем с парами вызов — результат
(Cline держит ради них отдельный «санитайзер») [V]. Цена продолжения ограничена. Другой вариант — блоки
`toolCall` и `toolResult` ради красивых карточек. Он хуже: при ответвлении до плашки чужие вызовы попадут к
поставщику. Примет ли шлюз вызовы инструментов, которых нет в списке, я не проверял [U].

**Карта полей**

| Источник | Claude Code | Codex | Pi CLI |
|---|---|---|---|
| Сообщения пользователя | `type:user`, текст, не `isMeta`, не `isSidechain`, не `isCompactSummary`, без `tool_result` и обёрток | `event_msg.user_message`; `response_item` user — только если нет `user_message` и это не вставленный контекст | Копия файла |
| Ответы | `type:assistant` текст; строки с одним `message.id` склеить | `response_item` message assistant | — |
| Инструменты | `tool_use` → строка (name + command / file_path / description) | `function_call`, `custom_tool_call` → строка | — |
| `cwd` | С первой строки, где он есть | `session_meta.cwd`, иначе `turn_context.cwd` | Заголовок |
| Модель | Последняя `message.model`, кроме `<synthetic>` | `turn_context.model` | — |
| Пропуск файла | Есть `continued-in` (чат продолжен в другом файле); нет ответа ассистента и текста пользователя | Нет id или нет сообщений; из нескольких файлов одного id — самый полный (Cline) | Есть в журнале |

### 4.4 Что берём из чужого кода

| Откуда | Лицензия | Что |
|---|---|---|
| Cline `sdk/packages/core/src/services/session-import/` (`40c5d99`, 2026-10-23) | Apache-2.0, © 2026 Cline Bot Inc. | **Адаптируем код**: интерфейс адаптера (`isInstalled / discover / convert / dispose`); восстановление ветки Claude Code от последней строки по `parentUuid`; склейка строк по `message.id`; пропуск `<synthetic>`; адаптер Codex (вставленный контекст, самый полный файл на id, названия из `session_index.jsonl`); снимок SQLite с WAL; защита от дублей и от двух переносов сразу; откат файла при сбое. Меняем: поток вместо `readFileSync`, `.zst`, пути Windows, вывод в Pi, только текст |
| Codex `codex-rs/external-agent-migration/` (`970111f`, 2026-10-23) | Apache-2.0, © 2025 OpenAI | **Переносим логику** (Rust → TS): лимиты 30 дней и 50 чатов; журнал с sha256 и mtime; порядок названий; список обёрток; пометки инструментов (2000 / 4000 знаков); пропуск `continued-in`; «папка должна существовать»; расшифровка папок Cursor с потолком 128 проб; вид экрана |
| Goose `crates/goose/src/session/import_formats/` (`2b17adc`, 2026-10-24) | Apache-2.0, © 2024 Block, Inc. | Распознавание формата по первой строке; чистка Unicode-тегов |
| Hermes `hermes-official-plugins/agent-importers` (`20048e6`, 2026-10-24) | MIT, © 2026 Nous Research | Для P3: разбивка markdown на записи; список «файлы с ключами не читать». Регулярка секретных имён env — если когда-нибудь дойдём до MCP |
| ccusage, claude-code-history-viewer, SpecStory | MIT / MIT / Apache-2.0 | Только справка по путям и полям для P2 (Rust и Go, код не переносим) |
| Zed, Crush, Cherry Studio, Chatbox | GPL / FSL / AGPL / GPL | **Только идеи**, ничего не копируем |

Оформление: в шапке каждого адаптированного файла — «Portions adapted from <проект> (<лицензия>), <путь>@<коммит>»,
строки в `app/NOTICE.md`, тексты лицензий — в `app/licenses/`. Apache-2.0 требует указать изменения.

### 4.5 План по этапам

**I0 — пакет и фикстуры, без интерфейса.** Только синтетические фикстуры: настоящие чужие транскрипты в репо не
кладём.

| Фикстура | Что в ней |
|---|---|
| `claude-code/basic.jsonl` | user строкой и списком, text / thinking / tool_use / tool_result / image, `cwd` = `C:\\Проекты\\мой сайт`, `ai-title`, `custom-title` |
| `claude-code/branches.jsonl` | Правка сообщения: две ветки по `parentUuid`, ответ модели тремя строками с одним `message.id` |
| `claude-code/noise.jsonl` | `isMeta`, `isSidechain`, `isCompactSummary`, `attachment`, `<command-name>`, `<system-reminder>`, `<task-notification>`, `continued-in` |
| `claude-code/<session>/subagents/a.jsonl` | Должен быть пропущен |
| `claude-code/secrets.jsonl` | `sk-…`, `ghp_…`, токен Telegram, `-----BEGIN PRIVATE KEY-----` |
| `claude-code/broken.jsonl` | Битая середина, незаконченная последняя строка, пустой файл |
| `codex/rollout-…jsonl` и та же копия в `.jsonl.zst` | `session_meta` с `cwd` Windows, `turn_context`, `user_message`, вставленный `<environment_context>` и `# AGENTS.md instructions`, reasoning, function_call / custom_tool_call и output, `compacted` |
| `codex/resumed/` | Два файла с одним id |
| `pi/v3-tree.jsonl` | Сессия Pi с веткой и `compaction` |
| Генератор в тесте | Файл на 120 МБ (не в репо) — проверка потока и памяти |

Приёмка I0:
- Unit на каждый файл пакета. Снимки разбора для каждой фикстуры.
- Секреты → `[СКРЫТО: …]` в тексте, названии и пересказе.
- Исходные файлы после переноса совпадают байт в байт (sha256 до и после).
- В пакете нет `child_process`, `spawn`, `exec` (тест ищет по исходникам). Чужие CLI не запускаем, их и так
  блокирует `main/prsloy/agent-env.ts` [V].
- Круг через SDK: `SessionManager.open` → контекст = `[compactionSummary, …хвост]`, модель = `prsloy`;
  `listProjectSessions(cwd)` показывает чат с названием.
- Фейковый поставщик `openai-completions` принимает хвост с `api: "imported"` без ошибок. Если нет — хвост
  уходит в пересказ, `firstKeptEntryId` = свой id (этот вариант уже проверен).
- Файл 120 МБ: память worker'а < 300 МБ, время < 10 с на CI Linux [U, порог подобрать].

**I1 — первый запуск: проекты и чаты Claude Code, Codex, Pi CLI.**
- Main и IPC, worker, журнал; экран, шаг папки с найденными проектами, метка, плашка, настройки, i18n.
- Приёмка, e2e на `windows-latest` в существующем smoke «Иван Петров» (`e2e-smoke/cyrillic.spec.ts`):
  - фикстуры в `%USERPROFILE%\.claude` и `%USERPROFILE%\.codex` профиля «Иван Петров», `cwd` = `C:\Проекты\мой сайт`;
  - экран показывает верные счётчики → «Перенести» → проект в шаге папки → чат открывается с плашкой;
  - сообщение уходит в фейковый поставщик как `[пересказ, хвост, новое]`;
  - повторный запуск: «уже перенесено», дублей нет;
  - файл, открытый PowerShell с `FileShare.None`, → понятное «файл занят», остальные чаты переносятся;
  - буква диска в `cwd` строчная (`c:\…`) → чат всё равно в списке проекта;
  - папки проекта нет → чат не переносится, причина в итоге.
- Вне e2e: «Не сейчас» больше не показывает экран; «Убрать перенесённые» удаляет только файлы из журнала.

**I2 — остальные источники:** Gemini (`.jsonl` и старый `.json`), Cursor Agent, OpenCode (снимок SQLite; есть
`session_v2` или `session` / `message` / `part`, иначе пропуск), Cline-семья (VS Code, Cursor, Windsurf), Aider (только
в уже найденных папках). Goose и Hermes — если будет спрос. Cursor IDE `state.vscdb` — в последнюю очередь.
- Приёмка: фикстура на каждый формат и каждую известную версию схемы. Неизвестная схема → пропуск с причиной,
  не падение. SQLite открыт чужим процессом (WAL, держим соединение в тесте) → переносится из копии, оригинал
  не тронут.

**I3 — кандидаты в память (после M-3 из research/24).**
- Источник: только **напечатанные пользователем** сообщения перенесённых чатов. Плюс общие правила и авто-память
  Claude, но с меткой «написано в файле, не вами».
- Режим кандидатов: карточки «Нашёл в Claude Code: «пиши проще» · [Запомнить] [Не надо]». Сами ничего не пишем.
- У Claude Code строки `type: user` — часто не человек. В моём транскрипте (2.1.308–2.1.310, вход `remote`) из
  2881 таких строк `turnOrigin: human` у 91; 342 — `task_notification`, 21 — `peer`; `promptSource` бывает
  `system` и `sdk` [V, только счётчики]. Если эти поля есть — требуем «человек» или пусто. Плюс фильтры
  research/24 M-2 (вставки >600 знаков, кнопки, навыки).
- Приёмка — по research/24 §3.4: 0 секретов, 0 цитат не из слов пользователя; фикстуры «отравленный CLAUDE.md»
  и «инструкция в ответе ассистента» в память не попадают.

**I4 — не планируем:** навыки и MCP. Вернуться, если об этом попросят пользователи.

---

## 5. Риски

| Риск | Что делаем |
|---|---|
| **Формат меняется** (OpenCode — 3 схемы за год, Codex — zstd, Gemini — `.json` → `.jsonl`) | Фикстура на версию; проверка схемы перед разбором; «не понял — пропусти и скажи»; P1 только для Claude Code, Codex и Pi |
| **Приватность** | Только локальное чтение. Наружу ничего, в телеметрию максимум счётчики по согласию (research/23 §0 п.7: 152-ФЗ). Согласие — экран с галочками по источникам |
| **Секреты** в чатах (docs Claude Code: всё, что прошло через инструмент, лежит открытым текстом [V]) | Результаты инструментов не переносим; `scrubSecrets` на весь текст. В `RULES` нет JWT, `Bearer …` и `password=…`: добавить общее правило `(api[_-]?key\|token\|secret\|password)\s*[=:]\s*\S{8,}` с сохранением имени [V, `secret-scrub.ts`] |
| **Инъекция** через перенесённый текст | Пересказ помечен как данные; невидимые символы и Unicode-теги вырезаны; вывод инструментов, файлы и сайты не переносим |
| **Файл занят** на Windows | Node открывает файлы с общим доступом на чтение и запись [U]; читаем поток, незаконченную строку пропускаем. Эксклюзивная блокировка → «файл занят». SQLite — только копия. Чат, изменённый меньше 2 минут назад, помечаем «ещё открыт в Claude Code» |
| **Большие файлы**: мой транскрипт Claude Code весит 88,8 МБ, медиана по 42 файлам 1,9 МБ [V] | Поток в worker; храним последние 300 сообщений и до 20 000 знаков на сообщение; хвост для модели до ~8 000 токенов |
| **Кириллица**: имена папок Claude Code необратимы и могут совпасть | `cwd` только из строк; группировка по `cwd`, не по папке |
| **Буква диска и регистр**: `c:\` против `C:\` | `realpathSync.native`; тест |
| **Длинные пути** (>260) у глубоких кириллических проектов | Тест на путь 240+ знаков; в имени файла сессии нет `cwd` (плоский каталог) [V] |
| **OneDrive**: «Документы» только в облаке | Ошибка чтения → пропуск с причиной [U] |
| **Папки проекта нет** или это домашняя папка | Не проект. Чат не переносим (P1). Позже — в «Разговоры» (`PRSLOY/conversations`) |
| **Дубли** при повторе и двух окнах | Журнал + проверка в момент переноса + «один перенос за раз» (Cline) |
| **Чат продолжили там**, а мы перенесли раньше | v1: «обновился — перенести заново?» отдельной копией; дописывание, как у Codex, — позже |
| **Пользователь ждёт, что агент «помнит всё»** | Плашка честно говорит: «видит пересказ и последние сообщения» |
| **Цена продолжения** | Пересказ ≤ 6 000 знаков + хвост ≤ ~8 000 токенов |
| **Загрязнение памяти** | Перенесённое помечено, M-2 его пропускает; I3 — только карточки |
| **Чужая модель** при открытии | `model_change` на PRSLOY (проверено) |
| **`node:sqlite` в Electron** | Electron 43.1.1 = Node 24.18.0: `node:sqlite` и `zlib.zstdDecompressSync` есть, предупреждения нет [V, прогон]. Нативные модули не нужны |
| **Курсор IDE** — самый частый у новичков, а его чаты разобраны обратной разработкой | P1 берёт только папки проектов из `workspaceStorage\*\workspace.json` [U]; чаты — I2, последними |

---

## 6. Источники

### Код (shallow-клоны 2026-10-25, `MR/`)
- Codex, `openai/codex` `970111f` (2026-10-23), Apache-2.0: `codex-rs/external-agent-migration/src/{detect/sessions/{cla,cur,common}.rs, sessions/{mod,export,records_cla,records_cur,records_common,title,ledger,append}.rs, model.rs, memory.rs, source/cla.rs}`, `codex-rs/tui/src/external_agent_config_migration/{flow.rs, snapshots/*.snap}`, `codex-rs/tui/src/slash_command.rs`, `codex-rs/rollout/src/{compression.rs, rollout_file_name.rs}`, `codex-rs/state/migrations/0038_external_agent_config_imports.sql` [V]
- Cline, `cline/cline` `40c5d99` (2026-10-23), Apache-2.0: `sdk/packages/core/src/services/session-import/{types,paths,claude-code,codex,opencode,sanitize,service}.ts`, `apps/examples/desktop-app/webview/components/{import-sessions-dialog.tsx, views/chat/imported-session-notice.tsx}`, `apps/vscode/src/core/storage/disk.ts`, `.clinerules/storage.md` [V]
- Goose, `block/goose` `2b17adc` (2026-10-24), Apache-2.0: `crates/goose/src/session/import_formats/{mod,claude_code,pi}.rs`, `session_manager.rs`, `config/paths.rs`, `documentation/docs/guides/{logs.md, sessions/session-management.md}` [V]
- Hermes, `NousResearch/hermes-agent` `930e5ed` (2026-10-25), MIT: `hermes_cli/setup_agent_import.py`, `plugin-catalog/agent-importers.yaml`, `hermes_constants.py`, `hermes_state_common.py`, `website/docs/user-guide/import-from-other-agents.md`. Плагин `NousResearch/hermes-official-plugins` `20048e6` (2026-10-24): `agent-importers/{README.md, importer.py}` [V]
- OpenCode, `sst/opencode` `1564686` (2026-10-25), MIT: `packages/cli/src/{database-path.ts, commands/handlers/session/import.ts}`, `packages/util/src/global-roots.ts`, `packages/core/src/session/sql.ts`, `packages/core/src/database/{migration/, v1-migration.bun.ts}`, `packages/schema/src/session-message.ts` [V]
- Gemini CLI, `google-gemini/gemini-cli` `cd1b45c` (2026-10-23), Apache-2.0: `packages/core/src/services/{chatRecordingTypes,chatRecordingService}.ts`, `packages/core/src/config/{storage,storageMigration}.ts`, `docs/cli/session-management.md` [V]
- Crush, `charmbracelet/crush` `1322d2c` (2026-10-25), FSL-1.1-MIT: `internal/config/config.go` [V]
- ccusage `ryoppippi/ccusage` (2026-10-25), MIT: `apps/ccusage/README.md`, `rust/adapters/*/src/paths.rs` [V]
- claude-code-history-viewer `jhlee0409/…` (2026-10-20), MIT: `README.md`, `src-tauri/src/providers/{cursor,cline,kilo,continue_dev,aider,zed}.rs` [V]
- SpecStory `specstoryai/getspecstory` (2026-10-23), Apache-2.0: `README.md`, `specstory-cli/pkg/providers/claudecode/path_utils.go` [V]
- agent-sessions (2026-10-24), agentsview (2026-10-25), ai-sessions-mcp (2026-08-17), tokscale (2026-10-25), splitrail (2026-10-19), cchistory (2026-06-10) — README и LICENSE, все MIT [V]

### Официальная документация (2026-10-25)
- Claude Code, «Explore the .claude directory» (Application data, cleanupPeriodDays, Plaintext storage, purge) — https://code.claude.com/docs/en/claude-directory [V]
- Claude Code, «Settings» (Windows `%USERPROFILE%\.claude`, `CLAUDE_CONFIG_DIR`, `~/.claude.json`) — https://code.claude.com/docs/en/settings [V]
- Claude Code, «Commands» (`/import codex|gemini|cursor`) — https://code.claude.com/docs/en/commands [V]
- Codex, Sample configuration (`[history]`) — https://learn.chatgpt.com/docs/config-file/config-sample [V]; про хранение сессий там ничего нет
- Hermes, «Import from Other Agents» — `website/docs/user-guide/import-from-other-agents.md` в репо [V]
- OpenCode, «Rules» → Claude Code compatibility — https://opencode.ai/docs/rules/ [V]
- Cursor, «Skills» — https://cursor.com/docs/context/skills [V]
- Aider, «Options» (`--chat-history-file`, `--input-history-file`) — https://aider.chat/docs/config/options.html [V]
- Goose, «Logs» (пути Windows) — `documentation/docs/guides/logs.md` в репо [V]

### Наш код и пробы
- Pi 1.4.0: `docs/{session-format,sessions,message-types,sdk,configuration,skills,slash-commands}.md`, `dist/core/session-manager.d.ts`, `CHANGELOG.md` [V]
- `app/apps/desktop/src/main/{session-files.ts, workspace-paths.ts, index.ts:2993,5543}`, `main/prsloy/{agent-home,agent-env,context}.ts`, `shared/prsloy-config.ts`, `renderer/lib/prsloy-first-run.ts`, `renderer/components/prsloy/FirstRunGate.tsx`, `e2e-smoke/cyrillic.spec.ts` [V]
- `app/packages/agent-runtime/src/{index.ts, session-dir.ts}`, `app/packages/prsloy-harness/src/secret-scrub.ts` [V]
- research/21, research/23 §0, research/24 §3 [V]
- Пробы: `S25/pi-import-probe.mjs` (список, контекст, модель, дописывание), `S25/pi-tail-probe.mjs` (хвост), `S25/pi-list-probe.mjs`, `S25/pi-envdir-probe.mjs` (плоский каталог при явном `PI_CODING_AGENT_SESSION_DIR`) [V]
- Electron 43.1.1: `process.versions.node` = 24.18.0, `node:sqlite` и `zlib.zstd*` есть [V, прогон]
- Структура Claude Code — счётчики типов, ключей и полей на транскриптах этой сессии в `/root/.claude/projects/` [V]

### Вторичные (не опора)
- Hashnode, «Codex vs Claude Code in 2026» — о Codex CLI 0.145.0 (21 июля 2026) с переносом сессий [U]
- codex.danielvaughan.com — заметки о формате rollout [U]

### Не открыл или не смог проверить
- Changelog Codex с датой появления переноса сессий — только вторичный источник.
- Как Claude Code кодирует кириллицу в имени папки — docs говорят «letters and digits», пример только латиница.
- Примет ли шлюз PRSLOY вызовы инструментов, которых нет в списке (вариант с `toolCall` в истории).
- Ответы `api: "imported"` в хвосте при запросе к поставщику — сборку контекста проверил, сам запрос нет.
- Где включается сжатие rollout'ов в Codex (место вызова `spawn_rollout_compression_worker` не нашёл).
- Импортёры Continue, AnythingLLM, Jan, Cherry Studio, Chatbox; формат `history.jsonl` Codex.
- Пути Goose на macOS (ccusage перебирает два варианта).
