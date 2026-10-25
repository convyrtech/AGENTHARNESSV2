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

| Сборка (windows-latest)                     | `.exe`                                              |
| ------------------------------------------- | --------------------------------------------------- |
| main до git                                 | ~211 МБ (артефакт)                                  |
| git.tar.gz                                  | 315 МБ (артефакт)                                   |
| app.asar 295→61 МБ + git.7z.exe             | **231,1 МБ** (`latest.yml` size 231148933)          |
| + locales ru/en/zh + `compression: maximum` | **223,0 МБ** (222970437 байт), цель ≤ 230 выполнена |

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

### 10. Дефекты живой приёмки (main ae269d3)

1. **Папки с `/tmp/` в пути отказывались молча** (`D:\tmp\сайт`). `isEphemeralWorkspacePath`
   (main и renderer) считал служебной любую папку с `/tmp/` или `/var/folders/`. Теперь
   служебные только собственные папки приложения (`zeno-e2e-`, `recent-ws-`, …) и
   `Documents/PRSLOY/<дата>` / `conversations`. Если папка всё же отказана, экран первого запуска
   объясняет почему: «Это служебная папка приложения — выберите другую» или «Не получилось
   открыть папку …». Тесты: `workspace.test.ts`, `FirstRunGate.test.tsx`.
2. **npm-установка `pi-mcp-adapter` при первом запуске и английская плашка про MCP.** Теперь:
   - `BUILTIN_PACKAGES = []`, при старте ничего не ставится из сети;
   - в `settings.json` засевается `extensions: ["-builtin:mcp"]` (только если у пользователя нет
     своего списка), встроенный MCP pi не грузится;
   - одноразовая миграция (`state.json` → `no-auto-mcp-adapter`) убирает `npm:pi-mcp-adapter`,
     который ранние альфы поставили сами. Английская плашка была из этого адаптера.

   Если адаптер понадобится, его нужно вшить, а не ставить из npm.

3. **После отката модель «помнила» файлы.** Новая команда хоста `session.note` вызывает
   `session.sendCustomMessage` из pi SDK: это custom message, не поддельный user-ход. После
   успешного `undoTurn` модель на следующем ходу получает: «Файлы хода N откатены… Удалены:
   hello.py… прочитай их заново». Тест через настоящий runtime (`prsloy-undo-note.test.ts`):
   заметка стоит в контексте следующего запроса перед новым промптом и сохранена в сессии.
4. **`usage.credit` у Kimi.** Шлюз отдаёт его в usage. Для альфы остаёмся на своей таблице цен
   (`PRSLOY_PRICES_USD_PER_M` × `PRSLOY_PRICE_MULTIPLIER`), `usage.credit` не читаем.

## Этап 3

### 11. Первый запуск на Windows: замер

`scripts/packaged-smoke.mjs` запускается после `pnpm package`. На Windows он работает всегда, на
других ОС — с `PRSLOY_SMOKE=1`. Это только отчёт, сборку валит лишь `PRSLOY_SMOKE_STRICT=1`.
Скрипт запускает **упакованный** `PRSLOY.exe` с чистым профилем и mock-шлюзом, ход агента
вызывает bash.

windows-latest, мс от запуска:

| окно   | runtimes распакованы | ключ сохранён | хост готов | Git распакован | первый ход с bash готов                         |
| ------ | -------------------- | ------------- | ---------- | -------------- | ----------------------------------------------- |
| 11 640 | 15 810               | 17 226        | 18 927     | 32 377         | **32 736**                                      |
| 10 632 | 14 224               | 15 824        | 17 304     | 28 021         | **28 578** (второй прогон, 61cabfb, `ok: true`) |

- Порог ~45 с не превышен. Git (~30 с) и так распаковывается в фоне параллельно со всем
  остальным, первый ход ждал его ~13 с. Распараллеливать дальше не нужно.
- Окно появляется на 11,6 с: Node/Python (tar.gz) распаковываются синхронно до окна. Если это
  мешает, следующий шаг — тоже унести их в фон.
- Проверки того же прогона на Windows, все `true`:
  - bash вызвал встроенный git и шим python3 (`42`);
  - на результате тула есть заголовок харнесса `[exit 0 · …]`;
  - `GH_TOKEN` до агента не дошёл;
  - ключа нет ни в файлах профиля, ни в stdout/stderr;
  - ACL каталога ключа (см. п. 13).

