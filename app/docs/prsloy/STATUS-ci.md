# STATUS: дорожка ci (W0 + W5)

Ветка `desktop/ci`. Обе сборки зелёные: `desktop-ci` (Linux: check, test, build) и `desktop-windows`
(package → smoke).

## Что сделано

1. **desktop-ci** падал на `pnpm check`: не отформатирован `docs/prsloy/CONTEXT.md`. Исправлено (`pnpm fmt`).
   `fetch-runtimes`, сборка ассетов и конфиг electron-builder под Windows менять не пришлось: `package` на
   `windows-latest` собирается как есть (NSIS, per-user, без подписи).
2. **desktop-windows** запускается на push в `main` и `desktop/ci`, а также по тегу `desktop-v*`. После `package`
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

Сборка с `main` после интеграции core/ui/harness (прогон 40149024243): в установщике теперь ещё PortableGit и rg/fd.

| Что                                                         | После интеграции | До (база Zeno, 5 прогонов) |
| ----------------------------------------------------------- | ---------------- | -------------------------- |
| Установщик `PRSLOY-0.1.6-win-x64.exe`                       | **282,9 МБ**     | 200,8 МБ                   |
| После установки (папка программы)                           | 788,1 МБ         | 704,4 МБ                   |
| Тихая установка                                             | 36,2 с           | 23,6–30,6 с                |
| Запуск → первое окно                                        | 25,8 с           | 14,8–23,8 с                |
| Запуск → интерфейс готов (вкл. первую распаковку рантаймов) | 29,0 с           | 17,1–26,3 с                |
| «Новый разговор» → Agent Host ready                         | 1,9 с            | ~2,0 с                     |
| Время job: `package` / `smoke`                              | 7,7 / 4,2 мин    | 4–7 / 4–5 мин              |

Архивы рантаймов: node.tar.gz 34,1 МБ, python.tar.gz 16,7 МБ, git.tar.gz 80,2 МБ, tools.tar.gz 3,2 МБ.
Первый запуск почти 30 с: это сначала распаковка ~134 МБ архивов. Повторные запуски быстрее (не замерялось).
Если 30 с с пустым окном пугает, дорожке ui стоит показать прогресс распаковки.

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

- Версия в установщике пока `0.1.6` (от Zeno). По тегу `desktop-v0.1.0-alpha.1` workflow ставит `0.1.0-alpha.1`.
- Ошибка `Failed to get 'documents' path` появлялась только из-за подменённого `USERPROFILE` в тесте. На Windows
  тест теперь оставляет настоящий профиль, ошибки нет.
- `Checking for update` в логе: апдейтер ходит в Releases `convyrtech/AGENTHARNESSV2`. В smoke это не мешает.

## Как проверено

- Локально (база Zeno): `pnpm check` ✓, `pnpm test` ✓ (92 файла, 669 тестов + скриптовые тесты), `pnpm build` ✓.
  После rebase на `main`: `pnpm check` ✓, упакованная Linux-сборка + smoke ✓.
- Локально на Linux: упакованная сборка `electron-builder --linux dir` + тот же smoke под `xvfb-run` ✓
  (bash: `PRSLOY_SMOKE_42`, `/bin/bash`).
- CI, `desktop-windows` на `desktop/ci`, все зелёные. Исследование: 40144577288, 40145410772, 40146190949,
  40146870805, 40147775976 (MinGit vs PortableGit). На интегрированном `main`, со строгим clean-bash:
  40149024243 и 40149932681 (`main` с ru UI и first-run). Smoke-прогон:
  https://github.com/convyrtech/AGENTHARNESSV2/actions/runs/40149932681 (финальный — см. ниже). Артефакты `prsloy-win-x64` (установщик) и `prsloy-win-smoke` (скриншоты, логи, json) — 14 дней.
