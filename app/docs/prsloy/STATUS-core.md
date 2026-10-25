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

- Каталог в `apps/desktop/src/shared/prsloy-config.ts`. Он же — **единственный источник для
  режимов скорости**:
  - `PRSLOY_SPEED_MODES`: `fast` → `deepseek-v4.1-flash-1017`, `quality` → `kimi-k3.1-pro`;
  - подписи — ключи ui `composer.tier.fast` / `composer.tier.quality`;
  - `renderer/lib/model-tiers.ts` (`MODEL_TIERS`, `MODEL_TIER_PROVIDER`) выводится из него,
    дубликата нет.
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
- Цены: `PRSLOY_PRICES_USD_PER_M` (замеренная себестоимость шлюза, $/1M) и множитель
  `PRSLOY_PRICE_MULTIPLIER` (по умолчанию 1; владелец поставит розницу). Попадают в `cost`
  моделей pi, значит в рубли тоже. Тест: pi сам считает цену хода 10 in / 5 out токенов.
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

  | Код           | Когда             |
  | ------------- | ----------------- |
  | `invalid_key` | 401/403           |
  | `no_balance`  | 402               |
  | `network`     | нет соединения    |
  | `timeout`     | сервер не ответил |
  | `server`      | 5xx               |
  | `bad_url`     | неверный адрес    |

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

- `fetch-runtimes.mjs` для win32:
  - **PortableGit 2.51.0** едет как есть — исходный 7z-самораспаковщик `archives/git.7z.exe`
    (56,6 МБ, sha256 закреплён в `versions.json`). Это меньше любого tar.gz дерева (было 96,5–141
    МБ);
  - **ripgrep 14.1.1 + fd 10.2.0** → `archives/tools.tar.gz`.
- Первый запуск:
  - `main/prsloy/runtime-git.ts` распаковывает Git **в фоне** его же ключами `-y -o<папка>` во
    временную папку и переименовывает в `userData/runtimes/git`. Полураспакованное дерево не
    используется. Версия записана в штамп, процент считается по числу файлов (их число
    записывается при сборке);
  - на экране первого запуска тихая строка «Готовлю окружение для команд… N%»
    (`PrsloyState.gitSetup`);
  - первый ход агента ждёт Git не дольше 3 минут (`prepareTurn`);
  - после распаковки `shellPath` и git для снимков переключаются на встроенный Git.
    На раннере распаковка заняла 18,4 с, 9271 файл.
- `settings.json` → `shellPath`: встроенный `git\bin\bash.exe` → системный Git for Windows →
  иначе всё равно встроенный путь, тогда pi пишет «shell not found». **До `where bash.exe` (WSL)
  дело не доходит никогда.** Тест: `windows-shell.test.ts`.
- rg/fd копируются в `<agentDir>/bin`: pi ищет их там первым делом. `PI_OFFLINE=1`.
- Шимы `python3` и `python` (+ `.cmd`) ведут на venv/встроенный Python и стоят первыми в PATH
  агента; Store-заглушку `python` они тоже перекрывают. **Проверено в Git Bash на windows-latest**
  (смоук в `fetch-runtimes`, тот же формат скрипта закреплён в `agent-env.test.ts`):
  `python3` → `…\runtimes\win32-x64\python\python.exe`, `python --version` → `Python 3.12.13`.
- Тул `powershell` выключен. В env агента `GIT_EDITOR`/`EDITOR`/`VISUAL=true`,
  `GIT_PAGER`/`PAGER=cat`: ничто интерактивное не повиснет.
- MinGit-busybox не понадобился: в MinGit нет bash, только `ash` из busybox.

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

### 7. Харнесс (`@prsloy/harness`)

- Хост в каждой сессии подключает `createPrsloyHarness()` через `extensionFactories` (новая
  опция `createPixRuntime`). Харнесс вшит в бандл хоста, поэтому asar ему не мешает и пути к
  файлам не нужны.
- Профиль берётся из `PRSLOY_PROFILE=code`: main ставит его в env хоста.
  `PRSLOY_HARNESS=0` выключает харнесс (`harnessLoaded` в `getState`).
- Загрузчик по путям (`harness-paths.ts`) удалён, `extraResources` для харнесса не нужен.
  Опция `extensionPaths` осталась в runtime как общий механизм.

### 8. Размер установщика

| Сборка (windows-latest)                     | `.exe`                                     |
| ------------------------------------------- | ------------------------------------------ |
| main до git                                 | ~211 МБ (артефакт)                         |
| git.tar.gz                                  | 315 МБ (артефакт)                          |
| app.asar 295→61 МБ + git.7z.exe             | **231,1 МБ** (`latest.yml` size 231148933) |
| + locales ru/en/zh + `compression: maximum` | см. ниже                                   |

- `app.asar` содержал все зависимости рендерера (mermaid 86 МБ, lucide 32 МБ, highlight,
  katex, cytoscape, react…), хотя vite уже собрал их в `dist/`. В `dependencies` остались только
  нужные в рантайме: pi SDK, node-pty, photon-node, electron-updater. Остальное ушло в
  devDependencies. Ещё не упаковываются `*.map` и `*.d.ts`. Итог: asar 295 → 61 МБ.
