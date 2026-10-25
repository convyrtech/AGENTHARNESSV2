# STATUS — дорожка W2 «харнесс»

Ветка `desktop/harness`. Пакет `app/packages/prsloy-harness` (`@prsloy/harness`): расширение Pi 1.4 для
каждой сессии агента. Описание практик и источники — в `app/packages/prsloy-harness/README.md`.

## Что сделано

| #   | Практика                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Файл                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Таймаут bash 120 с (до 600 по просьбе модели), то же для `powershell`; по таймауту — «процесс остановлен» с началом и концом вывода; серверы и вотчеры сразу уходят в фон; тулы `bash_background` и `process` (list/logs/stop) — реестр процессов и портов; фон гасится на `session_shutdown`, ключи машины фону не отдаются                                                                                                                                      | `src/bash-timeout.ts`, `src/process-registry.ts` |
| 2   | Детектор петель: 3-й одинаковый вызов с тем же результатом блокируется с «Этот вызов уже был 2 раза с тем же результатом. Сделай другое: …», 5-й останавливает задачу (`terminate`, дальше `abort`); псевдовызовы текстом (Hermes/Qwen, Llama, XML, Kimi, DeepSeek, Mistral, JSON) не исполняются, модели — напоминание и ещё ход; вызовы из ответа, обрезанного по `length`, не исполняются (это уже делает Pi 1.4 — здесь страховка и подсказка «пиши частями») | `src/loop-detector.ts`                           |
| 3   | Бюджет задачи: 150 вызовов и $0.50 (цены из `usage.cost` или таблицы цен модели); 80% — предупреждение в результате тула; 100% — тулы не выполняются, модель пишет итог по-русски, плюс видимое сообщение «Задача остановлена: …» с изменёнными файлами                                                                                                                                                                                                           | `src/budget.ts`                                  |
| 4   | Вывод тулов: 30 КБ в контексте; bash — начало и конец из полного вывода (Pi оставляет только конец); заголовок `[exit · время · размер]`; read — «дальше offset=N»; большие результаты остальных тулов — в файл с превью                                                                                                                                                                                                                                          | `src/tool-output.ts`                             |
| 5   | Проверка синтаксиса после `edit`/`write` в результате тула: js (`node --check`, ESM в `.js` — как `.mjs`), ts/tsx/jsx (typescript, иначе Node strip-types), json/jsonc, py (`compile`, без `__pycache__`), html (баланс тегов), css (postcss)                                                                                                                                                                                                                     | `src/post-edit-verify.ts`, `src/checkers.ts`     |
| 6   | Устойчивость правок: 2 провала `edit` в одном файле → перечитать / переписать (для >500 строк — только перечитать кусок); `write` поверх файла сохраняет BOM и CRLF                                                                                                                                                                                                                                                                                               | `src/edit-robustness.ts`                         |
| 7   | Чистка секретов из результатов тулов и `structuredContent` с пометкой                                                                                                                                                                                                                                                                                                                                                                                             | `src/secret-scrub.ts`                            |
| 8   | Раздел «поиск готового» (E3, дословно) в системном промпте, только профиль «Код»                                                                                                                                                                                                                                                                                                                                                                                  | `src/reuse-prompt.ts`                            |

Подключение: `createPrsloyHarness(options)` для `extensionFactories`, `register(pi)` / default export для
загрузки по пути. Ветка `desktop/core` уже передаёт `extensionPaths` в `createPixRuntime` — туда достаточно
добавить путь к `app/packages/prsloy-harness/src/index.ts` (или к каталогу пакета: в `package.json` есть
`pi.extensions`). Оба способа проверены интеграционным тестом. Профиль при загрузке по пути — `PRSLOY_PROFILE`.

Попутно: `app/docs/prsloy/CONTEXT.md` переформатирован (только пустые строки после заголовков) — без этого
`pnpm check` падал уже на `main`.

## Как проверено

Все команды — из `app/`, Linux, Node 22.22, Python 3.13.

```
$ pnpm check
pass: All 470 files are correctly formatted
pass: Found no warnings, lint errors, or type errors in 428 files

$ pnpm test                       # весь репозиторий, exit 0
 Test Files  8 passed (8)         # @prsloy/harness
      Tests  104 passed (104)
 Test Files  27 passed (27)       # agent-runtime
      Tests  111 passed (111)
 Test Files  92 passed (92)       # desktop
      Tests  669 passed (669)
```

