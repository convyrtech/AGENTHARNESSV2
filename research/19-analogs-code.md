# 19. Аналоги вкладки «Код»: что взять, чтобы не изобретать велосипед

Дата: 2026-10-25. Задача владельца: «глянуть опенсорсные аналоги и взять то, что нужно, чтобы не изобретать велосипеды».
Область: конструкторы приложений для непрограммистов и настольные агенты. «Дизайн» сюда не входит.

**Как смотрел.** 18 репозиториев склонированы с `--depth 1` в
`/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/analogs/<имя>`. Их код не запускал,
зависимости не ставил. Читал файлы руками. Лицензию брал из файла `LICENSE` в корне (таблица в §5). Доступность
хостингов из России — из веба, ссылки в §3 и в конце.

**Что у нас уже есть** (не предлагаю повторно): установщик и автообновление, вход по ключу, превью в «Коде»,
откат хода (теневой git), дифф, рубли, граница записи, второе мнение, детектор петель, бюджет, стоп-гейт
«до зелёного», `find_ready`, отчёт для поддержки, примеры задач, понятные карточки ошибок. Источник —
`app/docs/prsloy/STATUS-*.md` и `PLAN-alpha.md` §2–3.

Обозначения. Объём: **XS** — до полудня, **S** — до дня, **M** — 2–3 дня, **L** — неделя и больше.
Вердикт: **БРАТЬ КОД** (только MIT/Apache-2.0/BSD, с атрибуцией), **ИДЕЯ** (пишем сами по образцу), **НЕ БРАТЬ**.

---

## 0. Коротко

- Самый близкий аналог — **Dyad** (Electron, локальный конструктор, «для тех, кто ни разу не открывал терминал»,
  `dyad@1be2b4b:PRODUCT.md`). Но часть кода у него под FSL (`src/pro/`), её брать нельзя.
- Готовый код, который можно забрать почти как есть: выбор элемента на странице (bolt.diy, MIT), поиск по чатам Pi
  (PiCove/PiDeck, MIT), описание инструмента «попросить ключ» (OpenHands, MIT), разбор подсказок «что дальше»
  (Dyad, Apache-2.0).
- Главный пробел у нас — **жизнь после первого результата**: ошибка на странице, «поменяй вот эту кнопку», токен
  бота, «бот работает или нет», «верни как было вчера». Аналоги это закрывают, мы — нет.
- **Публикация в один клик из России сейчас не работает ни у кого.** Vercel, Netlify и Cloudflare Pages
  заблокированы или нестабильны, GitHub деградирует с мая 2026. Для альфы — «Скачать архив». Дальше — свой хостинг
  PRSLOY или российское S3 (решение владельца, §3).
- Голос через браузерный Web Speech API в Electron не работает. Нужен свой распознаватель на шлюзе (§2.2).
- Маркетплейс MCP казуалу не нужен (§6).

---

## 1. Топ-10: ценность на усилие

| № | Что | Дорожки | Объём | Ценность | Вердикт |
|---|---|---|---|---|---|
| 1 | Вопрос с вариантами в «Коде» | harness | XS–S | высокая | ИДЕЯ (схема Roo) |
| 2 | «На странице ошибка → Починить» | core + ui | S | высокая | ИДЕЯ (Dyad, bolt.diy) |
| 3 | Агент просит ключ (токен бота) формой, не в чате | harness + ui | S | высокая | БРАТЬ КОД (OpenHands) + ИДЕЯ |
| 4 | «Скачать архив» в «Коде» | core + ui | XS | средняя | свой код из «Дизайна» |
| 5 | «Выбрать на странице» → правка этого места | core + ui | S–M | высокая | БРАТЬ КОД (bolt.diy) |
| 6 | Поиск по старым чатам | core + ui | S | средняя | БРАТЬ КОД (PiCove) |
| 7 | Подсказки «что дальше» кнопками | harness + ui | S | средняя–высокая | БРАТЬ КОД (Dyad) |
| 8 | История версий проекта | ui (+ core) | S (+M) | средняя–высокая | ИДЕЯ (Dyad) |
| 9 | Снимок части превью во вложение | ui + core | S | средняя | ИДЕЯ (bolt.diy) |
| 10 | «Бот работает · Остановить · Журнал» | harness + core + ui | M | высокая | ИДЕЯ (Dyad) |

### 1. Вопрос с вариантами в «Коде» (`ask_user`)

- **Казуалу.** Агент не гадает и не пишет простыню вопросов. Он задаёт один вопрос и даёт 2–4 кнопки, а также
  «Как рекомендуешь» и «Свой ответ».
- **У кого.** Roo Code (Apache-2.0, проект закрыт 2026-05-15):
  `roo-code@b867ec9:src/core/prompts/tools/native-tools/ask_followup_question.ts` — схема `question` +
  `follow_up[1..4]`, `src/core/tools/AskFollowupQuestionTool.ts`. Тот же приём у Cline и у Claude Code
  (`AskUserQuestion`). Правила формы вопроса у нас уже собраны в `research/11-intent-and-dispatch.md` (P2: до 4
  вариантов, рекомендуемый первым, пропуск = умолчания).
- **У нас.** В «Дизайне» вопросы кнопками есть (`STATUS-design.md`, п. 3). В «Коде» нет: в
  `app/packages/prsloy-harness/src/` нет инструмента вопроса. Путь диалога уже работает: граница записи зовёт
  `ctx.ui.select` (`STATUS-core.md`, п. 22), рендерер показывает `ExtensionUiSelectDialog.tsx`.
- **Как портировать (harness).**
  1. Новый `src/ask-user.ts`: `pi.registerTool` (как в `find-ready.ts:384`), вход `{question, options[2..4],
     recommended}`.
  2. Вызов `ctx.ui.select(question, [...options, "Как рекомендуешь", "Свой ответ"])`. «Свой ответ» → `ctx.ui.input`.
     «Как рекомендуешь» или закрытие → вариант `recommended`.
  3. Не больше двух вопросов на сообщение пользователя. Правило в промпте «Кода»: «спрашивай, только если без
     ответа нельзя».
  4. Только профиль «Код». Событие `ask` — в журнал уроков (`learning-log.ts`).
- **Объём.** XS–S, ~150 строк и тесты.
- **Риск.** Дешёвые модели переспрашивают. Лечится капом и детектором петель.

### 2. «На странице ошибка → Починить»

- **Казуалу.** Открыл превью, а там сломано: не грузится картинка или падает скрипт. Сверху плашка «На странице
  ошибка: …» и кнопка «Починить». Не надо копировать текст ошибки и объяснять.
