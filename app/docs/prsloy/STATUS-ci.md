# STATUS: дорожка ci (W0 + W5)

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