### 12. Сбои и офлайн

- **Шлюз недоступен посреди хода.** `message.failed` теперь несёт `code`:
  `network | timeout | auth | no_balance | rate_limit | server | aborted | unknown`
  (`classifyModelError` в agent-runtime). Классификатор сверен с настоящими ошибками pi 1.4:
  - `Connection error.` (порт мёртв или сброс) → `network`;
  - `terminated` (поток оборван) → `network`;
  - `401` → `auth`, `402` → `no_balance`, `429` → `rate_limit`, `502` → `server`.

  e2e `prsloy-offline`: фейковая модель остановлена → в событии `"code": "network"`. Русскую
  карточку с «Повторить» дорожка ui строит по `code`.

- **Падение хоста.** Через 1,5 с хост перезапускается на том же session file, не больше 3 раз в
  минуту (`PRSLOY_NO_AUTO_RESTART=1` выключает). После этого одна тихая плашка «Агент
  перезапущен после сбоя — разговор сохранён», она исчезает через 8 с. e2e `prsloy-crash`:
  - после crash-probe хост поднимается сам с тем же `sessionFile` и новым `runtimeId`;
  - с выключенным автоперезапуском тест падает, значит он проверяет именно перезапуск;
  - старый тест «Crash recovery» тоже проходит.

### 13. Безопасность

- **Ключ не попадает в логи.** e2e `prsloy-security` на настоящем приложении проводит ключ
  `sk-prsloy-leakcheck-<uuid>` по цепочке setKey → шифрование → хост → mock-шлюз (там он
  приходит как Bearer). Потом grep по всем файлам профиля, pi home, сессиям и логам, плюс
  stdout/stderr приложения: ключа нигде нет. То же проверено на Windows (п. 11).
- **Env агента.** Тот же e2e: bash выполняет `env`, в выводе (он уходит модели) нет ни ключа, ни
  подложенного `GH_TOKEN`/`OPENAI_API_KEY`.
- **Python-процессы вкладки «Дизайн»** (a6proxy, run.py с его pi, setup/pip) получают env
  только через allowlist `buildHarnessEnv`. Тест `design-env-scrub` фиксирует, что ни одно имя из
  шаблонов чистки (`*_TOKEN`, `*_KEY`, `AWS_*`…) и ни одно значение секрета не проходит.
- **ACL файлов с ключом на Windows.** Новый `prsloy/file-acl.ts`:
  - SID текущего пользователя берётся из `whoami /user`;
  - `icacls /inheritance:r /grant:r *SID:(OI)(CI)F` применяется к **каталогу до** записи ключа,
    так что файл с первой секунды доступен только пользователю;
  - применяется к `userData/prsloy` (зашифрованный ключ шлюза) и к каталогу ключа прокси
    дизайна. У дизайна было асинхронное `icacls` по `%USERNAME%` уже после записи файла, с
    проглоченной ошибкой;
  - на windows-latest после этого остались SYSTEM, Administrators и сам пользователь, без
    наследования. Это тот же набор, что OpenSSH на Windows требует для приватных ключей.

## Этап 4

**Готово к слиянию.** Код на `desktop/core` e0170a4 (поверх `main` fd2b38e). Windows-прогон
40164713366 зелёный: package → smoke, в том числе кириллический профиль, smoke харнесса и
удаление/переустановка. Все findings ✅, включая `harness-python-http`: `python -m http.server`
теперь стартует, `threading` на месте, п. 17. Таблицы ниже — из прогонов 40159542733 и 40163577349.

### 14. Сначала окно

- `main/prsloy/runtime-boot.ts` (`RuntimeBoot`). До окна только дешёвый план
  (`planProvisionedRuntimes`: existsSync и чтение маленьких JSON). Распаковка Node/Python/tools после
  окна, асинхронно (`provisionRuntimesAsync`):
  - tar распаковывает в `.staging-<pid>`, потом папки переименовываются на место;
  - venv создаётся асинхронно, штамп пишется последним;
  - прерванная распаковка (закрыли приложение) оставляет старое дерево или ничего, но не
    полдерева со свежим штампом. Остатки `.staging-*` удаляются при следующем запуске, дочерний
    tar умирает вместе с приложением.
