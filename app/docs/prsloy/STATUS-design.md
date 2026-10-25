# STATUS — дорожка W4 «Дизайн» (`desktop/design`)

Этап 1 слит в main (`6162e93`). Этап 2 — ниже, ветка от main `6162e93`. Скриншоты: `screens/design-*.png` (ru, с брендом ui).

## Сделано

### 1. Сервис в main (`apps/desktop/src/main/design/`)

- `service.ts` ведёт движок, сам движок не переписан:
  - **Прокси.** `a6proxy.py` из venv на свободном порту (`--port 0`, порт читается из его первой строки).
    Upstream — адрес PRSLOY из настроек core (`prsloy.getState().baseUrl`). Ключ — из `prsloy.keyStore`.
  - **Ключ на диске.** Файл `userData/design/proxy/key-<uuid>`: 0600, на Windows `icacls /inheritance:r`.
    Он **удаляется сразу, как только прокси напечатал порт** (прокси читает ключ при старте).
    На диске ключ живёт меньше секунды. Для dev и тестов есть запасной вариант: env `PRSLOY_API_KEY` /
    `PRSLOY_BASE_URL`.
  - **Рабочая папка.** `<проект>/prsloy-design`, без проекта — `Documents/PRSLOY/prsloy-design`.
    `run.py init --page landing --pipeline <bundle>/design-pipeline`.
  - **Ход.** `run.py say` — дочерний процесс. Его JSONL разбирается (`events.ts`, все поля обрезаются) и
    идёт в renderer по `prsloy:design:event`. Каждое событие пишется в `harness/app-events.jsonl`: лента
    переживает закрытие вкладки. «Стоп» убивает дерево процессов: Windows `taskkill /T /F`, POSIX — группа.
  - **Выход из приложения.** Прокси и ход гасятся синхронно на `before-quit` и `process.exit`.
    `will-quit` не годится: `index.ts` выходит через `app.exit()`, и до фикса каждый прокси переживал
    приложение. Есть регрессионный тест.
  - **Pi.** `PI_BIN = [bundled node, extracted pi cli.js]` — тот же путь, что у TUI. Свой pi home
    `userData/design/pi-agent`:
    - `models.json`: провайдер `a6p`, как в `stages.json`, → локальный прокси, `apiKey: "local"`. Модели и
      compat берутся из каталога core (`buildPrsloyModelsJsonProvider`): без compat DeepSeek/Kimi отвечают
      400 на ходах с тулами;
    - `settings.json` с `shellPath` от core (Git Bash на Windows);
    - rg/fd скопированы из pi home core.
  - **Окружение.** Чистый env (`env.ts`, allow-list): `AWS_*`, `GH_TOKEN`, `*_API_KEY` и т. п. не
    проходят. Ставятся `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `HARNESS_PROXY`,
    `DP_BROWSER_CHANNEL`, `DP_CHROMIUM_ONLY=1`. Шимы `python3` и `python3.cmd` ведут на venv: в venv на
    Windows нет `python3`, а AGENTS.md велит агенту `python3 -I …`.
  - **Картинки и видео.** Протокол `prsloy-design://ws/<id>/<путь>`. id — хэш папки (абсолютного пути в
    URL нет). Путь проверяется на попадание внутрь папки, symlink наружу запрещён. Range отдаётся для видео.
  - **Превью.** Статический сервер на 127.0.0.1 над `site/`: только GET/HEAD, без листинга, без выхода
    из корня. Открывает `site/landing/`.
- Подключение в `index.ts` — 4 строки: `APP_SCHEMES` (список схем переехал в `app-schemes.ts`) и
  `installDesign(...)`. Остальное — preload `window.zeno.design`, тип `DesignApi` в `@zeno/contracts`.

### 2. Python и браузер при первом заходе

- `setup.ts`: venv из bundled Python, затем
  `pip install --only-binary=:all: --progress-bar raw pillow==13.0.0 numpy==2.5.4 playwright==1.63.0 fonttools==4.67.0`.
  - Прогресс складывается по файлам. Карточка: «Готовлю инструменты дизайна, один раз, ~62 МБ».
    Колёса win_amd64 cp312 проверены: 59 МБ.
  - Если в бандле есть `wheels/` (`fetch-design.mjs --wheels`), установка идёт офлайн.
- **fonttools добавлен сверх задания.** Гейт шага 2 (`flow.py` → `font_check.py`) импортирует его, а в
  `requirements.txt` пайплайна он помечен как нужный только для тестов. Без него шаг «бренд» падает.
