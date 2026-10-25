# STATUS: дорожка ci (W0 + W5)

## Этап 2: русская Windows в smoke

Прогон: https://github.com/convyrtech/AGENTHARNESSV2/actions/runs/40157744892 (зелёный; ниже — что он нашёл).
Smoke теперь из трёх файлов: `smoke.spec.ts` (как было), `firstrun.spec.ts`, `cyrillic.spec.ts`. Общий запуск —
`e2e-smoke/helpers.ts`.

### Что проверяется

1. **Первый запуск без обхода** (`firstrun.spec.ts`, без `ZENO_ENABLE_TEST_COMMANDS`). Мок шлюза PRSLOY на
   `127.0.0.1`; его адрес записан в `userData\prsloy\state.json`, как будто пользователь сменил его в настройках.
   - Неверный ключ → «Ключ не подошёл. Проверьте, что скопировали его целиком» (`11-firstrun-wrong-key.png`).
   - Верный ключ → «Выберите папку проекта» (`12-firstrun-folder.png`). Папка `Мой проект`: системный диалог
     подменён в main через `dialog.showOpenDialog`.
   - Дальше открывается приложение (`13-firstrun-app.png`), и один ход идёт **через настоящий провайдер PRSLOY**.
     Шлюз получил `POST /v1/chat/completions` с введённым ключом: ключ доходит до агента
     (`14-firstrun-reply.png`).
   - ✅ На Windows всё проходит: экран ключа через 13,7 с после запуска.
2. **Проверка обновлений без сети.** Все запросы Chromium идут через локальный «мёртвый» прокси
   (`--proxy-server`); loopback его обходит, поэтому шлюз работает.
   - Режим «нет сети»: прокси рвёт соединение. Режим «сеть висит»: прокси молчит.
   - В обоих режимах апдейтер действительно пошёл в сеть (`CONNECT github.com:443`).
   - Ошибки на экране нет (`15-…`, `17-…`).
   - Старт не задерживается: экран ключа через 12,6 с, когда сеть висит, и через 13,7 с, когда её нет.
   - Выход быстрый: 0,19 с, хотя запрос к GitHub висит.
   - ✅ Всё в порядке.
3. **Кириллический профиль** (`cyrillic.spec.ts`). Второй тихий установщик с `/D=C:\Users\Иван Петров\AppData\
Local\Programs\PRSLOY`.
   - Окружение: `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP` и userData лежат в `C:\Users\Иван Петров\…`.
     Проект — `C:\Проекты\мой сайт`.
   - Приложение видит именно эти пути (`cyrillic-env.json`): exe, userData, Documents и Temp — кириллические.
   - Один ход bash: `cd 'C:\Проекты\мой сайт'`, `python3 -c "print('привет')"`, запись `заметка о сайте.txt`.
   - Учётку Windows с кириллическим именем не заводил: GUI-сессию под другим пользователем в Actions не
     запустить. Подмена переменных профиля плюс установка в кириллическую папку покрывают те же пути.

### Что нашёл (баги для core; в CI пока как findings, не роняют сборку)

Проверки по известным открытым багам пишутся в `metrics.json → findings` и в аннотации теста. С
`SMOKE_STRICT_RU=1` они станут обязательными. Включить, когда core починит.

| Проверка                                                                            | Итог                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| PortableGit распакован (7z SFX) под кириллицей                                      | ✅ 19 с                                         |
| `cd` в `C:\Проекты\мой сайт`, `pwd` → `/c/Проекты/мой сайт`                         | ✅                                              |
| файл `заметка о сайте.txt`: в `ls`, `cat` → `тест`, на диске имя и содержимое верны | ✅                                              |
| **Node и Python распакованы в userData под кириллицей**                             | ❌ папки `runtimes\node`, `runtimes\python` нет |
| **`python3 -c "print('привет')"`**                                                  | ❌ и в кириллическом профиле, и в обычном       |

**Баг 1. Распаковка Node/Python ломается на пути не из ANSI-кодировки.**

- `runtime-provision.ts` вызывает `C:\Windows\System32\tar.exe` (bsdtar). Тот гонит аргументы через ANSI-кодовую
  страницу.