- Экран ключа работает во время распаковки. Под ним одна строка «Готовлю приложение… N%»
  (`prsloy.setup.app`, ru/en/zh). Это Node/Python (по файлам из манифеста) и Git, сведённые в
  одно число (`appSetup` в `PrsloyState`).
- Ждёт только первый ход агента (`prepareTurn`).
- Хост может стартовать посреди распаковки. Перезапускать его не нужно: в его PATH и env
  (`NPM_CONFIG_PREFIX`, `NODE_BINARY`) сразу стоят будущие пути рантаймов, это фиксированные
  папки под userData. Первая версия перезапускала хост перед первым ходом. Этот ход в
  renderer считался прерванным, и в ленте появлялось «Agent Host restarted». Поймал на
  Windows, убрал.
- Копия pi CLI из asar больше не делается при старте. Синхронная копия держала main (и экран
  ключа) до 9–15 с на Windows. Теперь копия асинхронная, с уступкой event loop каждые 16
  файлов, и делается только по запросу (TUI, «Дизайн»). Хост берёт SDK из asar.
- Тестовый крючок `PRSLOY_TEST_UNPACK_DELAY_MS` (только при `ZENO_ENABLE_TEST_COMMANDS=1`)
  растягивает распаковку и воспроизводит медленный Windows-диск на Linux.

### 15. Замеры (windows-latest, чистый профиль)

Packaged smoke (`win-unpacked`, мс от запуска процесса; запуски в одном прогоне):

| прогон      | окно    | IPC экрана ключа | ключ сохранён | рантаймы готовы | Git готов | первый ход с bash |
| ----------- | ------- | ---------------- | ------------- | --------------- | --------- | ----------------- |
| этап 3      | 10 632  | —                | 15 824        | (до окна)       | 28 021    | 28 578            |
| 40159542733 | **564** | 2 554            | 6 410 (7 %)   | 17 169          | 27 347    | **28 186**        |
| 40163577349 | **622** | 2 569            | 7 031 (6 %)   | 20 708          | 30 431    | **31 193**        |

- Окно: было 10,6 с, стало 0,4–0,6 с.
- Первый ход по-прежнему 28–31 с. Его держит Git (PortableGit, 27–30 с), он и раньше
  распаковывался в фоне. Node/Python теперь готовы раньше Git.
- «Ключ сохранён» в smoke включает перезапуск хоста: тестовый режим сразу монтирует оболочку
  со своим хостом. В настоящем первом запуске экран ключа идёт до оболочки, и хоста ещё нет.
  Проверил на Linux через настоящий экран: ключ принят на 2,2 с, пока шла распаковка (до 4,0 с).
- В скобках у «ключ сохранён» — процент «Готовлю приложение…» в этот момент.
- Установленное приложение (`e2e-smoke`, `%LOCALAPPDATA%\Programs\PRSLOY`, 40163577349): окно
  0,75 с, первый ответ модели 27,8 с (Git 26,7 с), экран ключа в продуктовом режиме 1,8 с.
  Кириллический профиль: окно 0,60 с.

**Второй запуск** того же профиля (цель: окно < 3 с):

| где                         | окно    | хост готов |
| --------------------------- | ------- | ---------- |
| packaged smoke, 40159542733 | **394** | 4 526      |
| установленное, 40159542733  | **402** | 4 748      |
| packaged smoke, 40163577349 | **476** | 4 381      |
| установленное, 40163577349  | **421** | 5 707      |

Окно < 3 с выполнено с запасом. «Хост готов» включает старт utilityProcess и загрузку pi SDK из asar.

### 16. Удаление и переустановка

`e2e-smoke/smoke.spec.ts`, последний тест (только Windows CI, настоящий NSIS):

1. Запуск с профилем по умолчанию (без `--user-data-dir`), хост, дожидаемся распаковки.
   Проект пользователя создаётся в `Documents\PRSLOY\smoke-project`.
2. `Uninstall PRSLOY.exe /S`. Ждём, пока уйдут exe и сам деинсталлятор. Папка установки пуста.
   Профиль (ключ, настройки, рантаймы) и проект на месте (`deleteAppDataOnUninstall: false`).
