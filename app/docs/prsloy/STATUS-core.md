# STATUS — дорожка W1 «Ядро» (`desktop/core`)

## Сделано

### 1. Изоляция от CLI pi
- Свой pi home: `userData/agent` (models.json, settings.json, trust, `bin/` для rg/fd), сессии в
  `userData/agent/sessions`. `~/.pi/agent` не читается и не пишется.
- `main/prsloy/context.ts` → `bootstrapPrsloy()` ставит `PI_CODING_AGENT_DIR` и
  `PI_CODING_AGENT_SESSION_DIR` в `process.env` main сразу после распаковки рантаймов, до первого
  запуска хоста. Всё, что зовёт `getAgentDir()` (хост, pi TUI, менеджер пакетов), попадает туда.
- Глобальный `PI_CODING_AGENT_DIR` пользователя игнорируется. Исключение — тестовый режим
  (`ZENO_ENABLE_TEST_COMMANDS=1`), чтобы e2e могли подложить свой каталог.

### 2. Провайдер PRSLOY
- Каталог в `apps/desktop/src/shared/prsloy-config.ts`. Он же — **единая константа для ui**:
  - `PRSLOY_SPEED_MODES`: `fast` → `deepseek-v4.1-flash-1017`, `quality` → `kimi-k3.1-pro`;
  - подписи — ключи `prsloy.speed.fast` / `prsloy.speed.quality`;
  - хелперы `prsloyModelForSpeed()` и `prsloySpeedForModel()`.
- В `models.json` пишется `providers.prsloy` **без ключа**:
  - `api: openai-completions`, `baseUrl` по умолчанию `https://api.prsloy.online/v1`, меняется в
    настройках;
  - compat провайдера: `maxTokensField: max_tokens`, `supportsDeveloperRole: false`,
    `supportsStore: false`;
  - DeepSeek: `thinkingFormat: deepseek` + `requiresReasoningContentOnAssistantMessages`;
  - Kimi: `requiresReasoningContentOnAssistantMessages`;
  - Qwen: `thinkingFormat: qwen`;
  - Opus: `reasoning: false`, `supportsReasoningEffort: false`. В UI у него доступен только
    уровень мышления `off`.
- Ключ попадает в pi только как runtime key (`modelRuntime.setRuntimeApiKey`). Новая опция
  `runtimeApiKeys` в `createPixRuntime` (`packages/agent-runtime`).
- `settings.json` засевается моделью по умолчанию `prsloy/deepseek-v4.1-flash-1017`, если
  пользователь ещё ничего не выбрал.

### 3. Первый запуск
- IPC `prsloy:*`, тип `PrsloyDesktopApi` в `@zeno/contracts`, `window.zeno.prsloy` в preload:
  - `getState`, `setKey`, `clearKey`, `setBaseUrl`;
  - `listTurns`, `undoTurn`.
- Проверка ключа (`main/prsloy/gateway-check.ts`): `GET {base}/models` с Bearer; на 404/405 —
  запасной путь через completion в 1 токен. Запросы идут через `net.fetch` (системный прокси).
  Коды ошибок:

  | Код | Когда |
  |---|---|
  | `invalid_key` | 401/403 |
  | `no_balance` | 402 |
  | `network` | нет соединения |
  | `timeout` | сервер не ответил |
  | `server` | 5xx |
  | `bad_url` | неверный адрес |

  Ключ и адрес сохраняются только после успешной проверки, затем хост перезапускается
  (`supervisor.restartWithFreshEnv()`, та же сессия).
- Хранение ключа: `safeStorage` (DPAPI) → `userData/prsloy/gateway-key.bin`. Если ОС не умеет
  шифровать, ключ держится только в памяти и `keyMemoryOnly=true`. В открытом виде на диск не
  пишется никогда (проверено тестом).
- Экран: `renderer/components/prsloy/FirstRunGate.tsx` оборачивает `<App/>`. Порядок:
  «Вставьте ключ PRSLOY» → «Выберите папку проекта» (через существующие
  `workspace.pickFolder`/`openPath`) → приложение.
  - Оформление минимальное, на `ui/`-примитивах. Стиль — дорожка ui.
  - В тестовом режиме экран пропускается (`firstRunBypass`). `PRSLOY_FORCE_FIRST_RUN=1`
    включает его для e2e.
- Встроенные провайдеры и OAuth я **не прятал**: это работа ui («Для разработчиков»). Ключ
  i18n `prsloy.dev.section` уже добавлен.

### 4. Shell на Windows
- `fetch-runtimes.mjs` для win32 качает:
  - **PortableGit 2.51.0** (7z SFX; распаковка через 7z, иначе самим SFX). Режем docs, locale,
    man, Tcl/Tk, gitk, git-gui. Результат → `archives/git.tar.gz`;
  - **ripgrep 14.1.1 + fd 10.2.0** → `archives/tools.tar.gz`.