- **У кого.**
  - Dyad (Apache-2.0): `worker/dyad-shim.js` (ловит `error` и `unhandledrejection`, шлёт родителю `postMessage`,
    строки ~233–270), `worker/dyad_logs.js` (перехват `console` с лимитами байт),
    `src/components/preview_panel/PreviewErrorBanner.tsx` (плашка: суть, «подробности», «скрыть», «починить»),
    `src/components/preview_panel/PreviewIframe.tsx:1615` (кнопка шлёт `Fix error: <текст>`),
    `src/components/chat/FixAllErrorsButton.tsx` («починить все N»). Скрипты в страницу Dyad вставляет своим
    прокси: `worker/proxy_server.js`, функция `injectHTML` (~строка 248).
  - bolt.diy (MIT): `app/components/chat/ChatAlert.tsx:74–88` — «Fix this preview error» и кнопка «Ask Bolt».
- **У нас.** Нет. Стоп-гейт страницу в браузере не открывает: «HTML-сайт: отдельной проверки загрузки страницы
  нет» (`STATUS-harness.md`, этап 6). Превью есть (`STATUS-ui.md`, этап 7).
- **Как портировать.**
  1. **core:** у `startPreviewServer` (`apps/desktop/src/main/design/preview-server.ts`) — опция `inject`. Для
     ответов `text/html` перед `</body>` вставлять `<script src="/__prsloy/bridge.js"></script>` и пересчитывать
     `Content-Length`. Сам `bridge.js` раздаётся из ресурсов приложения.
  2. `bridge.js` пишем сами, ~80 строк: `error`, `unhandledrejection`, ошибки загрузки ресурсов (слушатель `error`
     в фазе захвата — ловит 404 картинок и стилей), первые 5 `console.error`. Чужое «Script error.» без текста
     отбрасываем.
  3. **ui:** в `PreviewFrame.tsx` слушатель `message`. Принимаем, только если `event.source` — наша рамка, а
     `event.origin` — адрес превью. Плашка в `CodePreviewPanel.tsx`: «На странице ошибка» · «Починить» ·
     «Скрыть». «Починить» шлёт «Исправь ошибку на странице <файл>: <текст>» тем же путём, что «Повторить».
  4. Только по клику, без автопочинки: иначе петля.
  5. Сервер разработки агента (`127.0.0.1:<порт>`) так не покрыть: нужен прокси, как у Dyad. Это следующий шаг.
- **Объём.** S, ~250 строк и тесты (e2e: страница с ошибкой → плашка → кнопка шлёт текст).
- **Риск.** Шум от счётчиков и чужих скриптов — фильтр по источнику. Код Dyad можно брать (Apache-2.0), но свои
  80 строк проще.

### 3. Агент просит ключ формой (`request_secret`)

- **Казуалу.** «Бот для Telegram» — один из наших примеров (`STATUS-ui.md`, этап 8, п. 3). Дальше нужен токен от
  BotFather. Сегодня человек вставит его в чат: токен уйдёт модели, поставщику и в историю. Нужно окно «Вставьте
  токен бота» со скрытым полем и ссылкой «где взять».
- **У кого.**
  - OpenHands Agent Canvas (MIT): `openhands@b185939:src/api/request-secret-client-tool.ts` (54 строки:
    описание инструмента и схема `{name, reason}`; «никогда не проси вставить секрет в чат», «значение — в
    переменной окружения», «не печатай его»), `src/services/secret-request.ts`,
    `src/components/features/conversation/secret-request-card.tsx`.
  - Dyad (Apache-2.0): `src/ipc/handlers/app_env_vars_handlers.ts` — чтение и запись `.env.local`, в начале
    «DO NOT USE LOGGER HERE»; список переменных в `src/components/preview_panel/ConfigurePanel.tsx`.
- **У нас.** Нет. Чистка секретов есть (`STATUS-harness.md`, п. 7), но **шаблона токена Telegram в ней нет**:
  `prsloy-harness/src/secret-scrub.ts`, строки 17–35, знает только sk-, Stripe, GitHub, AWS, Slack и Google.
- **Как портировать.**
  1. **harness:** `src/request-secret.ts`. Описание инструмента — перевод текста OpenHands. Вход `{name, reason}`.
     Вызывает `ctx.ui.input` с меткой в заголовке. Значение расширение пишет само в `<проект>/.env`
     (`KEY=VALUE`), дописывает `.env` в `.gitignore` и добавляет значение в список чистки. Модели возвращает
     «Ключ сохранён в .env как TELEGRAM_BOT_TOKEN. Читай из окружения, не печатай». Значения в ответе нет.
  2. **harness:** в `secret-scrub.ts` — шаблон токена бота `\b\d{8,10}:[A-Za-z0-9_-]{35}\b`.
  3. **ui:** `ExtensionUiInputDialog.tsx` по метке включает `type="password"` и ссылку «Где взять токен» для
     известных имён (BotFather).
  4. Превью-сервер `.env` уже не отдаёт (`STATUS-ui.md`, этап 7, п. 3).
- **Объём.** S, ~300 строк.
- **Риск.** `cat .env` в bash покажет токен модели — его закроет чистка с новым шаблоном. Pi-диалог не умеет
  скрытое поле (`ExtensionUIDialogOptions` — только `signal` и `timeout`), поэтому маскировка — наша метка в
  заголовке.
- **Атрибуция.** Текст описания инструмента — из OpenHands (MIT), строка в `NOTICE.md`.

### 4. «Скачать архив» в «Коде»

- **Казуалу.** Отправить сайт другу или хостеру одним файлом. Это же основа для публикации (§3).
- **У кого.** bolt.diy (MIT): `app/lib/stores/workbench.ts:908`, `downloadZip()` на JSZip. Но лучше своё: в
  «Дизайне» уже есть «Скачать архив» без зависимостей — `apps/desktop/src/main/design/zip.ts`
  (`STATUS-design.md`, этап 4).
- **У нас.** В «Дизайне» да, в «Коде» нет.
- **Как портировать.** **core:** IPC `prsloy:code:export-zip(cwd)` на `listFiles` + `zipFiles`. Исключить
  `node_modules`, `.venv`, `dist`, `.git`, `.env` (точечные файлы `listFiles` уже пропускает). Предел 200 МБ.
  **ui:** пункт «Скачать архив» в меню проекта и рядом с «Открыть превью».
- **Объём.** XS, ~80 строк.

### 5. «Выбрать на странице» → правка этого места