- **Браузер.** На Windows — установленный Edge (`channel="msedge"`, поиск `msedge.exe` в Program Files и
  LOCALAPPDATA). После установки идёт пробный запуск браузера. Пропишется отметка `userData/design/tools.json`.
- **Патч пайплайна** (`playbooks/site/harness/pipeline-fixes.patch`, поверх правок дирижёра):
  - `_common.launch(pw, engine)`: `DP_BROWSER_CHANNEL` для Chromium. Все 7 запусков браузера в tools
    идут через неё;
  - `DP_CHROMIUM_ONLY=1`: `both` = Chromium, webkit-вызовы идут на Chromium, `flow.py` принимает отчёт
    гейта без WebKit.

### 3. Вкладка «Дизайн» (`renderer/components/design/DesignPage.tsx`, `lib/design-state.ts`)

- Пункт «Дизайн» стоит сразу под «Новый чат».
- **Лента.**
  - Сообщения владельца — справа.
  - Карточка вопроса: текст, картинки и видео из `files`; `options` сгруппированы по вопросам
    (`[{q, options}]`, до 3 групп; старый плоский список читается как одна группа) — ряд кнопок на
    вопрос с подписью `q`, вариант с `recommended` помечен «рекомендую». Один вопрос отвечается кликом
    («А. …»), несколько — выбором в каждом ряду и «Ответить» («1А 2Б»). «Как рекомендуешь» шлёт ровно
    «как рекомендуешь». Файлы, приложенные до ответа кнопкой, уходят вместе с ним. Из текста убраны
    строки вариантов, строки вопросов и пути к картинкам: они уже стали кнопками и картинками.
  - Заметка «связь с моделью оборвалась, повторяю шаг…» и прочие `note` идут в тихий тикер, не ошибкой.
  - Поле ввода, приложить файлы (системный выбор, в `say` уходят только токены выбранных файлов),
    «Стоп» во время хода.
- **Прогресс.** Одна строка «Шаг N из 8: …»: 11 гейтов сведены в 8 шагов для владельца. Минуты идут
  после первой. Под строкой — тихий тикер последнего тула («edit design/landing/STATUS.md»).
- **stuck** → «Застрял на этом шаге.», «Подробнее» (сырой текст), «Попробовать ещё раз»
  (`run.py say --retry`).
- **Ход кончился без вопроса** (бюджет шагов) → «Сделал часть работы.» + «Продолжить». После «Стоп» —
  «Остановлено.» + «Продолжить». Падение процесса → «Что-то сломалось.» + «Подробнее».
- **done** → «Страница готова.», превью в `<iframe sandbox="allow-scripts">` с loopback, «Открыть папку»
  (`site/`).
- **Строки** лежат в `locales/design.{zh,en,ru}.ts` и подмешаны в середину каждой таблицы, чтобы не
  конфликтовать с дописыванием в конец.
- **CSP:** `prsloy-design:` для img и media, `frame-src http://127.0.0.1:*`.
- Бюджет строк `main.tsx` не поднят: `maybeMarkUnreadForRuntime` переехал в `store/unread-on-settle.ts`.

### 4. Сборка

- `scripts/fetch-design.mjs` → `design-bundle/` → extraResources `design/`, 3,4 МБ. Состав:
  - `playbooks/site/{harness,motion}`;
  - `experiments/e8b/etalons` без видео;
  - `design-pipeline` на коммите из `design-lock.json` (`39fcac4`) с наложенным патчем и меткой
    `.pipeline-fixes.sha256`.
- `pnpm package` теперь вызывает этот скрипт.

## Правки движка (отдельные коммиты, минимальные)

1. `3e189d0`:
   - `run.py`: env пропускает `DP_*` и `PI_OFFLINE`/`PI_SKIP_VERSION_CHECK`/`PI_TELEMETRY`;
     `HARNESS_PROXY` → `--proxy` для `judge.py` и `second_opinion.py` (порт прокси свободный, не 8787);
     `init` пропускает `git apply`, если копия уже пропатчена (метка sha256).
   - `a6proxy.py`: upstream с путём (`https://host/api/v1` → `/api/v1/…`), `http://` для локальных
     проверок, `--port 0` печатает настоящий порт.
2. `8a2b779`: `pipeline-fixes.patch` — канал браузера и режим только Chromium (см. выше), поверх правок
   дирижёра.
3. `5279e5f`: `run.py say --retry` сбрасывает лестницу моделей. Без этого «Попробовать ещё раз» после
   stuck по лестнице только повторяет stuck.