- `runtime-provision` распаковывает оба архива в `userData/runtimes/{git,tools}`. Версия git
  записана в штамп: установки, сделанные без git, распакуются заново.
- `settings.json` → `shellPath`: bundled `git\bin\bash.exe` → системный Git for Windows → иначе
  всё равно bundled-путь. Тогда pi пишет «shell not found». **До `where bash.exe` (WSL) дело не
  доходит никогда.** Тест: `windows-shell.test.ts`.
- rg/fd копируются в `<agentDir>/bin`: pi ищет их там первым делом. Плюс `PI_OFFLINE=1` в env
  хоста, так что скачивания с GitHub нет.
- Шимы `python3` и `python` (и `.cmd`-двойники) ведут на venv/встроенный Python и стоят первыми
  в PATH агента. Заодно перекрывают Store-заглушку `python` в Windows.
- Тул `powershell` выключен: в Pi он не входит в набор по умолчанию, а мы ещё и вычищаем его из
  `defaultTools`.
- MinGit-busybox не понадобился. В MinGit нет bash, только `ash` из busybox, а pi нужен bash.
  Размер PortableGit после обрезки — см. «Как проверено» (лог CI).

### 5. Чистое окружение агента
- `main/prsloy/agent-env.ts`. Env хоста (его наследуют все тулы pi) собирается через
  `prsloy.hostEnv()` в `processEnvironment()`:
  - выбрасываются `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `AWS_*`, `GH_*`, `GITHUB_*`,
    `AZURE_*`, `GOOGLE_*`, `OPENAI_*`, `ANTHROPIC_*` (без учёта регистра);
  - выставляются `GIT_TERMINAL_PROMPT=0` и `GCM_INTERACTIVE=never`.
- Ключ шлюза передаётся хосту переменной `PRSLOY_GATEWAY_KEY`. Её добавляют после чистки, и
  `agent-host/prsloy-handoff.ts` удаляет её из `process.env` до старта рантайма, поэтому тулы
  ключ не видят.
- Шимы `claude codex gemini aider cursor-agent opencode qwen kimi` (sh + `.cmd`) стоят первыми в
  PATH. Каждый печатает «запрещено харнессом» и выходит с кодом 126.
- `AGENTS.md` / `CLAUDE.md` проекта:
  - новая опция `contextFilesRequireTrust` (через `agentsFilesOverride`): файлы вне agentDir не
    грузятся, пока папка не доверена;
  - их наличие делает `trust.required=true`, и существующий диалог доверия Zeno спрашивает один
    раз, решение сохраняется в trust-store pi.

### 6. Откат хода
- В Zeno готового отката файлов не было. Fork/tree там только для разговора, git-панель работает
  с репозиторием пользователя. Поэтому сделано своё: `main/prsloy/turn-snapshots.ts` (дизайн
  OpenCode).
- Как устроено:
  - теневой репозиторий `userData/snapshots/<sha256(путь)[:16]>/git`, work-tree = папка проекта,
    чужой `.git` не трогается (тест);
  - перед каждым новым ходом (`supervisor.prompt()`, кроме steer/followUp) делается
    `add -A` + `write-tree`;
  - учитываются `.gitignore` и базовый список (`node_modules`, `.venv`, …);
  - лимиты: файл больше 10 МБ исключается; больше 512 МБ или 25 000 файлов — снимок хода
    пропускается;
  - на снимок отведено 20 с, prompt не блокируется дольше.
- Откат `prsloy:undo-turn(id)` («Откатить ход»):
  - сначала снимок текущего состояния (`undo-backup`, для «Вернуть как было»);
  - затем удаляются файлы, созданные после хода N, и переписываются изменённые/удалённые;
  - игнорируемые файлы не трогаются;
  - при работающем агенте откат запрещён.
- Кнопку в UI делает дорожка ui. Ключи `prsloy.undo.*` уже есть, данные дают
  `listTurns({sessionId})` и `undoTurn(id)`.
- Ограничение: вложенные git-репозитории внутри проекта хранятся как gitlink, их содержимое не
  снимается.

### 7. Харнесс (договорённость с W2)
- Хост грузит расширения из пакета `app/packages/prsloy-harness` в каждой сессии. Опция
  `extensionPaths` в `createPixRuntime`, её переживают new/switch/fork (тест).
- Поиск пакета — `main/prsloy/harness-paths.ts`:
  - `PRSLOY_HARNESS_DIR` (переопределение) → `resources/prsloy-harness` (упакованное
    приложение) → `app/packages/prsloy-harness` (dev);
  - `PRSLOY_HARNESS=0` выключает загрузку.
- Требование к пакету: pi package (`package.json` с `"pi": {"extensions": [...]}` или
  `index.ts`), который pi грузит из локального пути. Список уходит хосту через
  `PRSLOY_HARNESS_EXTENSIONS` (JSON).
- **Нужно от W0/ci при сборке:** `extraResources: {from: ../../packages/prsloy-harness, to:
  prsloy-harness}`. Пока пакета нет, загрузчик молчит (`harnessLoaded:false` в `getState`).

## Как проверено (Linux, без ключа шлюза)
- `pnpm --filter @zeno/desktop test`: **105 files / 731 tests passed**, `fetch-runtimes.test.mjs`
  ok, `after-pack` ok, file budgets ok.
- `packages/agent-runtime`: 28 files / 115 tests passed, включая новый `runtime-hooks.test.ts`:
  - runtime key без ключа на диске;
  - extensionPaths;
  - доверие к AGENTS.md.
- `vp check --no-fmt`: 0 ошибок и предупреждений. `pnpm --filter @zeno/desktop build` проходит.
- Провайдер через настоящий pi runtime против мок-шлюза (`prsloy-provider.test.ts`,
  `MockGatewayServer` в test-utils):
  - модель по умолчанию — deepseek;
  - `Authorization: Bearer`, есть `max_tokens`, нет `max_completion_tokens`, `store` и роли
    `developer`;
  - `reasoning_content` возвращается побайтно на сообщении с tool_call и на всех прошлых
    ассистентских;
  - у Opus только `off`, нет `reasoning_effort`, `thinking`, `reasoning`.
  - Форма первого запроса DeepSeek:
    `{"model":"deepseek-v4.1-flash-1017","stream":true,"stream_options":{"include_usage":true},"max_tokens":64000,"thinking":{"type":"enabled"},"reasoning_effort":"high"}`.
- Первый запуск по IPC против мока (`ipc.test.ts`):
  - плохой ключ → `invalid_key`, ничего не сохранено;
  - хороший → зашифрован, `models.json` указывает на шлюз, хост перезапущен;
  - мёртвый порт → `network`, `http://` не loopback → `bad_url`.