- **Казуалу.** Навёл мышь на превью — элемент подсветился. Кликнул — в поле ввода чип «Выбрано: кнопка
  „Записаться“». Пишет «сделай зелёной». Агент правит именно её, а не похожую. Так делают Lovable, Dyad и bolt.diy
  (`research/11-intent-and-dispatch.md`, P6).
- **У кого.**
  - bolt.diy (MIT): `public/inspector-script.js` (432 строки). Работает на голом DOM, без сборки: подсветка,
    клик → `{tagName, className, id, textContent, selector, displayText, elementPath, rect, styles}`. Сторона
    родителя — `app/components/workbench/Inspector.tsx` (сообщения `INSPECTOR_ACTIVATE/HOVER/CLICK/LEAVE`).
  - Dyad (Apache-2.0): `worker/dyad-component-selector-client.js` (778 строк). Но он требует метки
    `data-dyad-id="файл:строка:колонка"` от плагина сборки
    `packages/@dyad-sh/react-vite-component-tagger/src/index.ts`. Подсказка модели собирается в
    `src/ipc/handlers/chat_stream_handlers.ts:1735–1775`: кусок файла с пометкой `// <-- EDIT HERE`.
- **У нас.** Нет.
- **Почему bolt.diy, а не Dyad.** Наши казуальные сайты — обычно чистый HTML без сборки. Скрипту bolt.diy метки не
  нужны.
- **Как портировать.**
  1. **core:** та же вставка, что в п. 2. `bridge.js` подгружает инспектор по команде родителя.
  2. **ui:** кнопка «Выбрать на странице» в шапке `PreviewFrame.tsx`. Клик по элементу → чип в `Composer`. При
     отправке к тексту добавляется блок: селектор, текст, начало `outerHTML` (300 символов), путь страницы.
  3. **core (по желанию):** main ищет `id` или кусок `outerHTML` в файлах проекта и даёт `файл:строка`, как
     сниппет Dyad.
  4. Для React/Vite-проектов позже можно добавить плагин-разметчик Dyad (Apache-2.0).
- **Объём.** S–M, ~400 строк (скрипт bolt.diy урезаем: правка стилей прямо в превью нам не нужна).
- **Риск.** Элемент, созданный скриптом, может не найтись в файле — тогда поиск по тексту. Проверка `origin`
  обязательна: скрипт bolt.diy шлёт `postMessage(..., '*')`.
- **Атрибуция.** `inspector-script.js` — MIT, © 2024 StackBlitz, Inc. and bolt.diy contributors. Строка в
  `NOTICE.md`, шапка в файле.

### 6. Поиск по старым чатам

- **Казуалу.** «Где я делал бота для доставки?» — ввёл «доставк» и получил чат с куском текста.
- **У кого.**
  - PiCove, бывший PiDeck (MIT): `pideck@102d9e1:packages/pi-host/src/session-search.ts` (350 строк). Ищет прямо
    по JSONL-сессиям Pi в `<agentDir>/sessions`. Кэширует по `mtime` и размеру, все слова должны совпасть,
    отрывок 40/120 символов, до 50 результатов. Это наш формат: у нас тоже Pi.
  - Cline (Apache-2.0): `apps/vscode/webview-ui/src/components/history/HistoryView.tsx` — Fuse.js по заголовкам,
    избранное, сортировка.
  - goose (Apache-2.0): `crates/goose/src/session/chat_history_search.rs` (Rust, SQLite).
- **У нас.** Нет. Палитра ищет только команды (`renderer/components/CommandPalette.tsx`, `lib/commands.ts`).
- **Как портировать.** **core:** скопировать `session-search.ts` в main, `agentDir` —
  `%APPDATA%\PRSLOY\agent` (`STATUS-core.md`, п. 18). Добавить замену «ё» на «е». IPC `prsloy:sessions:search`.
  **ui:** поле поиска над списком чатов в боковой панели или группа «Чаты» в палитре. Клик открывает чат.
- **Объём.** S: ~350 строк копии и ~150 строк UI.
- **Атрибуция.** MIT, © 2026 PiDeck contributors.

### 7. Подсказки «что дальше» кнопками

- **Казуалу.** После готового сайта под полем ввода 2–3 кнопки: «Добавь форму заявки», «Сделай версию для
  телефона». Человек не знает, что просить дальше, — ему подсказали.
- **У кого.** Dyad (Apache-2.0):
  - `src/lib/suggestedPrompts.ts` — тег `<dyad-suggested-prompts>`, до 3 строк по 120 символов. Берётся только
    последний закрытый тег верхнего уровня. Не показывается, если ход не завершён (ошибка, лимит шагов).
  - `src/prompts/local_agent_prompt.ts:107` — текст `SUGGESTED_PROMPTS_GUIDANCE` для модели.
  - `src/components/chat/ChatInput.tsx:786–830` — кнопки прячутся, пока в поле есть текст.
- **У нас.** Только примеры в пустом чате (`STATUS-ui.md`, этап 3, п. 2; этап 8, п. 3).
- **Как портировать.**
  1. **harness:** статичный раздел в системном промпте «Кода» (кэш не ломается, практика 1): «в конце готового
     ответа — тег `<prsloy-next>`, 2–3 коротких шага по-русски». Детектор утечек разметки (`tool-leak.ts`,
     этап 8а) не должен считать тег вызовом.
  2. **ui:** разбор — порт `selectSuggestedPrompts` (~100 строк). Тег убирается из текста ответа. Кнопки в стиле
     `ExampleTaskChips.tsx`, клик вставляет текст и не отправляет (как у примеров). Скрывать, если ход красный или
     прерван (`turn.end` из журнала харнесса).
- **Объём.** S, ~250 строк.
- **Риск.** Дешёвая модель напишет тег посреди ответа или по-английски. Тогда не показываем.

### 8. История версий проекта

- **Казуалу.** «Верни, как было до того, как ты сломал меню». Список: «вчера 18:40 — сделай меню», «сегодня
  10:05 — добавь форму» и кнопка «Вернуть к этому моменту».
- **У кого.**
  - Dyad (Apache-2.0): `src/components/chat/VersionPane.tsx` (843 строки: список, «5 минут назад», избранное,
    заметка, просмотр старой версии в превью, «Restore to this version»), `src/ipc/handlers/version_handlers.ts`
    (`listVersions`, `setVersionFavorite`, `setVersionNote`, `getVersionChanges`).
  - Cline и Roo — «восстановить контрольную точку».
- **У нас.** Откат под каждым ходом (`STATUS-ui.md`, этап 2, п. 1). `undoTurn(id)` у ядра уже возвращает к снимку
  перед ходом N и удаляет файлы, созданные после него, а перед этим делает снимок для «Вернуть как было»
  (`STATUS-core.md`, п. 6). Нет общего списка и нет просмотра старой версии.