- Проба (`tar-probe.json`, тот же `execFileSync`) на раннере с ACP 1252 / OEM 437 (`codepage.json`):
  - кириллица в пути архива → `tar.exe: Error opening archive: Failed to open 'C:\Users\???? ??????\…'`;
  - кириллица в `-C` → `could not chdir to 'C:\Users\???? ??????\…'`;
  - кириллица в относительном пути тоже ломается; проходит только ASCII → ASCII.
- Последствие: у пользователя нет бандлового Node и Python. Агент молча берёт системные (если они есть), а
  «Дизайн» лишается своего Python.
- Кого задевает. На русской Windows ACP = 1251, кириллица в ней есть, так что «Иван Петров» на русской
  Windows, скорее всего, пройдёт. Проверить в Actions нельзя: смена системной локали требует перезагрузки.
  Ломается кириллический профиль на Windows с английской/иной системной локалью и любые символы вне 1251.
- Предложение: распаковывать в Node без внешнего `tar.exe`. Например, пакет `tar` (node-tar), чистый JS: пути
  идут через Unicode-API Node. Обойти через ASCII-временную папку нельзя: TEMP у такого пользователя тоже
  кириллический.

**Баг 2. Python в bash агента пишет в ANSI-кодировке.**

- `python3 -c "print('привет')"` через шим core в бандловый Python, в обычном ASCII-профиле, падает:
  `UnicodeEncodeError: 'charmap' codec can't encode characters … cp1252.py`. Под кириллическим профилем, где
  бандлового Python нет, так же падает системный.
- На русской Windows (cp1251) вместо падения будут кракозябры: Pi читает вывод как UTF-8.
- Окружение «Дизайна» (`design/env.ts`) уже ставит `PYTHONUTF8=1` и `PYTHONIOENCODING=utf-8`, окружение агента
  (`prsloy/agent-env.ts`) — нет.
- Предложение: те же две переменные в env Agent Host.

### Изменения в CI

- В smoke job: шаги «Silent install into a Cyrillic profile», «Probe tar with Cyrillic paths» (только отчёт),
  «Smoke test (Cyrillic profile)». Логи и userData кириллического профиля (без рантаймов) — в артефакте.
  Таймаут job — 45 мин.
- Время smoke job: ~6 мин (было ~3). Установка в кириллический профиль — 18,5 с.

Ветка `desktop/ci`. Обе сборки зелёные: `desktop-ci` (Linux: check, test, build) и `desktop-windows`
(package → smoke).

## Что сделано

1. **desktop-ci** падал на `pnpm check`: не отформатирован `docs/prsloy/CONTEXT.md`. Исправлено (`pnpm fmt`).
   `fetch-runtimes`, сборка ассетов и конфиг electron-builder под Windows менять не пришлось: `package` на
   `windows-latest` собирается как есть (NSIS, per-user, без подписи).
2. **desktop-windows** запускается на push в `main`, по тегу `v*`, на опубликованный релиз и вручную (`workflow_dispatch`); тег `v*` (не `desktop-v*`: electron-updater с `allowPrerelease` не видит такие
   релизы, проверено core). Версия = тег без `v`, релиз — prerelease с именем тега. После `package`
   идёт job **smoke**. `release` теперь ждёт `[package, smoke]`: релиз не выйдет, если smoke красный.