- Чистка env: unit-тесты плюс реальный `bash`:
  - все 8 шимов дают код 126 и «запрещено харнессом»;
  - `python` запускает Python 3;
  - `env` не содержит `GH_TOKEN`.
- Windows CI: прогон `desktop-windows.yml` на `desktop/core` — см. блок ниже.

## Не сделано / риски
- **Живой ключ** не проверял: ключа нет. Нужно, чтобы дирижёр проверил `/v1/models` на
  настоящем шлюзе. Если шлюз отдаёт 404, сработает fallback через completion. Баланс в UI не
  показываю: эндпоинт баланса шлюза неизвестен.
- Compat Kimi/Qwen (`thinkingFormat`, effort) взят из research/07, через живой шлюз не
  проверен.
- PortableGit: не запускаю `post-install.bat`. Для `bash -c` он не нужен, но на чистой Windows
  стоит проверить `git status` из агента. sha256 не закреплён: впишите `gitSha256` в
  `runtimes/versions.json` по логу CI.
- Окно терминала pi TUI (режим для разработчиков) получает env без чистки секретов, чистится
  только env хоста.
- Бюджет `main/index.ts` можно опустить до 5701 строки (я вынес `workspace-paths.ts`), но
  оставил 5753, чтобы у параллельных дорожек был запас.
- `docs/prsloy/CONTEXT.md` не проходит `vp fmt` — это файл из main, я его не трогал.

## i18n: русские строки для дорожки ui (ключи уже есть в zh/en)

| Ключ | ru |
|---|---|
| prsloy.speed.fast / quality | Быстрее / Качественнее |
| prsloy.firstRun.keyTitle | Вставьте ключ PRSLOY |
| prsloy.firstRun.keySubmit / keyChecking | Продолжить / Проверяю ключ… |
| prsloy.firstRun.folderTitle / folderPick | Выберите папку проекта / Выбрать папку |
| prsloy.firstRun.keyMemoryOnly | Ключ не сохранится: в следующий раз спросим снова |
| prsloy.dev.section | Для разработчиков |
| prsloy.settings.baseUrl / baseUrlReset | Адрес шлюза / Вернуть по умолчанию |
| prsloy.settings.keyChange / keyRemove | Сменить ключ / Удалить ключ |
| prsloy.error.invalid_key | Ключ не подошёл |
| prsloy.error.no_balance | Закончился баланс |
| prsloy.error.network | Нет связи с сервером |
| prsloy.error.timeout | Сервер не отвечает |
| prsloy.error.server | Ошибка сервера, попробуйте позже |
| prsloy.error.bad_url | Неверный адрес |
| prsloy.error.shellMissing | Не найден bash: агент не сможет запускать команды |
| prsloy.undo.action / done | Откатить ход / Вернул состояние до хода {turn} |
| prsloy.undo.restoreBack / busy / empty | Вернуть как было / Сначала остановите агента / Откатывать пока нечего |