- **Как портировать.**
  1. **ui:** панель «История» на `listTurns`. Строка: первая строка запроса, время, сколько файлов менялось.
     Кнопка «Вернуть к этому моменту» → `undoTurn(id)`. «Вернуть как было» — уже есть.
  2. **core, позже:** «Посмотреть» — дерево снимка (`git archive` из теневого репозитория) во временную папку и
     `startPreviewServer` на неё, только чтение.
- **Объём.** S на список и возврат (~300 строк), ещё M на просмотр старой версии.
- **Риск.** Для очень больших проектов снимок пропускается (лимиты в `STATUS-core.md`, п. 6). Показать «для этого
  хода снимка нет».

### 9. Снимок части превью во вложение

- **Казуалу.** «Вот тут криво» — обвёл рамкой кусок превью, снимок ушёл в сообщение. Все наши модели понимают
  картинки: `input: ["text", "image"]` у всех четырёх в `apps/desktop/src/shared/prsloy-config.ts`.
- **У кого.** bolt.diy (MIT): `app/components/workbench/ScreenshotSelector.tsx` (294 строки: тянем рамку, режем
  холст). Но он берёт кадр через `getDisplayMedia`, а это системный запрос «поделиться экраном». Аннотатор Dyad
  (`src/pro/ui/components/Annotator/`) — под FSL, нельзя.
- **У нас.** Вставка и перетаскивание картинок в поле есть (`Composer.tsx`, `handleComposerPaste`, ~строка 718).
  Снимка превью нет.
- **Как портировать.** **ui:** кнопка «Снять часть страницы» в `PreviewFrame.tsx` → слой с рамкой. **core:** IPC
  `webContents.capturePage(rect)`, без запроса на показ экрана → PNG в папку разговора → `onAddAttachments`.
- **Объём.** S, ~200 строк.
- **Риск.** Масштаб 125 и 150 %: учитывать `devicePixelRatio` (аудит масштабов — `STATUS-ui.md`, этап 8).

### 10. «Бот работает · Остановить · Журнал»

- **Казуалу.** Сделал бота — видит строку «Бот работает» и кнопки «Остановить», «Запустить снова» и «Журнал».
  Упал бот — «Починить» по последней ошибке.
- **У кого.**
  - Dyad (Apache-2.0): `src/app_run/*` (запуск, стоп и перезапуск как конечный автомат),
    `src/components/preview_panel/Console.tsx` (308 строк) + `ConsoleEntry.tsx`, `ConsoleFilters.tsx`.
  - bolt.diy (MIT): ошибка терминала → `ChatAlert.tsx` «Ask Bolt».
- **У нас.** У модели есть `bash_background` и `process list/logs/stop`, реестр процессов и портов
  (`STATUS-harness.md`, п. 1). У человека ничего нет. Фон гасится на `session_shutdown`
  (`prsloy-harness/src/bash-timeout.ts:349`), поэтому бот умирает вместе с чатом.
- **Как портировать.**
  1. **harness:** на старт и выход процесса — запись с `details` (id, короткое имя команды, порт, статус). Порты
     уже отдаются (`STATUS-harness.md`, этап 8, дополнение).
  2. **core:** IPC `prsloy:proc:list/logs/stop/restart` к реестру в агент-хосте (utilityProcess).
  3. **ui:** строка над полем ввода и выезжающий журнал (последние 200 строк, через чистку секретов). «Починить»
     шлёт хвост ошибки.
  4. Решение владельца на потом: должен ли бот жить после закрытия чата и приложения.
- **Объём.** M, 2–3 дня: нужна связка через процессы.
- **Риск.** Зомби-процессы на Windows. `killPid` в `process-registry.ts:383` уже есть.

---

## 2. Следующие после топ-10

### 2.1. Рецепты («рецепты» с формой)

- **Что.** Карточка «Бот для Telegram» открывает маленькую форму: «Что бот отвечает?», «Токен» (через п. 3). Из
  формы собирается хороший запрос. Это развитие кнопок-примеров.
- **У кого.** goose (Apache-2.0):
  - формат — `crates/goose/src/recipe/mod.rs`: `title`, `description`, `instructions`, `prompt`, `parameters`
    (`key`, `input_type` = string / number / boolean / date / file / select, `requirement`, `default`,
    `options`), `activities`, `retry`;
  - форма — `ui/desktop/src/components/ParameterInputModal.tsx` (311 строк), список —
    `components/recipes/RecipesView.tsx`;
  - ссылка-рецепт `goose://recipe?config=…` — `components/recipes/ImportRecipeForm.tsx`.
- **Как у нас.** Хранить рецепты как шаблоны Pi (`.md` с frontmatter, подстановки `$1`, `${1:-по умолчанию}` —
  документация Pi `docs/prompt-templates.md`) и добавить свой ключ `params:` для формы. **ui** рисует форму.
- **Вердикт.** ИДЕЯ. Объём S–M. Ценность средняя.

### 2.2. Голосовой ввод