Интеграционный тест (`test/integration.test.ts`): настоящая `createAgentSession` Pi 1.4, модель — локальный
мок OpenAI-совместимого шлюза (`test/scripted-openai-server.ts`), модель всё время зовёт один и тот же тул:

```
✓ loop detector: 3rd identical call gets the note, 5th stops the task
✓ bash timeout: a hanging command is stopped and the model is told so        (1 с вместо 30)
✓ budget: at the limit tools stop and a Russian summary is appended
✓ pseudo tool call written as text is not executed; the model is asked for a real call
✓ loads from a file path like the agent host does: tools registered, post-edit check and secret scrub fire
✓ loads as a Pi package directory (package.json pi.extensions)
```

Модульные тесты — на мок `ExtensionAPI` с семантикой `ExtensionRunner` Pi 1.4 (`test/mock-pi.ts`: блок в
`tool_call` останавливает цепочку, `tool_result` идёт цепочкой и теряет `structuredContent`, если его не
вернуть, `turn_end` заменяет список записей). Проверки синтаксиса гоняются на настоящих `node`, `python3`,
typescript и postcss.

Независимое ревью кода (отдельный агент) нашло 12 проблем; все исправлены и покрыты тестами. Главные: петля
продолжала блокировать `npm test` после исправления кода; `npm i -D vite` уходил в фон как сервер; записи
других расширений на `turn_end` затирались; обрезанный приватный ключ и ключи Stripe проходили; модель могла
записать «[СКРЫТО…]» в файл вместо настоящего ключа (теперь такая запись блокируется); пути Git Bash
(`/c/…`) на Windows разрешались не так, как в Pi.

Ещё находка: `node --check` в Node 22 для `.js` с `import`/`export` без `"type": "module"` молча возвращает 0,
не разбирая файл. Такие файлы перепроверяются как `.mjs`.

## Что сознательно не сделано

- **Таймаут не уводит уже идущую команду в фон** (Claude Code так делает): процесс запускает bash-тул Pi, и
  перехватить его на лету можно только подменой тула `bash`. Подмена обошла бы настройку bash в ядре (чистое
  окружение, шимы). Вместо этого серверы распознаются до запуска и сразу идут в фон, а по таймауту процесс
  останавливается с понятной подсказкой.
- **Счётчик петель сбрасывается на каждое сообщение пользователя**, а не живёт всю сессию: если пользователь
  сам просит «запусти тесты ещё раз», это не петля. Внутри задачи — как в задании (3 → блок, 5 → стоп). Повтор
  считается петлёй, только если результат тоже не меняется (тесты после правки — не петля).
- **typescript в рантайме приложения не гарантирован**: в `apps/desktop` он только в devDependencies. Тогда `.ts`
  проверяется встроенным удалением типов Node, а `.tsx`/`.jsx` пропускаются. Класть ли typescript (~24 МБ) в
  установщик — решение ядра/сборки. postcss и typebox — обычные зависимости пакета.
- **Python**: проверка `.py` ищет `PRSLOY_PYTHON`, потом `python3`/`python`/`py`. Портативный Python приходит с
  дорожкой «Дизайн» (W4); пока его нет, проверка `.py` тихо пропускается.
- Не входило в задание и не делалось: ремонт аргументов и повтор битого вызова (ADR-3), стоп-гейт «тесты до
  зелёного» (ADR-6), lint/typecheck сверх синтаксиса, порт прокси надёжности на TS (PLAN W2), UI для сообщений
  бюджета (дорожка UI), подключение в agent host (дорожка ядра), `.github/`.
- Чистка секретов — только результаты тулов (как в задании). Сообщения пользователя не трогаем: ключ, который
  пользователь вставил сам, — его решение.

## Этап 2 — по живой приёмке №2 (DeepSeek, Kimi)