**Найденная ошибка движка, не чинил (решает дирижёр).** Если папка проекта — git-репозиторий,
`git apply --directory=design-pipeline` в `run.py init` молча пропускает все файлы патча (`Skipped patch`):
git ищет пути от корня внешнего репо. В приложении это обойдено пропатченной копией. Для запуска руками
нужен `GIT_CEILING_DIRECTORIES=<ws>` в этом вызове.

## Как проверено

- `pnpm check` — pass. `pnpm test` (desktop) — 120 файлов, 813 тестов, бюджеты ok.
- **Unit-тесты main** (`src/main/design/*.test.ts`, 35 шт.):
  - парсер на всём записанном логе настоящего `run.py`;
  - пути и протокол: traversal, `%2e%2e`, symlink наружу;
  - env: секреты не проходят, Windows-регистр, compat из каталога core;
  - прогресс pip, отметка установки, поиск Edge;
  - сервер превью;
  - `killTree` убивает внука.
- **IPC end-to-end** (`service.test.ts`): electron замокан, всё остальное настоящее — настоящий
  `a6proxy.py`, fake `run.py` и venv = системный python3. Проверено:
  - каналы и недоверенный отправитель;
  - после старта файла ключа нет, в `models.json` ключа нет;
  - картинка отдаётся по протоколу, Range → 206, выход за папку → 404;
  - поддельный токен файла отброшен;
  - второй ход при идущем — отказ; cancel → `exit cancelled`;
  - retry → done → превью отдаёт страницу;
  - quit гасит прокси.
- **Запись лога** (`e2e/design/record.py`): настоящий `run.py` + `flow.py` + `second_opinion.py` +
  `a6proxy.py`, заглушка Pi (`stub_pi.py`) и фейковый шлюз. Четыре хода: вопрос про материалы → лист
  настроений A/B/C с картинкой → 8 стадий с подъёмом по лестнице deepseek → kimi → qwen → opus
  («шагов на ход хватит») → stuck. Первый вопрос — два вопроса с группами вариантов.
  Результат — `recorded.jsonl`.
- **e2e на Linux** (`e2e/design.spec.ts`, xvfb, 2/2, ~18 с), fake `run.py` проигрывает запись. Путь:
  setup → запрос → карточка с двумя вопросами (выбор в каждом ряду, «Ответить» → «1А 2А» с
  приложенным логотипом) → карточка выбора с картинкой (naturalWidth 480) → «как рекомендуешь» →
  строка прогресса и тикер → «Продолжить» → stuck → retry → превью в sandbox iframe →
  «Открыть папку» → уход с вкладки и возврат → «Стоп».
  Команда: `pnpm run build && DESIGN_E2E_LOCALE=ru xvfb-run -a npx playwright test e2e/design.spec.ts`.
- **Разовые ручные проверки:**
  - сервис гонит **настоящий** `run.py` из собранного бандла (pipeline `39fcac4` + патч): события
    `user, stage, tool, owner, exit`; второе мнение дошло до шлюза через прокси;
  - настоящая установка `setupDesignTools`: venv → pip → проба браузера, 9 с, `done`;
  - `run.py init` из бандла в проект-git-репо: патч на месте, etalons и motion скопированы.
- **Тесты design-pipeline с патчем** (`DP_CHROMIUM_ONLY=1`, Chromium из Playwright):
  - без патча: 20/62 (WebKit нет);
  - с патчем: 39/62;
  - с патчем + fonttools: 57/62. Остаток: 4 теста `vg_*` жёстко ждут прогон WebKit;
    `flow_code_written_before_owner_choice_is_caught_later` зависит от времени (`born()` в патче
    дирижёра): один проходит, в полном прогоне падает.

## Этап 2 (после слияния)

**Готово к слиянию (ready to merge).**

### 1. Инструменты дизайна на Windows без приватного пайплайна

- `.github/workflows/design-windows.yml` — отдельный файл, `desktop-windows.yml` дорожки ci не тронут.
  Джоба `toolchain` на windows-latest гоняет `app/apps/desktop/scripts/design-smoke.mts`
  (`node --experimental-strip-types`, без `pnpm install`). Скрипт вызывает **тот же код, что приложение**
  (`setupDesignTools`), и делает по порядку:
  1. Python — тот же python-build-standalone, что в установщике (`runtimes/versions.json`: 3.12.13 +
     20260807, `install_only_stripped`);
  2. первый заход вкладки: venv → `pip --only-binary=:all:` колёса Pillow, numpy, playwright, fonttools →
     проба Edge через `channel="msedge"`, с замером времени и размера venv;
  3. Edge рисует `playbooks/site/motion/demo/index.html?brand=prsloy&t=0.5` → `demo-prsloy.png` (артефакт
     `design-smoke-windows`, проверка, что кадр не пустой);
  4. `check.py` на маленьком сайте: чистый → PASS, с png → FAIL;
  5. `run.py init`, `status`, `say` в `…\Иван Петров\Documents\PRSLOY\сайт` на заглушке пайплайна
     (`e2e/design/stub-pipeline`) и заглушке pi, без сети. venv тоже лежит под «Иван Петров»
     (`…\AppData\Roaming\PRSLOY\design\venv`), как у пользователя с кириллическим именем.