3. Тот же установщик `/S /currentuser /D=<та же папка>`.
4. Запуск на сохранённом профиле: окно 0,36–0,71 с, рантаймы не распаковываются заново
   (`runtimes` через 1 мс после окна), bash-ход проходит, проект цел.

| прогон      | удаление | остатки в папке | переустановка | окно после | хост после | bash |
| ----------- | -------- | --------------- | ------------- | ---------- | ---------- | ---- |
| 40159542733 | 2,1 с    | нет             | 18,3 с        | 0,36 с     | 42,5 с     | ✅   |
| 40163577349 | 1,6 с    | нет             | 14,3 с        | 0,71 с     | 21,7 с     | ✅   |

В первом прогоне хост ждал копию pi CLI, которая шла параллельно. После её удаления из старта
(п. 14) хост поднимается за 21,7 с. Это первый старт свежей установки: Defender проверяет
файлы из asar.

Деинсталлятор ничего технического не спрашивает: oneClick=false показывает только
подтверждение, флажка «удалить данные» нет. В CI его не видно, там `/S`.

### 17. Найдено по дороге

- **Python на Windows был без половины stdlib.** `prunePythonRuntime` (из импорта Zeno) чистил
  POSIX-папку `lib/`, а на Windows `lib` и есть `Lib`, то есть stdlib (диск не различает
  регистр). Удалялись `threading.py`, `sqlite3`, всё на `tk*`/`thread*`. Отсюда падали `venv`,
  `logging`, `pip`. Исправлено:
  - чистка учитывает раскладку;
  - сборка падает, если не импортируются `threading, logging, venv, ensurepip, sqlite3, ssl, json,
urllib.request, concurrent.futures, asyncio`;
  - `pruneRev: 2` в манифесте и штампе, чтобы уже установленные копии распаковались заново.
- **У агента был системный node.** `processEnvironment()` ставил «общие» папки
  (`/usr/local/bin`, `C:\Program Files\nodejs`) перед бандловыми. Теперь бандловые первые.
  Packaged smoke проверяет это: `bundledNodeOnPath`, `nodeAt` = `…\runtimes\node\node.exe`.
- **Баги из STATUS-ci для core** (оба проверены в CI кириллическим профилем, все findings ✅):
  1. `tar.exe` и не-ANSI пути. Путь больше не попадает в argv tar: архив идёт в stdin, целевая
     папка задаётся как cwd. Оба пути проходят через Unicode-API. Node и Python теперь
     распаковываются под `C:\Users\Иван Петров` на раннере с ACP 1252.
  2. `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8` в env агента. `python3 -c "print('привет')"` → `привет`.
     Можно включать `SMOKE_STRICT_RU=1`.

## Этап 5

**Готово к слиянию.** Код на `desktop/core` e6f1874 (поверх `main` 8b432f0). Windows-прогон
40168401685 зелёный, все findings ✅ (кириллица, encoding, harness-python-http). Замеры —
прогоны 40167682315 и 40168401685, `windows-latest`, чистый раннер.

### 18. Профиль в `%APPDATA%\PRSLOY`

- Установленная сборка хранит профиль в `<appData>/PRSLOY` (`main/prsloy/user-data.ts`). Модуль
  импортируется в `main/index.ts` первым, до любого `getPath("userData")`. Dev-сборки и явный
  `--user-data-dir` (тесты, smoke) не трогаются.
- Только `app.setPath`, без `setName`. Запись safeStorage в keychain/libsecret привязана к имени
  приложения, поэтому ключ продолжает расшифровываться.
- Одноразовый перенос старого `<appData>/@zeno/desktop`:
  - `rename` (атомарно, ACL сохраняется), пустая `@zeno` удаляется;
  - если `rename` не прошёл, дерево копируется, а в старом остаётся `MOVED-TO-PRSLOY.txt`, чтобы
    больше его не трогать; если не прошла и копия, приложение остаётся на старом профиле;
  - абсолютные пути в JSON профиля переписываются;
  - рантаймы распаковываются заново, потому что venv хранит путь к интерпретатору;
  - ACL каталога ключа заново ставит `bootstrapPrsloy` при каждом старте.