- Проверено: собранный linux-пакет (`electron-builder --linux dir`) проходит e2e
  (`PRSLOY_E2E_PACKAGED=<…/PRSLOY>`). Те же 5 падений, что и на main, плюс crash-probe: его
  бэкдор регистрируется только в неупакованной сборке, так задумано.

### 9. Автообновление

- `DEFAULT_UPDATE_FEED` указывал на **aletheics/zeno**. `setFeedURL` перекрывает
  `app-update.yml`, так что приложение проверяло бы релизы Zeno. Исправлено на
  `convyrtech/AGENTHARNESSV2`.
- `allowPrerelease = true`. Одна тихая проверка при запуске; найденное обновление скачивается в
  фоне. Когда оно готово, появляется одна плашка «Обновление готово — перезапустить»
  (`UpdateReadyNotice`, × прячет её до конца сеанса). В простом режиме кнопка в сайдбаре не
  показывает проверку и ошибки. В тестовом режиме (`ZENO_ENABLE_TEST_COMMANDS=1` или
  `PRSLOY_NO_UPDATE=1`) проверок нет вовсе.
- **Нужно поменять тег в workflow (дорожка ci).** GitHub-провайдер electron-updater 6.8.9 при
  `allowPrerelease` читает releases.atom и пропускает теги, которые не являются semver.
  `desktop-v0.1.0-alpha.N` не semver, `v0.1.0-alpha.N` — semver. Проверено на настоящем
  `GitHubProvider` с локальным фидом (`auto-update-tags.test.ts`):
  - `desktop-v*` → `ERR_UPDATER_NO_PUBLISHED_VERSIONS`;
  - `v*` → `v0.1.0-alpha.3 → 0.1.0-alpha.3`.

  Предложение: триггер `tags: ["v*"]`, версия `${GITHUB_REF_NAME#v}`, релиз как prerelease с
  тегом `v<version>`.

- Канал: на `0.1.0-alpha.N` updater сначала ищет `alpha.yml`, затем `latest.yml`. Workflow
  кладёт `latest.yml`, этого достаточно.

## Как проверено (Linux, без ключа шлюза)

- `pnpm check` чистый. `pnpm test` (корень) зелёный:
  - desktop: **112 files / 763 tests**, плюс `fetch-runtimes`, `after-pack`, file budgets;
  - harness: 8 files / 104 tests.
- e2e (`xvfb-run playwright test`, весь набор): 28 passed, 5 failed. Все 5 падают так же на
  чистом `origin/main` (прогнал отдельно), то есть они не из этой ветки:
  - вставка из буфера обмена;
  - rich content;
  - palette/theme/fork;
  - collapse sidebar/appearance;
  - overlay scrollbar.
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
- Харнесс:
  - `agent-host/prsloy-harness.test.ts`: опции хоста против фейковой модели; bash tool result
    приходит модели как `[exit 0 · … ]\nharness-ok`, в том числе после `newSession()`;
  - **e2e на настоящем Electron** (`e2e/prsloy-harness.spec.ts`, xvfb, Electron 43.1.1 с
    npmmirror): фейковая модель получает tool result с заголовком `[exit 0 · …]`;
  - с `PRSLOY_HARNESS=0` тот же e2e падает (приходит голое `harness-e2e`), значит проверка не
    пустая.
- Windows CI (`desktop-windows.yml` на `desktop/core`, оба прогона зелёные):
  - PortableGit скачан и обрезан, `bash-ok git version 2.51.0.windows.1`;
  - распаковка архива туда и обратно проходит, установщик собран.

## Не сделано / риски

- **Живой ключ** не проверял: ключа нет. Нужно, чтобы дирижёр проверил `/v1/models` на
  настоящем шлюзе. Если шлюз отдаёт 404, сработает fallback через completion. Баланс в UI не
  показываю: эндпоинт баланса шлюза неизвестен.
- Compat Kimi/Qwen (`thinkingFormat`, effort) взят из research/07, через живой шлюз не
  проверен.
- PortableGit: не запускаю `post-install.bat`. Для `bash -c` он не нужен, но на чистой Windows
  стоит проверить `git status` из агента.
- Окно терминала pi TUI (режим для разработчиков) получает env без чистки секретов, чистится
  только env хоста.
- Бюджет `main/index.ts` можно опустить до 5701 строки (я вынес `workspace-paths.ts`), но
  оставил 5753, чтобы у параллельных дорожек был запас.
- Папки по умолчанию переименованы дорожкой ui (`Documents/PRSLOY`). Классификаторы
  временных и разговорных папок в main и renderer (`isAutoDefaultWorkspacePath`,
  `isConversationWorkspacePath`) ещё искали `/Zeno/`. Теперь они принимают обе папки, иначе
  дневные scratch-папки попадали бы в список проектов.

## i18n

- Все ключи `prsloy.*` есть в ru (язык по умолчанию), zh и en.
- Свои `prsloy.speed.*` я убрал в пользу `composer.tier.*` от дорожки ui.