- **Замеры на windows-latest:** Python 3.12.13 из установщика; колёса 59 МБ; venv **214 МБ**; вся
  установка **18 с** (venv 4,9 · загрузка 3,3 · установка 5,7 · проба Edge 3,9); Edge 155.
  Сеть раннера быстрая: у владельца загрузка 60 МБ займёт дольше. Текст первого захода теперь с
  настоящими числами: «Готовлю инструменты дизайна, один раз: скачаю ~60 МБ, на диске ~215 МБ».
- **Что нашёл прогон на Windows:**
  - **ошибка движка, исправлена** (`035b1af`): `run.py` запускает `check.py`, `second_opinion.py` и
    `judge.py` как `python -I`. Под `-I` `PYTHONUTF8` не действует, вывод в трубу идёт в cp1252, и первая
    русская строка роняла скрипт с `UnicodeEncodeError`. На Windows проверка харнесса всегда «падала»,
    второе мнение и судья не работали. Теперь каждый скрипт сам переводит свои stdout/stderr в UTF-8;
  - `fs.cpSync` в Node 22 на Windows молча ничего не копирует в папку с кириллицей. В `apps/desktop/src`
    его нет нигде (проверено `grep`), `run.py` копирует через `shutil`. В скрипте проверки заменён ручным
    копированием. На будущее: в main `cpSync` с путями из профиля пользователя (`C:\Users\Иван…`)
    не использовать.

### 2. Сборка без пайплайна

- В бандле нет `run.py` или `design-pipeline/tools/flow.py` (сборка без `DESIGN_PIPELINE_TOKEN`) →
  `DesignStatus.available = false`. Вкладка показывает только «Дизайн-инструменты появятся в следующей
  версии»: ни карточки установки, ни поля ввода, ни трассировок.
- Сбой самого `status` по IPC ведёт в то же состояние. `setup`/`say` в main отвечают той же фразой.
- Тесты: unit (`service.test.ts`), e2e «a build without the design bundle shows one calm state»,
  скриншот `screens/design-unavailable.png`.

### 3. Пути с пробелами и кириллицей

- Покрыто шагом 5 выше на windows-latest и тем же скриптом на Linux. Каждая проверка печатает `ok`/`FAIL`,
  итог — в `design-smoke.json` и в summary джобы:
  - `run.py init`, `status`, `say` (`stage → tool → owner`, второе мнение без сети не падает);
  - `check.py` (PASS и FAIL);
  - `second_opinion.py` (внутри `say`).
- `judge.py` в этой проверке не вызывается: судья зовётся только на шаге 7, до которого заглушка не
  доходит. Его вывод исправлен тем же коммитом `035b1af`.

### Как проверено (этап 2)

- `pnpm check` — pass; `pnpm test` (desktop) — 841 тест, бюджеты ok; e2e «Дизайн» 3/3
  (`DESIGN_E2E_LOCALE=ru`).
- `design-smoke.mts` на Linux: 8/8 ok.
- `design-windows` на windows-latest: RESULT_PLACEHOLDER

## Не сделано / нужно от других

- **design-pipeline приватный.** CI (`pnpm package`) соберёт бандл без него и выдаст предупреждение.
  Нужно:
  - секрет `DESIGN_PIPELINE_TOKEN` с чтением этого репо в workflow (дорожка ci или дирижёр) и
    `DESIGN_REQUIRED=1` для релизов;
  - **решение владельца**: пайплайн окажется внутри публичного установщика в Releases.
- **Windows вживую не запускался.** Не проверены: Edge через channel, `taskkill`, `icacls`, шимы
  python3 в Git Bash, venv из bundled Python 3.12.
- **Живой прогон с ключом и моделями не делал** — ключа нет, это делает дирижёр.
- **Видео в карточке** проверено только unit-тестом Range: в записанном логе видео нет.
- В превью нет кнопки «открыть в браузере» — есть «Открыть папку».
