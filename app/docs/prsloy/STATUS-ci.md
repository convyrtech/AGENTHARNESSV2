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
     ответ `42` доказывает, что команду выполнил настоящий shell;
   - скриншоты, `*-main.log` (stdout/stderr main), `*-renderer.log`, `metrics.json`, `install.json`,
     `bash-*.json`, копия userData без рантаймов — в артефакте `prsloy-win-smoke`. Сводка цифр — в Summary job;
   - падение, вылет или таймаут (10 мин на тест, 30 мин на job) красят job.

## Цифры (windows-latest, 4 прогона)

| Что | Значение |
|---|---|
| Установщик `PRSLOY-0.1.6-win-x64.exe` | 200,8 МБ |
| После установки (папка программы) | 704,4 МБ |
| Тихая установка | 23,6–30,6 с |
| Запуск → первое окно | 14,8–19,2 с |
| Запуск → интерфейс готов (вкл. первую распаковку Node + Python) | 17,1–21,7 с |
| «Новый разговор» → Agent Host ready | ~2,0 с |
| Сборка `package` | ~4–7 мин; `smoke` ~4–5 мин |

Архивы рантаймов в установщике: node.tar.gz 34,1 МБ, python.tar.gz 16,7 МБ.

## Bash-тул Pi на Windows

**Какой shell берёт Pi** (`pi-coding-agent/dist/utils/shell.js`, `getShellConfig`):
1. `shellPath` из `settings.json`;
2. `%ProgramFiles%\Git\bin\bash.exe`, затем `%ProgramFiles(x86)%\Git\bin\bash.exe`;
3. `where bash.exe` по PATH. Вызов: `bash -c <command>`; для `System32\bash.exe` (WSL) — `-s` через stdin.

**Раннер как есть** (Git for Windows установлен): работает. Shell — Git Bash (MSYS2), `/usr/bin/bash`,
`MINGW64_NT-10.0-26100`. Вывод виден в карточке тула (скриншот `runner-bash.png`).

**Чистая Windows** (Git спрятан: `ProgramFiles*` указывают на пустую папку, из PATH убраны git/msys/cygwin):
**не работает.** Ошибка дословно:

```
No bash shell found. Options:
  1. Install Git for Windows: https://git-scm.com/download/win
  2. Add your bash to PATH (Cygwin, MSYS2, etc.)
  3. Set shellPath in settings.json

Searched Git Bash in:
  C:\...\no-program-files\Git\bin\bash.exe
```

Приложение не падает: карточка тула красная, ход завершается («Tool result received»).

**Ловушка WSL.** В одном прогоне на PATH не было bash.exe, и `where bash.exe` нашёл `C:\Windows\System32\bash.exe` —
это лаунчер WSL. Результат тула: `Windows Subsystem for Linux has no installed distributions…` в UTF-16 (мусор
`W\0i\0n\0…`), exit 1. У пользователя с включённым WSL без дистрибутива будет так же. Вывод: на Windows
**нельзя полагаться на поиск по PATH**, нужно явно задавать `shellPath`.

**Кандидаты на исправление** (проверены в smoke при спрятанном системном Git, Pi направлен на shell через
`settings.json` → `shellPath`; только отчёт, на зелёный цвет не влияют):

| Кандидат | Размер (zip / распак.) | Результат |
|---|---|---|
| MinGit 2.56.0.3 | 38,0 / 91,8 МБ | `bash.exe` нет, есть `usr\bin\sh.exe` = bash 5.3.15. Как `shellPath` работает: `$((…))`, `[[ ]]`, массивы, `git`. **Но нет coreutils:** `ls`, `head`, `tr`, `uname` → `command not found` |
| MinGit-busybox 2.56.0.3 | 33,7 / 82,5 МБ | нет ни `bash.exe`, ни `sh.exe`, только `ucrt64\bin\busybox.exe`; с `-c` напрямую не вызвать |
| PortableGit 2.56.0.3 | PORTABLEGIT_SIZE | PORTABLEGIT_RESULT |
| PowerShell-тул | 0 | не проверялся: модели и промпты Pi рассчитаны на bash; нужен свой тул в core |

**Предложение (решает дирижёр, делает core):** PORTABLEGIT_PROPOSAL

## Замечания

- Версия в установщике пока `0.1.6` (от Zeno). По тегу `desktop-v0.1.0-alpha.1` workflow ставит `0.1.0-alpha.1`.
- В шапке и сайдбаре ещё «Zeno», плейсхолдер на английском — это дорожка ui.
- Ошибка `Failed to get 'documents' path` появлялась только из-за подменённого `USERPROFILE` в тесте. На Windows
  тест теперь оставляет настоящий профиль, ошибки нет.
- `Checking for update` в логе: апдейтер ходит в Releases `convyrtech/AGENTHARNESSV2`. В smoke это не мешает.

## Как проверено

- Локально: `pnpm check` ✓, `pnpm test` ✓ (92 файла, 669 тестов + скриптовые тесты), `pnpm build` ✓.
- Локально на Linux: упакованная сборка `electron-builder --linux dir` + тот же smoke под `xvfb-run` ✓
  (bash: `PRSLOY_SMOKE_42`, `/bin/bash`).
- CI: прогоны `desktop-windows` на `desktop/ci` — RUN_LIST.
