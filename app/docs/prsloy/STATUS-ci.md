# STATUS: дорожка ci (W0 + W5)

## Этап 4: установщик в один клик, по-русски

Прогон: https://github.com/convyrtech/AGENTHARNESSV2/actions/runs/40171865940 (зелёный: package, smoke, update-e2e).

### Что поменялось (`apps/desktop/electron-builder.yml`)

- `nsis`:
  - `oneClick: true`, `perMachine: false` — установка в `%LOCALAPPDATA%\Programs\PRSLOY` без UAC;
  - `allowToChangeInstallationDirectory: false`, `runAfterFinish: true`;
  - `installerLanguages: [ru_RU]`, `language: "1049"`, `unicode: true`;
  - `deleteAppDataOnUninstall: false`; ярлыки и `include: build/installer.nsh` (распаковка PortableGit) — как были.
- **Ловушка:** `multiLanguageInstaller: false` в electron-builder собирает **только английский** (`langs = ["en_US"]`):
  первая сборка показала «PRSLOY Setup / Installing, please wait...». Русский получается так: язык по умолчанию
  (многоязычный режим) и единственный `ru_RU` в списке, без выбора языка.
- `extraMetadata.name: prsloy` — папка кэша обновлений теперь `%LOCALAPPDATA%\prsloy-updater`, раньше была
  `@zenodesktop-updater`.
  - `publish.updaterCacheDirName` electron-builder **игнорирует**: имя всегда берётся из `name` в упакованном
    `package.json`.
  - Это же имя установщик использует для своей копии `installer.exe` — от неё считаются дифференциальные
    обновления. Поэтому менять можно только через `name`, иначе обновления молча станут полными.
  - Профиль (`%APPDATA%\PRSLOY`) от `name` не зависит: core задаёт его в коде (`app.setPath`).

### Как доказано на windows-latest

`e2e-smoke/oneclick-install.ps1` — первый шаг smoke на чистом раннере. Строгий режим: `SMOKE_STRICT_ONECLICK=1`
на уровне job.

1. Установщик запускается **без `/S`**, как двойной клик.
   - Каждые 0,5 с снимается скриншот экрана (78 кадров, артефакт `prsloy-win-smoke/oneclick/`).
   - Тексты всех окон установщика читаются через EnumWindows + `WM_GETTEXT`: заголовок и все контролы.
2. Найдено ровно одно окно, и оно русское:
   - `Установка PRSLOY` → `Установка, пожалуйста, подождите...` + полоса прогресса; кнопки `Отмена` и `&Закрыть`.
   - Слов `Next / Install / Choose / Anyone who uses / Back / Browse / Cancel` нет.
   - Английских текстов нет: эта проверка тоже строгая.
3. Установщик закрылся сам за 44 с (с распаковкой PortableGit), код выхода 0.
4. Приложение запустилось само (`runAfterFinish`) и показало «Вставьте ключ PRSLOY».
5. Манифест установщика — `asInvoker` (UAC не нужен). Запись удаления лежит в HKCU, то есть установка per-user.
6. Удаление тоже без `/S`:
   - русский вопрос «Вы уверены, что хотите удалить PRSLOY?»;
   - кнопки OK/Cancel рисует Windows на языке системы, у пользователя будут «ОК/Отмена»;
   - удаление закончилось за 5,6 с, папки программы нет, `%APPDATA%\PRSLOY` на месте.

Скриншоты: `screens/installer-oneclick-progress.png`, `screens/installer-oneclick-app-started.png`.

### Регрессия: всё зелёное в том же прогоне

- Тихая установка `/S /currentuser`: 28,3 с, установщик 215,0 МБ. Smoke 9/9 + кириллица 1/1 (установка с `/D=…Иван
Петров…` работает и в oneClick). Все findings ✅.
- Новый тест в `firstrun.spec.ts`: ключ и чат переживают удаление и повторную установку.
  - На настоящем профиле ввели ключ через первый запуск и отправили чат.
  - Потом `Uninstall PRSLOY.exe /S` (1,6 с) и снова `/S` (39 с).
  - После этого первого экрана нет, `hasKey: true`, чат виден.
- update-e2e 2/2:
  - A и B собраны уже с oneClick; обновление тихое (`--updated /S`), перезапуск в B.
  - Подделка отвергнута.
  - Кэш — `%LOCALAPPDATA%\prsloy-updater`, дифференциально скачан 1,08 МБ.

### Заметки

- Релизов в репозитории ещё нет, поэтому проверка «assisted alpha.1 → oneClick alpha.2» не нужна. Если alpha.1
  выйдет с этим конфигом, её не будет никогда.
- Подтверждение при удалении («Вы уверены…») показывает сам шаблон electron-builder для oneClick. Мастером оно не
  считается: один вопрос, ответ «ОК».

## Этап 3: автообновление от начала до конца на Windows

Прогон на `main` 93dcb8f: https://github.com/convyrtech/AGENTHARNESSV2/actions/runs/40169395654. Всё зелёное:
package; smoke 8/8 + кириллица 1/1, все findings ✅ при строгих флагах на уровне job; update-e2e 2/2.
Первый зелёный прогон до этой базы — 40168315551.

### Как устроено