- Windows smoke `upgrade`: приложение пишет профиль по старому пути (ключ через `setKey`, адрес
  шлюза, рантаймы), потом запускается как обычно. Профиль переехал в `…\Roaming\PRSLOY`, старого
  нет, `hasKey: true`, адрес шлюза тот же, bash-ход ✅, рантаймы снова под PRSLOY.
- Почему не «старый установщик → новый»: релизов ещё нет, а артефакт прошлой сборки в smoke без
  правки workflow не скачать. Раскладка профиля у старой сборки та же, отличается только путь,
  и тест создаёт её тем же приложением. Если нужен настоящий старый бинарь, это шаг для ci.
- `RELEASE-0.1.0-alpha.1.md`: путь к сессиям теперь `%APPDATA%\PRSLOY\agent\sessions`.

### 19. Первый ход «Кода» на свежей установке

Из чего складывались 28–31 с: Git (7z SFX) 27–30 с, Node/Python 17–21 с (из них tar ~5,5 с,
venv ~4,5 с) — всё параллельно после окна.

Выбран вариант «Git распаковывает установщик» (`build/installer.nsh`, `customInstall`):

- NSIS запускает тот же `git.7z.exe` в `<папка установки>\resources\runtimes\git`. При успехе
  пишет маркер и удаляет архив (57 МБ). Приложение берёт это дерево сразу (`isInstallerGit` →
  `GitRuntime.readyDir`). Без маркера — запасной путь: фоновая распаковка в userData, как раньше.
- Дерево живёт в папке установки: удаление и обновление заменяют его вместе с приложением,
  версия всегда совпадает.

| установленное приложение | до (этап 4) | теперь          |
| ------------------------ | ----------- | --------------- |
| установка                | 19,8 с      | 32,6–38,8 с     |
| окно                     | 0,75 с      | **0,35–0,41 с** |
| первый ход с bash        | 27,8 с      | **11,1–13,3 с** |
| Git на первом запуске    | 26,7 с      | 0 (готов сразу) |

- Цель < 15 с выполнена. Теперь первый ход держат Node/Python (10,5–11,9 с: tar 6,0–6,7 с,
  venv 4,5–5,2 с).
- Кириллический профиль: установка 35,0 с, Git из установщика, все findings ✅. Проверку Git там
  пришлось перевести на `getState()`: строка «PortableGit: ready» теперь печатается раньше, чем
  тест начинает читать stdout.
- Рассмотренные варианты:
  - распаковывать после установки в фоне: гонка с первым запуском, выигрыш тот же;
  - класть дерево Git в payload NSIS: не мерил; NSIS писал бы те же ~9 000 файлов, а
    LZMA по 392 МБ, скорее всего, не меньше 7z SFX;
  - распаковывать в установщике и Node/Python: ещё ~10 с, но venv в userData всё равно нужен.
    Оставил как следующий шаг, если 11 с покажется много.

### 20. Мелкое

- `cacheRead` = 10 % от input и для qwen3.8-max и claude-opus-5-5, тест проверяет это для всех
  моделей. Без него чтение из кэша считалось по полной цене input (DIARY E9: $1,73 против $0,41).
- `[prsloy-timing] untar / venv` — фазы распаковки рантаймов в логе main.
- Хук надёжного прокси харнесса пока не пришёл. Когда придёт, посмотрю и смержу отдельно.

## Как проверено (Linux, без ключа шлюза)

- `pnpm check` чистый. `pnpm test` (корень) зелёный:
  - desktop: **936 tests** (этап 4), agent-runtime 118, harness 137, плюс `fetch-runtimes`, `after-pack`,
    `packaged-smoke`, file budgets;
  - harness: 8 files / 104 tests.
- e2e (`xvfb-run playwright test`, весь набор): 33 passed (включая prsloy-harness, -crash, -offline, -security), 5 failed. Все 5 падают так же на
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

- Первый вход во вкладку «Дизайн» на Windows делает копию pi CLI (~10 с, без заморозки окна).
- Установленная папка выросла с 488 до 822 МБ: PortableGit лежит там распакованным. Раньше он
  занимал столько же в userData, общий объём на диске тот же.
- `win-unpacked` (packaged smoke) идёт без NSIS, поэтому там Git по-прежнему распаковывается в
  фоне, и первый ход занимает ~28–31 с. Это проверка запасного пути, не установки.

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