| #   | Что нашла приёмка                                                                           | Что сделано                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Где                                                                      |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `(python3 -m http.server 8099 … &)` мимо реестра: `looksLikeServer` пропускал команды с `&` | Команда разбирается (кавычки, скобки, `&&` против одиночного `&`, `2>&1`, `$(…)`). Фоновая задача, похожая на сервер (`looksLikeServer` или `node server.js`, `python app.py`…), запускается через реестр в каталоге с учётом `cd` перед ней; в команде вместо неё `:;`, остальное выполняется как было. В результат тула — строка с id, PID, портом и логом. `PYTHONUNBUFFERED=1` для фона, иначе баннер python с портом не виден. Фон гасится и при гибели хоста сигналом (через `signal-exit`, который уже держит Pi: свой обработчик сломал бы его повтор сигнала) | `src/shell-rewrite.ts`, `src/bash-timeout.ts`, `src/process-registry.ts` |
| 2   | `pkill -f "http.server 8099"` убил свой `bash -c` (exit 143)                                | `pkill`/`killall` по процессу из реестра — через реестр. Прочий `pkill -f` → `__prsloy_pkill`, который пропускает группу процессов самого тула (Pi ставит bash в отдельную группу). На Windows `pkill -f` блокируется с подсказкой. `pkill bash`, `killall node`, `taskkill /IM node.exe`/`bash.exe`/`prsloy` блокируются. `process action=stop port=<порт>` — остановка по порту, в том числе сервера не из реестра (lsof/ss, на Windows `netstat -ano`)                                                                                                              | там же                                                                   |
| 3   | Модели просили владельца запустить `python3 -m http.server`                                 | В профиле «Код» раздел `prsloy_casual_user`: не просить запускать команды; показать страницу — путь к файлу или своё превью и ссылка `http://127.0.0.1:<порт>`                                                                                                                                                                                                                                                                                                                                                                                                         | `src/reuse-prompt.ts`                                                    |

Выбор для п. 1 — переписывать, а не следить за PID после запуска: процесс из `(cmd &)` переподчиняется init,
и найти его потом можно только гаданием по порту или командной строке. Обоснование — в README пакета.

Как проверено (из `app/`, Linux):

```
$ pnpm check
pass: All 609 files are correctly formatted
pass: Found no warnings, lint errors, or type errors in 562 files

$ pnpm test                         # exit 0
 Test Files  9 passed (9)           # @prsloy/harness
      Tests  135 passed (135)
 Test Files  29 passed (29)         # agent-runtime
      Tests  118 passed (118)
 Test Files  136 passed (136)       # desktop (в том числе prsloy-harness.test.ts хоста)
      Tests  903 passed (903)
```

Новые тесты:

- `test/shell-rewrite.test.ts` — разбор фоновых задач и kill-команд; на настоящих процессах: простой
  `pkill -f` внутри `bash -c` убивает свой shell (exit 143, воспроизведение бага), переписанный — убивает цель,
  shell жив (`rc=0`).
- `test/bash-timeout.test.ts` — `(node server.js … &) && sleep 1 && echo next` → `(:;) && sleep 1 && echo next`
  и сервер в реестре с портом; `pkill -f` по нему идёт через реестр; остановка по порту; блок `pkill bash` /
  `killall node` / `taskkill /IM node.exe`; хост, убитый SIGTERM, уносит фон с собой (без хука тест падает —
  проверено).
- `test/integration.test.ts` (настоящая `createAgentSession` + мок-шлюз), сценарий приёмки:
  `(python3 -m http.server PORT > /dev/null 2>&1 &) && sleep 1 && curl …` → 200 и сервер в реестре;
  `sleep … &` и потом `pkill -f "sleep …"` → `rc=0`, exit 0, sleep убит; `pkill -f "http.server PORT"` →
  через реестр, порт свободен; `python3 -m http.server PORT &` гаснет на `session_shutdown`.

Найдено по ходу: `registry.matching` считал любое число в шаблоне портом (`sleep 403.<порт>` совпал с
сервером) — теперь порт только в виде `:8099`.

Не сделано: на Windows `__prsloy_pkill` не работает (нет групп процессов), поэтому там `pkill -f` блокируется,
а не переписывается; Windows-ветки (`taskkill`, `netstat`) проверены только разбором, живой проверки под
Windows нет — её даёт CI `windows-latest`.

## Этап 3 — ветки Windows вживую

### Сначала: хост падал при старте (регрессия этапа 2)

При локальном прогоне собранного `apps/desktop` (Electron под xvfb) `Start Host` не поднимался:
`Agent Host exited with code 1: Calling require for "assert" in an environment that doesn't expose the
require function`. Причина — мой импорт `signal-exit@3` (CommonJS) на этапе 2: `vite.agent.config.ts`
собирает хост в ESM-бандл, и `require("assert")` внутри него падает. `pnpm test` этого не видел: юнит-тесты
не запускают бандл. Исправлено в b137761 (отдельный коммит):