3. **smoke** (`app/apps/desktop/e2e-smoke/smoke.spec.ts`, конфиг `playwright.smoke.config.ts`):
   - тихая установка `PRSLOY-*-win-x64.exe /S /currentuser` в `%LOCALAPPDATA%\Programs\PRSLOY`;
   - запуск **установленного** `PRSLOY.exe` через Playwright `_electron.launch({ executablePath })`;
   - фейковая модель — тот же `FakeOpenAiServer`, что в e2e. В установленном приложении она подключается без
     тестового кода: `models.json` во временном `PI_CODING_AGENT_DIR` и `ZENO_MODEL_PROVIDER/ID`. Эти переменные
     не завязаны на `isPackaged`, а фьюзов Electron нет, так что Playwright подключается. **Тестовый
     переключатель в приложение не добавлялся**, безопасность не ослаблена;
   - проверки: главное окно → распаковка рантаймов (`userData/runtimes/node/node.exe`, `python/python.exe`) →
     Agent Host ready → ответ на сообщение → вызов `bash` через агента. Команда `echo PRSLOY_SMOKE_$((6*7))`:
     ответ `42` доказывает, что команду выполнил настоящий shell. Результат обязан начинаться с заголовка
     харнесса `[exit N · …]`;
   - скриншоты, `*-main.log` (stdout/stderr main), `*-renderer.log`, `metrics.json`, `install.json`,
     `bash-*.json`, копия userData без рантаймов — в артефакте `prsloy-win-smoke`. Сводка цифр — в Summary job;
   - падение, вылет или таймаут (10 мин на тест, 30 мин на job) красят job.

## Цифры (windows-latest)

Финальная сборка: `main` ba93317 (core этап 2, «Дизайн», теги `v*`) + эта ветка. Прогоны 40151823679 и
https://github.com/convyrtech/AGENTHARNESSV2/actions/runs/40153282086. В колонке «Финал» — разброс между раннерами.

| Что                                                        | Финал           | После PortableGit tar.gz (40149024243) | База Zeno     |
| ---------------------------------------------------------- | --------------- | -------------------------------------- | ------------- |
| Установщик `PRSLOY-0.1.6-win-x64.exe`                      | **213,3 МБ**    | 282,9 МБ                               | 200,8 МБ      |
| После установки (папка программы)                          | 486,8 МБ        | 788,1 МБ                               | 704,4 МБ      |
| Тихая установка                                            | **19,7–25,2 с** | 27–38 с                                | 24–31 с       |
| Запуск → первое окно                                       | **10,5–16,3 с** | 23–26 с                                | 15–24 с       |
| Запуск → интерфейс готов (распаковка Node + Python)        | **13,2–20,4 с** | 27–29 с                                | 17–26 с       |
| Запуск → PortableGit распакован (фон, первый ход ждёт его) | **24,7–39,5 с** | входило в «готов»                      | —             |
| «Новый разговор» → Agent Host ready                        | 0,9–1,9 с       | 1,9 с                                  | ~2,0 с        |
| Время job: `package` / `smoke`                             | 5,3 / 2,8 мин   | 7,7 / 4,2 мин                          | 4–7 / 4–5 мин |

Первый ход агента в первые 25–40 с после первого запуска ждёт распаковку Git. Повторные запуски не замерялись.

## Bash-тул Pi на Windows

**Какой shell берёт Pi** (`pi-coding-agent/dist/utils/shell.js`, `getShellConfig`):

1. `shellPath` из `settings.json`;
2. `%ProgramFiles%\Git\bin\bash.exe`, затем `%ProgramFiles(x86)%\Git\bin\bash.exe`;
3. `where bash.exe` по PATH. Вызов: `bash -c <command>`; для `System32\bash.exe` (WSL) — `-s` через stdin.

**Что показал smoke на базе Zeno, до правки core:**

- Раннер как есть (Git for Windows стоит): работает, Git Bash (MSYS2) `/usr/bin/bash`.
- Чистая Windows (Git спрятан: `ProgramFiles*` → пустая папка, из PATH убраны git/msys/cygwin): **не работает**,
  дословно `No bash shell found. Options: 1. Install Git for Windows … Searched Git Bash in: …\Git\bin\bash.exe`.
  Приложение не падает: карточка тула красная, ход завершается.
- Ловушка WSL: когда bash.exe ищется по PATH, находится `C:\Windows\System32\bash.exe` — лаунчер WSL. Тул
  отвечает `Windows Subsystem for Linux has no installed distributions…` в UTF-16 (мусор `W\0i\0n\0…`), exit 1.
- Кандидаты (Git спрятан, Pi направлен на shell через `shellPath`):