- Job `update-e2e` в `desktop-windows.yml` (windows-latest, параллельно smoke; `release` ждёт и его).
- Собирает версию A `0.1.0-alpha.90` и B `0.1.0-alpha.91` тем же путём, что сборка по тегу: версия в
  `package.json` → `pnpm package` → `release-assets.mjs collect`. Сборка с prerelease-версией даёт именно
  `latest.yml`: с `provider: github` electron-builder не пишет `alpha.yml`, что и ждёт GitHubProvider.
- Ставит A тихо. B (`latest.yml`, exe, blockmap) и blockmap A отдаёт локальный сервер
  `e2e-smoke/update-feed.ts`. Он умеет byte ranges, одиночные и multipart, как CDN GitHub, поэтому
  дифференциальная загрузка идёт тем же путём, что у пользователей.
- Подмена фида только для теста: `resolveUpdateFeed()` в `auto-update.ts`. Generic-фид включается, только если
  `PRSLOY_E2E=1` **и** URL петлевой (`127.0.0.1`/`localhost`). Иначе — GitHub. Unit-тесты: удалённый,
  «похожий» (`127.0.0.1.evil.example`), `file://` и мусорный URL остаются на GitHub. Продакшен не ослаблен.
- Тест `e2e-smoke/update.spec.ts` идёт в продуктовом режиме: первый запуск через мок шлюза, без
  `ZENO_ENABLE_TEST_COMMANDS`, потому что в тест-режиме апдейтер выключен. Перед каждым тестом A ставится заново.

### Что проверено

1. **Подделанный B** (байт меняется каждые 1 МБ, `latest.yml` прежний):
   - дифференциальная загрузка → `Cannot download differentially, fallback to full download: sha512 checksum
mismatch`; полная загрузка → снова `sha512 checksum mismatch`;
   - уведомления нет, A работает, поле ввода живое;
   - после выхода установлена всё ещё A.
   - ✅
2. **Нормальный B**: A находит и скачивает его, появляется «Обновление готово — перезапустить».
   - По клику B ставится тихо, приложение перезапускается само (`--updated /S --force-run`).
   - Установленная версия (`DisplayVersion` в HKCU Uninstall) — B, а запущенное заново приложение отвечает
     `app.getVersion()` = B.
   - ✅ Мастера нет (`findings.update-silent` строгий, прошёл), установлена `0.1.0-alpha.91`, перезапущенное
     приложение отвечает `0.1.0-alpha.91` (скриншоты `31-update-ready`, `32-…-desktop`, `33-update-after-relaunch`).

### Найденный и исправленный баг

- Клик «Обновление готово — перезапустить» вызывал `quitAndInstall(false, true)`. Установщик NSIS (assisted)
  запускался **без `/S`** и вставал на английской странице мастера «Choose Installation Options — Anyone who
  uses this computer / Only for me … Next / Cancel». Приложение к этому моменту уже закрыто, на раннере окно
  висело больше 6 минут (скриншот в прогоне 40165426877).
- Путь «установить при выходе» (`autoInstallOnAppQuit`) уже был тихим: `--updated /S`.
- Исправлено на `main` (596411e): `quitAndInstall(true, true)`. В e2e это проверка
  `findings.update-silent`; строгая с `SMOKE_STRICT_UPDATE_SILENT=1`, флаг включён.

### Цифры

Прогоны 40168315551 и 40169395654. Время считается от запуска A, если не сказано иное.

| Что                                               | Время                                                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Запрос `latest.yml` (проверка стартует через 8 с) | 9,2–9,7 с                                                                                                                                                                                     |
| «Обновление готово — перезапустить» на экране     | 10,9–11,6 с                                                                                                                                                                                   |
| Дифференциальная загрузка                         | 3,1–5,0 МБ из 220 МБ (1–2 %), ~2 с                                                                                                                                                            |
| Клик → B установлена и запущена                   | ≤ 29,6–63,5 с — верхняя граница. Выход A тест видит поздно (28,4 с: процесс ждёт отключения отладчика Playwright), версия B в реестре — через 0,3 с после этого, перезапуск — ещё через 0,8 с |
| Подделанный B: загрузка и отказ                   | 9,3 → 11,2 с, обе попытки (дифф + полная)                                                                                                                                                     |
| Сборка A и B в job                                | 3,5–4,6 мин на версию; весь job ~10 мин, параллельно smoke                                                                                                                                    |

### Заметки

- Скачанное обновление ставится при выходе и без клика (`autoInstallOnAppQuit`, тихо). Задумано так, но
  надо знать: следующий запуск после закрытия — уже новая версия.
- Папка кэша апдейтера — `%LOCALAPPDATA%\@zenodesktop-updater`: имя тянется от `@zeno/desktop` в
  `package.json`. Пользователь её почти не видит; переименовать можно отдельно (поле `name`).
- Подпись кода не проверяется: сертификата нет, `publisherName` не задан. Защищает только sha512 из
  `latest.yml`, а сам `latest.yml` приходит с GitHub по HTTPS.
- Проверено: поиск обновления, загрузка, проверка и установка. Поиск релиза на настоящем GitHub (теги `v*`,
  prerelease) проверил core отдельно.
- Smoke на этой ветке теперь берёт строгие флаги (`SMOKE_STRICT_CLEAN_BASH`, `SMOKE_STRICT_RU`,
  `SMOKE_STRICT_PYTHON_HTTP`) на уровне job, так что их получает и шаг с кириллическим профилем. На `main` они
  стояли только в основном шаге.

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