- `signal-exit` не импортируется; подписка на общий эмиттер, который уже держит копия Pi
  (`process.__signal_exit_emitter__` / `Symbol.for("signal-exit emitter")`) — ровно то, что делает `onExit()`;
  без него — свои обработчики сигналов, только если сигнал никто не слушает.
- `postcss` (тоже CommonJS) в бандле не грузится (`require("fs")`): проверка CSS переходит на встроенную
  проверку комментариев, строк и скобок. Чтобы работали все CommonJS-зависимости хоста, ядру стоит добавить в
  `vite.agent.config.ts` баннер `import { createRequire } from "node:module"; const require =
createRequire(import.meta.url);` — файл не мой, не трогал.
- Новый тест `test/host-bundle.test.ts` собирает пакет так же, как хост (ESM, внешние — только Pi и модули Node),
  и запускает его в чистом Node: загрузка, все практики, проверка CSS.

### Smoke-спека `apps/desktop/e2e-smoke/harness.spec.ts`

Самодостаточна (свой запуск приложения и свой мок модели: `helpers.ts` фиксирует `ZENO_TOOLS=read,bash` и
одновызовный `FakeOpenAiServer`). Модель на каждое «harness step N» делает один вызов; проверяется текст
результата тула, который приложение вернуло модели:

| Шаг | Вызов                                                                                 | Ожидание                                                                                                                    |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `(python -m http.server P > srv.log 2>&1 &) && sleep 2 && curl … http://127.0.0.1:P/` | `[exit 0`, `200`, «запущен через реестр харнесса», `порт P`                                                                 |
| 2   | `pkill -f "http.server P"; echo shell-alive`                                          | `[exit 0`, `shell-alive`, «выполнено через реестр: остановлены bg1», порт P свободен                                        |
| 3   | `echo before-hang; sleep 60; echo never` при `PRSLOY_BASH_TIMEOUT_SEC=5`              | `before-hang`, без `never`, «[Процесс остановлен по таймауту 5 с.]»                                                         |
| 4   | `taskkill /IM bash.exe /F`                                                            | «не выполнено» и подсказка `process action=stop`                                                                            |
| 5   | `write broken.js` с `const a = ;`                                                     | «[Проверка синтаксиса (node --check): ОШИБКА в broken.js», `SyntaxError` (node — сам PRSLOY.exe с `ELECTRON_RUN_AS_NODE=1`) |
| 6   | `python -m http.server Q &`, затем выход из приложения                                | порт Q отвечал, после выхода свободен                                                                                       |

Артефакты в `smoke-out/` (их уже выгружает шаг `prsloy-win-smoke`): `harness-requests.jsonl` (все запросы к
модели), `harness-sessions/*.jsonl` (сессия pi), `harness-results.json`, `harness-steps.png`, логи main/renderer.

Для этого в пакете: `PRSLOY_BASH_TIMEOUT_SEC` (таймаут bash по умолчанию из env, как `PRSLOY_PROFILE`) и
очистка цветов node в строке проверки синтаксиса.

`.github/workflows/desktop-windows.yml`: одна строка — `harness.spec.ts` добавлен в список шага «Smoke test
(installed app)». Больше `.github/` не трогал.

### Как проверено

Локально (Linux, собранный `apps/desktop`, Electron 43 под xvfb, `SMOKE_DEV_APP=$PWD`):

```
✓ 1: `(python -m http.server &)` goes to the harness registry (3.1s)
✓ 2: pkill -f is routed through the registry, the shell survives (380ms)
✓ 3: a hanging command hits the harness bash timeout (6.1s)
✓ 4: taskkill of bash.exe is blocked with the hint (270ms)
✓ 5: a broken .js write gets the post-edit syntax line (767ms)
✓ 6: a background server left running dies with the app (751ms)
6 passed (16.3s)
```

`pnpm check` — чисто; `pnpm test` — exit 0 (harness 138, agent-runtime 118, desktop 903).

Windows (`workflow_dispatch` `desktop-windows.yml` на `desktop/harness`, run 40160871223): WINDOWS_RESULT