| Кандидат                | Размер (архив / распак.) | Результат                                                                                                                                                                  |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MinGit 2.56.0.3         | 38,0 / 91,8 МБ           | `bash.exe` нет; `usr\bin\sh.exe` (bash 5.3) работает, `git` есть, но **нет coreutils**: `ls/head/tr/grep/sed/awk/which` → `command not found`, `find` → Windows `FIND.EXE` |
| MinGit-busybox 2.56.0.3 | 33,7 / 82,5 МБ           | только `busybox.exe`, с `-c` напрямую не запускается                                                                                                                       |
| PortableGit 2.56.0.3    | 57,3 / 392,3 МБ          | **работает всё**: bash, `[[ ]]`, массивы, coreutils, grep/sed/awk/find, git                                                                                                |

**Решение уже в `main`** (core, `ed0afd8`, `d368055`): PortableGit идёт архивом рантаймов, распаковывается в
`userData\runtimes\git`. Приложение **всегда** задаёт Pi `shellPath`: свой bash, затем системный Git, никогда не WSL.

**Проверка в smoke теперь обязательная** (`SMOKE_STRICT_CLEAN_BASH=1`): системный Git спрятан, агент через bash-тул
выполняет bash-синтаксис, coreutils и git. Результат на интегрированной сборке (`bash-clean.json`):

```
PRSLOY_SMOKE_42
SHELL=/usr/bin/bash
MINGW64_NT-10.0-26100 … x86_64 Msys
BASH_VERSION=5.2.37(1)-release
bashisms=b
git version 2.51.0.windows.1
fixture.txt
1
PRSLOY smoke fixture
42
./fixture.txt
GIT_ROOT=C:\Users\runneradmin\AppData\Local\Temp\prsloy-smoke-clean-…\userData\runtimes\git\
```

Не проверено: машина с WSL без дистрибутива. По коду core (`shellPath` задаётся всегда) WSL не будет выбран
никогда, но отдельного прогона такой машины нет.

## Замечания

- Версия в установщике пока `0.1.6` (от Zeno). По тегу `v0.1.0-alpha.1` workflow ставит `0.1.0-alpha.1`.
- «Дизайн» в CI: бандла дизайна нет (нужен токен приватного репо, `DESIGN_REQUIRED` не задан). Smoke открывает
  вкладку и требует спокойное состояние без ошибок renderer: без бандла это `design-unavailable`, с бандлом —
  setup/key/empty. Какое показалось, пишется в `metrics.json` → `designStates`, скриншот `04-design.png`.
  **Важно для релиза:** пока в CI нет токена, установщик из тега выйдет без бандла дизайна.
- Ошибка `Failed to get 'documents' path` появлялась только из-за подменённого `USERPROFILE` в тесте. На Windows
  тест теперь оставляет настоящий профиль, ошибки нет.
- `Checking for update` в логе: апдейтер ходит в Releases `convyrtech/AGENTHARNESSV2`. В smoke это не мешает.

## Как проверено

- Локально (база Zeno): `pnpm check` ✓, `pnpm test` ✓ (92 файла, 669 тестов + скриптовые тесты), `pnpm build` ✓.
  После rebase на `main`: `pnpm check` ✓, упакованная Linux-сборка + smoke ✓.
- Локально на Linux: упакованная сборка `electron-builder --linux dir` + тот же smoke под `xvfb-run` ✓
  (bash: `PRSLOY_SMOKE_42`, `/bin/bash`).
- CI, `desktop-windows` на `desktop/ci`, все зелёные. Исследование: 40144577288, 40145410772, 40146190949,
  40146870805, 40147775976 (MinGit vs PortableGit). Строгий clean-bash на интегрированном `main`: 40149024243,
  40149932681, 40150827601, 40151823679. **Финал** (main ba93317 + ветка, 2/2 теста; bash с заголовком
  `[exit 0 …]` с системным Git и без него; «Дизайн» → `design-unavailable`):
  https://github.com/convyrtech/AGENTHARNESSV2/actions/runs/40153282086
- Артефакты: `prsloy-win-x64` (установщик + latest.yml) и `prsloy-win-smoke` (скриншоты, логи, json), 14 дней.