- **Факт.** `webkitSpeechRecognition` в Electron не работает: в сборках нет ключа Google. Об этом пишут проект
  [electron-speech](https://github.com/jrichardsz/electron-speech) и
  [рассылка W3C](https://lists.w3.org/Archives/Public/public-speech-api/2018Feb/0000.html). Поэтому путь bolt.diy
  (`app/components/chat/BaseChat.tsx:167`) и «BrowserNative» у AnythingLLM
  (`frontend/src/components/WorkspaceChat/ChatContainer/PromptInput/SpeechToText/BrowserNative/index.jsx`) нам
  не подходят.
- **Что брать.**
  - Запись — goose (Apache-2.0) `ui/desktop/src/hooks/useAudioRecorder.ts` (386 строк, `AudioContext` и
    `encodeWav` на строке 54).
  - Распознавание — запрос к `/v1/audio/transcriptions` нашего шлюза. Образец клиента — AnythingLLM (MIT)
    `server/utils/SpeechToText/openAiGeneric/index.js`.
  - Голос Dyad идёт через их платный движок (`src/ipc/utils/llm_engine_provider.ts:390`).
- **Без шлюза.** Встроенный голосовой ввод Windows (Win+H) работает с русским, точность средняя, частично через
  облако ([Timeweb, 2026](https://timeweb.com/ru/community/articles/golosovoy-vvod-na-windows-i-mac-v-2026-chto-realno-rabotaet-s-russkim)).
  Для альфы хватит подсказки у кнопки микрофона: «нажмите Win+H».
- **Локальный Whisper** (goose на Candle — `crates/goose/src/dictation/whisper.rs`; AnythingLLM —
  `collector/utils/WhisperProviders/localWhisper.js`) — сотни мегабайт. Установщик и так 822 МБ
  (`STATUS-core.md`, «Не сделано»). НЕ БРАТЬ.
- **Вердикт.** ИДЕЯ, ждёт владельца: есть ли распознавание речи на шлюзе.

### 2.3. Шаблоны-стартеры в комплекте

- **У кого.** Dyad — `src/shared/templates.ts` (репозитории на GitHub, например `dyad-sh/nextjs-template`),
  клонирование — `src/ipc/handlers/createFromTemplate.ts`. bolt.diy — `app/components/chat/StarterTemplates.tsx`,
  `app/routes/api.github-template.ts`. Оба тянут с GitHub, а он в России деградирует с мая 2026 (§3).
- **Как у нас.** 4–5 офлайн-стартеров в установщике: визитка (HTML), лендинг (HTML+CSS), бот Telegram с `.env`,
  скрипт для Excel (Python), простая игра. Связать с рецептами.
- **Вердикт.** ИДЕЯ. Объём M (контент). Ценность средняя.

### 2.4. План-чеклист длинной задачи

- **У кого.** Jan (Apache-2.0): `web-app/src/containers/CoworkTodoPanel.tsx` (155 строк), `CoworkTodoChip.tsx`
  (53). Список приходит от инструмента `todo_write` (`web-app/src/hooks/useCoworkSessions.ts:60`). У Dyad
  `update_todos` лежит в `src/pro/` — нельзя.
- **У нас.** Строка прогресса (`STATUS-ui.md`, этап 3). Плана нет.
- **Вердикт.** ИДЕЯ, после альфы: инструмент в harness и чип «План: 2 из 5» в ui. Риск — модель тратит ходы на
  обновление списка.

---

## 3. Публикация сайта из России

Что сейчас известно о доступности без VPN.

| Площадка | Из России | Что нужно человеку | Источник |
|---|---|---|---|
| Vercel (`*.vercel.app`, свой домен) | Частично. Свой домен часто не открывается: блок по IP у отдельных операторов. На мобильном интернете — у многих не работает | аккаунт, GitHub | [Vercel community #29141](https://community.vercel.com/t/urgent-production-domain-bbqp-pro-is-blocked-in-russia-confirmed-vercel-ip-issue/29141), [#46894](https://community.vercel.com/t/custom-domain-umrahaj-ru-unreachable-on-megafon-and-beeline-in-grozny-while-vercel-app-works/46894), [Хабр, Amvera, 2026](https://habr.com/ru/companies/amvera/articles/1028136/) |
| Netlify | Плохо. IP режут провайдеры. В июле 2024 пользователь сообщил, что общий балансировщик 75.2.60.5 заблокирован решением суда, а на нём миллионы сайтов | аккаунт | [Netlify forum, 01.07.2024](https://answers.netlify.com/t/seems-like-my-website-is-blocked-in-russia-by-mistake/121260), [Хабр Q&A](https://qna.habr.com/q/1409242), [Хабр, Amvera](https://habr.com/ru/companies/amvera/articles/1028136/) |
| Cloudflare Pages (`*.pages.dev`) | Плохо. С 9 июня 2025 провайдеры пропускают только первые 16 КБ на соединение; Cloudflare это подтвердил | аккаунт | [Медиазона, 27.06.2025](https://zona.media/news/2025/06/27/cf-confirmed), [Хабр 1011050](https://habr.com/ru/articles/1011050/) |
| GitHub Pages | Нет официального блока, но с 5 мая 2026 доля неудачных подключений к GitHub выросла с 6 до 16 % (OONI) | аккаунт GitHub, git | [mentoday, 08.05.2026](https://www.mentoday.ru/technics/news/08-05-2026/roskomnadzor-usilil-blokirovku-github-razrabotchiki-massovo-soobshchayut-o-problemah-s-zagruzkoi-koda/), [Skillbox](https://skillbox.ru/media/code/blokirovka-github-v-rossii-chto-izvestno/) |
| Surge.sh | Данных не нашёл. Площадка зарубежная — полагаться нельзя | аккаунт | — |
| Yandex Object Storage (статический сайт) | Работает. Адрес `<бакет>.website.yandexcloud.net`; HTTPS для своего домена — через CDN и Certificate Manager | аккаунт Yandex Cloud, платёжный аккаунт, сервисный ключ | [документация](https://yandex.cloud/ru/docs/storage/concepts/hosting), [тарифы](https://yandex.cloud/ru/docs/storage/pricing): бесплатно 1 ГБ, 100 000 GET и 100 ГБ трафика в месяц; [Хабр 1011050](https://habr.com/ru/articles/1011050/) — переезд за 0 ₽/мес |
| Timeweb Cloud S3 | Работает. Адрес `*.website.twcstorage.ru`; есть App Platform (платно) | аккаунт, ключ сервисного аккаунта | [блог на teletype](https://teletype.in/@beaverclan/blogontimewebs3), [Threads](https://www.threads.com/@mangust59/post/DUds2IMExxV/) |
| Amvera | Работает (российский PaaS), деплой через git push или перетаскиванием файлов; от 170 ₽/мес | аккаунт | [Хабр, Amvera](https://habr.com/ru/companies/amvera/articles/1028136/) (статья самой Amvera) |

**Что у аналогов.** bolt.diy: Netlify, Vercel, GitHub, GitLab (`app/components/deploy/*`, например
`NetlifyDeploy.client.tsx`). Dyad: Vercel, Cloudflare, Coolify, GitHub (`src/ipc/handlers/vercel_handlers.ts`,
`cloudflare_handlers.ts`, `coolify_handlers.ts`). Всё это зарубежные площадки из таблицы. Код НЕ БРАТЬ.

**Предложение.**
1. **Альфа:** «Скачать архив» (топ-10, п. 4) и короткая инструкция «как выложить на российский хостинг».
2. **Для продвинутых:** «Опубликовать в своё хранилище». Один код на S3 API (PutObject с правильным
   `Content-Type` — без него стили не применяются, это отмечено в [Хабр 1011050](https://habr.com/ru/articles/1011050/))
   подходит к Yandex, Timeweb и другим S3-совместимым. Человек вставляет ключ и имя бакета. Объём M.
3. **Лучший путь для казуала:** свой хостинг PRSLOY (`имя.prsloy.<домен>`), без чужих аккаунтов. Это **решение
   владельца**: юридическая ответственность за чужие сайты, фишинг, модерация, деньги на сервер.

---

## 4. Полная таблица: всё, что посмотрел

| Функция | Где (репозиторий: файл) | Лицензия | У нас | Вердикт |
|---|---|---|---|---|
| Вопрос с вариантами | Roo: `src/core/prompts/tools/native-tools/ask_followup_question.ts`; Cline | Apache-2.0 | нет в «Коде» | ИДЕЯ, топ-1 |
| Ошибка превью → «Починить» | Dyad: `worker/dyad-shim.js`, `PreviewErrorBanner.tsx`, `FixAllErrorsButton.tsx`; bolt.diy: `ChatAlert.tsx` | Apache-2.0 / MIT | нет | ИДЕЯ, топ-2 |
| Перехват console превью | Dyad: `worker/dyad_logs.js` | Apache-2.0 | нет | ИДЕЯ (внутри топ-2, топ-10) |
| Проверка типов → «Починить все» | Dyad: `src/ipc/handlers/problems_handlers.ts`, `src/ipc/processors/tsc.ts` | Apache-2.0 | стоп-гейт гоняет `typecheck` и `test` (`STATUS-harness.md`, этап 6) | НЕ БРАТЬ (уже есть иначе) |
| Запрос секрета формой | OpenHands: `src/api/request-secret-client-tool.ts`, `secret-request-card.tsx` | MIT | нет | БРАТЬ КОД, топ-3 |
| Переменные окружения проекта (.env) | Dyad: `app_env_vars_handlers.ts`, `ConfigurePanel.tsx` | Apache-2.0 | нет | ИДЕЯ (вместе с топ-3; список «Ключи проекта» — позже) |
| Архив проекта | bolt.diy: `app/lib/stores/workbench.ts:908`; наш `main/design/zip.ts` | MIT / наш | только в «Дизайне» | свой код, топ-4 |
| Выбор элемента в превью | bolt.diy: `public/inspector-script.js`, `Inspector.tsx`; Dyad: `dyad-component-selector-client.js` + tagger | MIT / Apache-2.0 | нет | БРАТЬ КОД (bolt.diy), топ-5 |
| Визуальная правка без модели (цвет, отступ) | Dyad: `VisualEditingToolbar.tsx` + `src/pro/main/ipc/handlers/visual_editing_handlers.ts`; bolt.diy: `InspectorPanel.tsx` | FSL (Dyad) / MIT | нет | НЕ БРАТЬ сейчас: у Dyad запись в файл — под FSL; для HTML без сборки сопоставление с исходником ненадёжно |
| Поиск по чатам | PiCove: `packages/pi-host/src/session-search.ts`; Cline: `HistoryView.tsx`; goose: `chat_history_search.rs` | MIT / Apache-2.0 | нет | БРАТЬ КОД (PiCove), топ-6 |
| Избранное и заметки к чатам | Cline: `HistoryView.tsx`; Dyad: `VersionPane.tsx` (заметки к версиям) | Apache-2.0 | нет | ИДЕЯ, низкая ценность |
| Подсказки «что дальше» | Dyad: `src/lib/suggestedPrompts.ts`, `local_agent_prompt.ts:107` | Apache-2.0 | только примеры в пустом чате | БРАТЬ КОД, топ-7 |
| История версий с возвратом | Dyad: `VersionPane.tsx`, `version_handlers.ts` | Apache-2.0 | откат по ходу есть, списка нет | ИДЕЯ, топ-8 |
| Контрольные точки | Cline, Roo, OpenCode | Apache-2.0 / MIT | есть: теневой git (`STATUS-core.md`, п. 6) | НЕ БРАТЬ (есть) |
| Снимок части превью | bolt.diy: `ScreenshotSelector.tsx`; Dyad Annotator (`src/pro`) | MIT / FSL | вставка картинок есть | ИДЕЯ, топ-9 |
| Запуск, стоп, журнал | Dyad: `src/app_run/*`, `Console.tsx` | Apache-2.0 | у модели есть, у человека нет | ИДЕЯ, топ-10 |
| Рецепты с параметрами | goose: `crates/goose/src/recipe/mod.rs`, `ParameterInputModal.tsx` | Apache-2.0 | примеры-кнопки | ИДЕЯ, §2.1 |
| Библиотека своих запросов | Dyad: `src/ipc/handlers/prompt_handlers.ts`, `LibraryList.tsx` | Apache-2.0 | нет | ИДЕЯ (через рецепты), низкая |
| Голос | goose: `useAudioRecorder.ts`; AnythingLLM: `SpeechToText/openAiGeneric`; bolt.diy: Web Speech | Apache-2.0 / MIT | нет | ИДЕЯ, ждёт шлюза, §2.2 |
| Шаблоны-стартеры | Dyad: `src/shared/templates.ts`; bolt.diy: `StarterTemplates.tsx` | Apache-2.0 / MIT | нет | ИДЕЯ (офлайн), §2.3 |
| План-чеклист | Jan: `CoworkTodoPanel.tsx`; Dyad: `update_todos` (`src/pro`) | Apache-2.0 / FSL | строка прогресса | ИДЕЯ, после альфы, §2.4 |
| Вложения-картинки | Zeno (уже), Dyad, bolt.diy, pi-gui | — | есть (`Composer.tsx`) | НЕ БРАТЬ (есть) |
| Импорт проекта | Dyad: `import_handlers.ts`, `ImportAppDialog.tsx`; bolt.diy: `ImportFolderButton.tsx`, `ImportZipButton.tsx` | Apache-2.0 / MIT | любая папка = проект | НЕ БРАТЬ; «открыть архив» — низкая ценность |
| Публикация на Vercel, Netlify, Cloudflare | bolt.diy: `app/components/deploy/*`; Dyad: `vercel_handlers.ts`, `cloudflare_handlers.ts` | MIT / Apache-2.0 | нет | НЕ БРАТЬ (§3) |
| Клон сайта по ссылке | Open Lovable: `app/api/scrape-website`, `extract-brand-styles/route.ts` (Firecrawl) | MIT | нет | НЕ БРАТЬ код (платный зарубежный API). Идея «по образцу сайта» — для дорожки design (свой Playwright) |
| Облачная песочница | Open Lovable: E2B / Vercel Sandbox (`lib/sandbox`); bolt.diy: WebContainer (`app/lib/webcontainer`) | MIT | у нас настоящий диск и свой Node | НЕ БРАТЬ |
| Быстрое применение правок | Open Lovable: `lib/morph-fast-apply.ts` (Morph API); Dyad: turbo edits (`src/pro`) | MIT / FSL | Pi `edit` и устойчивость правок (`STATUS-harness.md`, п. 6) | НЕ БРАТЬ |
| «Улучшить запрос» | bolt.diy: `app/lib/hooks/usePromptEnhancer.ts`; Kilo: `packages/kilo-vscode/src/enhance-prompt-error.ts` | MIT | нет | НЕ БРАТЬ (§6) |
| Автоодобрение по видам действий | Cline: `chat/auto-approve-menu/*`; Roo: `src/core/auto-approval/index.ts` | Apache-2.0 | граница записи + «Обычный доступ» | НЕ БРАТЬ (§6) |
| Режимы «план / делать» | Cline, Roo, Kilo, Lovable | — | разобрано в `research/11` (P1: режим выбирает харнесс) | НЕ БРАТЬ как переключатель |
| Маркетплейс MCP и расширений | Cline: `webview-ui/src/components/marketplace`; Kilo: `MarketplacePanelProvider.ts`; goose: extensions; Cherry Studio | Apache-2.0 / MIT / AGPL | MCP спрятан за «Для разработчиков» (`STATUS-ui.md`, п. 4) | НЕ БРАТЬ (§6) |
| Уведомление ОС «готово» | pi-gui (статус «needs you»); Zeno | MIT | есть (`main/index.ts`, `showOsNotification`) | НЕ БРАТЬ (есть) |
| Параллельные треды, worktree, терминал, ревью кусков | pi-gui, PiCove | MIT | спрятано в режиме разработчика | НЕ БРАТЬ |
| Задачи по расписанию, автоматизации | pi-gui, OpenHands Agent Canvas (`src/api/automation-service`), Cherry Studio | MIT / AGPL | нет | позже (профиль «Повседнев») |
| Бот-канал Telegram к самому агенту | AnythingLLM: `server/utils/telegramBot` | MIT | нет | позже: Telegram вне альфы (`PLAN-alpha.md` §1) |
| Баланс шлюза в интерфейсе | OpenHands: `src/api/llm-balance-service.ts` | MIT | нет: эндпоинт баланса шлюза неизвестен (`STATUS-core.md`, «Не сделано») | ИДЕЯ, ждёт шлюза |
| Лимит денег на задачу | Cline (лимиты организации), наш `budget.ts` | — | есть: $0.50 на задачу (`STATUS-harness.md`, п. 3) | вынести в настройки в ₽ — мелочь, не из аналогов |
| Обучающий тур | bolt.diy: `FirstRunOnboarding.tsx`; goose: `components/onboarding` (настройка провайдера) | MIT / Apache-2.0 | первый запуск + примеры (`STATUS-ui.md`, этапы 2, 8) | НЕ БРАТЬ (§6) |
| Принципы UX для непрограммиста | Dyad: `PRODUCT.md` («Never a dead end», «Translate, don't expose») | Apache-2.0 | близко к нашему казуальному режиму | ИДЕЯ: сослаться в AGENTS.md дорожки ui |
| Комментарии к строкам диффа | OpenCode: `packages/app/src/composer/comments.tsx` | MIT (SolidJS) | нет | НЕ БРАТЬ (для разработчиков) |
| Редактор на базе VS Code | Void | Apache-2.0 | — | НЕ БРАТЬ: проект закрыт (README «Void is now deprecated») |

---

## 5. Лицензии (проверено по файлу LICENSE в клоне)

| Репозиторий | Коммит, дата | LICENSE | Код брать можно? | Заметки |
|---|---|---|---|---|
| [dyad-sh/dyad](https://github.com/dyad-sh/dyad) | `1be2b4b`, 2026-10-22 | Apache-2.0, **кроме `src/pro/`** — FSL-1.1-ALv2 (`src/pro/LICENSE`) | да, вне `src/pro/` | FSL запрещает конкурирующее использование. Есть `NOTICE` — сохранить при копировании |
| [stackblitz-labs/bolt.diy](https://github.com/stackblitz-labs/bolt.diy) | `353b44c`, 2026-10-14 | MIT, © 2024 StackBlitz, Inc. and bolt.diy contributors | да | |
| [firecrawl/open-lovable](https://github.com/firecrawl/open-lovable) | `806b807`, 2026-10-09 | MIT | да | без ключей Firecrawl, E2B или Vercel не работает |
| [block/goose](https://github.com/block/goose) | `2b17adc`, 2026-10-24 | Apache-2.0 | да | ядро на Rust, настольный UI — Electron + React |
| [sst/opencode](https://github.com/sst/opencode) | `32b5701`, 2026-10-25 | MIT | да | UI на SolidJS — перенос в React = переписывание |
| [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | `b185939`, 2026-10-25 | MIT | да | репозиторий теперь «Agent Canvas»: Electron + React, умеет запускать Pi |
| [cline/cline](https://github.com/cline/cline) | `40c5d99`, 2026-10-23 | Apache-2.0 (`apps/vscode/LICENSE`) | да | |
| [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | `b867ec9`, 2026-05-15 | Apache-2.0 | да | проект закрыт 2026-05-15 ([Distill](https://www.distillintelligence.com/news/roomote)) |
| [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) | `9723be6`, 2026-10-23 | MIT (© Kilo Code и © opencode) | да | теперь построен на OpenCode |
| [voideditor/void](https://github.com/voideditor/void) | `b3166e7`, 2026-06-02 | Apache-2.0 + MIT (VS Code) | да | проект закрыт |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | `a5bb8b9`, 2026-10-23 | MIT | да | |
| [janhq/jan](https://github.com/janhq/jan) | `a4f0ddd`, 2026-10-23 | Apache-2.0 | да | Tauri + React |
| [Kochava-Studios/witsy](https://github.com/Kochava-Studios/witsy) | `c81c7de`, 2026-04-09 | **AGPL-3.0** (+ CLA) | **нет**, только идеи | старый `nbonamy/witsy` (`399d2db`) теперь — README «Witsy has a new home» |
| [chatboxai/chatbox](https://github.com/chatboxai/chatbox) | `0ac6385`, 2026-09-24 | **GPL-3.0** | **нет**, только идеи | |
| [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) | `03963f1`, 2026-10-25 | **AGPL-3.0** | **нет**, только идеи | |
| [minghinmatthewlam/pi-gui](https://github.com/minghinmatthewlam/pi-gui) | `d6f8c46`, 2026-10-21 | MIT | да | |
| [Skitre/PiDeck](https://github.com/Skitre/PiDeck) (PiCove) | `102d9e1`, 2026-09-13 | MIT, © 2026 PiDeck contributors | да | |
| [PriNova/graphone](https://github.com/PriNova/graphone) | `d46e083`, 2026-06-23 | MIT | да | |

**Атрибуция при копировании** (дописать в `app/NOTICE.md`; шапку с лицензией — в сам файл):
- bolt.diy `public/inspector-script.js` — MIT, © 2024 StackBlitz, Inc. and bolt.diy contributors.
- PiCove/PiDeck `packages/pi-host/src/session-search.ts` — MIT, © 2026 PiDeck contributors.
- OpenHands — текст описания `request_secret`, MIT, © 2025 OpenHands contributors.
- Dyad `src/lib/suggestedPrompts.ts` — Apache-2.0, Dyad contributors. Для Apache-2.0: копия лицензии, пометка
  «изменено PRSLOY» в изменённых файлах, перенос нужных строк из их `NOTICE`.
- goose `useAudioRecorder.ts` (если возьмём для голоса) — Apache-2.0, Block, Inc.

---

## 6. Что не брать и почему

- **Маркетплейс MCP и расширений** (Cline, Kilo, goose, Cherry Studio). Чужой код получает доступ к файлам
  человека и к нашему ключу. Интерфейсы на английском, нужны свои ключи, поддержка ляжет на нас. Zeno уже прячет
  MCP за «Для разработчиков» (`STATUS-ui.md`, п. 4) — так и оставить.
- **Публикация на Vercel, Netlify, Cloudflare Pages** — из России заблокированы или нестабильны (§3).
  Казуал получит «у меня всё работает, а у клиента не открывается».
- **Шаблоны и интеграции через GitHub как основной путь** — GitHub в России деградирует с мая 2026, а казуалу нужен
  аккаунт и git (§3).
- **Всё из `dyad/src/pro/`** — визуальная правка с записью в файл, аннотатор, поиск по чатам Dyad, turbo edits,
  `update_todos`. Лицензия FSL запрещает конкурирующее использование.
- **Код Chatbox (GPL-3.0), Cherry Studio (AGPL-3.0) и Witsy (AGPL-3.0)** — копилефт потребовал бы открыть наше
  приложение под той же лицензией. Только идеи. Новых идей для «Кода» сверх таблицы там не нашёл: библиотеки
  «ассистентов», база знаний, перевод.
- **Облачные песочницы и платные API Open Lovable** (E2B, Vercel Sandbox, Firecrawl, Morph) — зарубежные платные
  сервисы с ключами. У нас всё локально.
- **Web Speech API** (bolt.diy, AnythingLLM BrowserNative) — в Electron не работает (§2.2).
- **Локальный Whisper** — сотни мегабайт к установщику в 822 МБ.
- **Тонкое автоодобрение по видам действий** (Cline `auto-approve-menu`, Roo `auto-approval`) — казуал не поймёт,
  что такое «MCP» или «безопасные команды». У нас есть граница записи и «Обычный доступ».
- **Переключатель «план / делать»** — режим должен выбирать харнесс (`research/11`, P1), человек видит кнопки
  «Поехали» и «Поправить».
- **«Улучшить запрос»** (bolt.diy, Kilo) — дешёвая модель дописывает требования, которых человек не просил. Вместо
  этого — бриф с допущениями (`research/11`, P4).
- **Обучающие туры** — ни у одного аналога «Кода» их нет. Работают пустые состояния с одним понятным действием
  (Dyad `PRODUCT.md`: «Never a dead end»), а это у нас уже есть.
- **Void** (закрыт), **Roo Code** (закрыт) — только идеи, код не тащить: никто не будет чинить.
- **UI OpenCode и Kilo** — SolidJS, перенос в React = переписывание. Главную идею (теневой git) мы уже взяли.
- **Параллельные треды, worktree, терминал, ревью по кускам** (pi-gui, PiCove) — для разработчиков.

---

## Источники

Код (локальные клоны, коммиты в §5): `/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/analogs/`.

Наши файлы: `PLAN-alpha.md`; `app/docs/prsloy/STATUS-ui.md`, `STATUS-core.md`, `STATUS-harness.md`,
`STATUS-design.md`, `STATUS-ci.md`; `app/packages/prsloy-harness/src/*.ts`;
`app/apps/desktop/src/main/design/{preview-server,zip}.ts`; `app/apps/desktop/src/shared/prsloy-config.ts`;
`research/11-intent-and-dispatch.md`; документация Pi `@earendil-works/pi-coding-agent@1.4.0/docs/prompt-templates.md`
и `dist/core/extensions/types.d.ts` (опции диалогов).

Веб:
- Vercel из России: [community #29141](https://community.vercel.com/t/urgent-production-domain-bbqp-pro-is-blocked-in-russia-confirmed-vercel-ip-issue/29141), [community #46894](https://community.vercel.com/t/custom-domain-umrahaj-ru-unreachable-on-megafon-and-beeline-in-grozny-while-vercel-app-works/46894)
- Netlify из России: [answers.netlify.com, 2024](https://answers.netlify.com/t/seems-like-my-website-is-blocked-in-russia-by-mistake/121260), [answers.netlify.com, 2020](https://answers.netlify.com/t/update-on-availability-from-russia/21036), [Хабр Q&A 1409242](https://qna.habr.com/q/1409242)
- Cloudflare: [Медиазона, 27.06.2025](https://zona.media/news/2025/06/27/cf-confirmed)
- Обзоры: [Хабр 1011050 — переезд на Yandex Cloud](https://habr.com/ru/articles/1011050/), [Хабр 1028136 — аналоги Vercel (Amvera)](https://habr.com/ru/companies/amvera/articles/1028136/)
- GitHub в мае 2026: [mentoday](https://www.mentoday.ru/technics/news/08-05-2026/roskomnadzor-usilil-blokirovku-github-razrabotchiki-massovo-soobshchayut-o-problemah-s-zagruzkoi-koda/), [Skillbox](https://skillbox.ru/media/code/blokirovka-github-v-rossii-chto-izvestno/)
- Yandex Object Storage: [хостинг](https://yandex.cloud/ru/docs/storage/concepts/hosting), [тарифы](https://yandex.cloud/ru/docs/storage/pricing)
- Timeweb S3: [teletype](https://teletype.in/@beaverclan/blogontimewebs3)
- Web Speech в Electron: [electron-speech](https://github.com/jrichardsz/electron-speech), [W3C public-speech-api](https://lists.w3.org/Archives/Public/public-speech-api/2018Feb/0000.html)
- Голосовой ввод Windows с русским: [Timeweb, 2026](https://timeweb.com/ru/community/articles/golosovoy-vvod-na-windows-i-mac-v-2026-chto-realno-rabotaet-s-russkim)
- Закрытие Roo Code: [Distill Intelligence](https://www.distillintelligence.com/news/roomote)
