# 20 — Открытые аналоги для вкладки «Дизайн»: что взять готовым (срез 2026-10-25)

Вопрос владельца: «глянуть опенсорсные аналоги и взять то, что нужно, чтобы не изобретать велосипеды».
Здесь разобраны инструменты визуальной сборки страниц с ИИ. Для каждой функции сказано: что она даёт казуальному
владельцу, у кого есть, есть ли у нас, сколько стоит перенос, и вердикт.

**Как проверяли.** 36 репозиториев склонированы с `--depth 1` в
`/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/analogs-design/<имя>`. Код не запускали,
зависимости не ставили. Лицензии читали из файла LICENSE в корне (или из `package.json` пакета, если корневого файла
нет). Пути ниже даны от корня репозитория. В скобках — короткий хэш коммита, который смотрели.

Обозначения:
- **[V]** — проверено по коду в клоне, по официальной документации или по реестру пакетов (npm, PyPI).
- **[U]** — вторичный источник, форум или наша оценка. Сюда же — всё про доступность из России: мы работаем через
  прокси в США и замерить из РФ не можем (как и в `research/13-design-pipeline.md`).
- **Оценка** — сроки и выигрыш по времени. Это предположение, не замер.

Полосы работ (из `PLAN-alpha.md:93-97`): **ui** (интерфейс и бренд), **core** (провайдер, ключи, Windows), **harness**
(пакет расширений Pi), **design** (вкладка «Дизайн»: `app/apps/desktop/src/main/design/`, `DesignPage.tsx`),
**дирижёр** (`playbooks/site/harness/run.py`, `stages.json`, патч и PR в пайплайн).

---

## Коротко

1. **Самый близкий аналог — Open CoDesign** (MIT, `OpenCoworkAI/open-codesign`). Это настольное Electron-приложение
   на том же Pi, что и у нас (`apps/desktop/package.json:32-34`). В нём уже есть: «ткни в элемент и скажи» с
   булавками, ползунки токенов без вызова модели, правка текста без модели, типизированный инструмент вопросов
   `ask`, судья с 12 вопросами «да/нет». Почти всё это можно брать кодом. [V]
2. **«Ткни и скажи» на нашем превью делается маленьким скриптом.** Наш iframe отдаёт статический HTML с loopback.
   Сервер превью может вставлять скрипт выбора элемента только в режиме правки. Сам скрипт берём у bolt.diy (MIT,
   432 строки) или Open CoDesign (MIT). Формулировку задания агенту — у screenshot-to-code (MIT) и Dyad
   (Apache-2.0). Привязка к исходнику для статики проще, чем у Onlook и Dyad: исходник и есть отданный HTML.
3. **Бренд по адресу сайта владельца — готов.** dembrandt (MIT) и `clipper/brand-capture.js` из OpenDesign
   (Apache-2.0) читают цвета, шрифты, радиусы и даже кривые движения с живой страницы за секунды, без модели.
   Палитру со скриншотов у нас уже снимает `palette.py`, он лучше node-vibrant.
4. **Быстрый черновик.** Открытые генераторы дают первую страницу за 1–6 минут (Open CoDesign `BENCHMARKS.md`:
   56–366 с), но уровня шаблона. Наше узкое место не черновик, а судья на шаге 7 (2–3 ч в E8d) и ожидание владельца.
   Брать стоит приёмы: параллельные варианты одним вызовом, «создать файл один раз, дальше только точечные правки»,
   и булев чек-лист судьи с пределом раундов.
5. **Проверки.** axe-core у нас уже есть. Не хватает трёх вещей: сравнения «до/после» правки с маской
   (алгоритм pixelmatch, ISC), проверки «на странице только цвета бренда» (идея drift из dembrandt) и CSS-слопа
   (правила из `lint-artifact.ts` OpenDesign). BackstopJS, Lost Pixel и reg-suit целиком не нужны.
6. **Выкладка без VPN.** Cloudflare режут с июня 2025 (первые 16 КБ), у Vercel блокируют IP своих доменов, Surge
   живёт на DigitalOcean. Для РФ: Yandex Object Storage (домашний, 1 ГБ и 100 ГБ трафика в месяц бесплатно) и
   бесплатный хостинг Beget по FTP. GitHub Pages и Netlify — только запасной путь.
7. **Не брать:** tldraw (лицензия запрещает прод без ключа), всё под AGPL (stagewise, Webstudio,
   make-real-starter), `src/pro/` Dyad (FSL), Agentation (PolyForm Shield), платные облачные ИИ у Puck и GrapesJS,
   Penpot (нужен сервер), каталоги «дизайн-систем» известных брендов.

---

## Что болит (почему ранжировано именно так)

- Лендинг идёт ~3 ч и ~500 вызовов модели. Владелец ждёт от 4 до 80 минут на ход. (задание; `DIARY.md`, E9:
  «Минут работы агентов 163 + шаг 8»)
- Судья съедает больше всего: E8d — «2+ часа на шаге 7», PASS на 13-м раунде; E9 — судья «с каждым раундом находит
  больше (2 → 7 → 14 находок)». (`DIARY.md`, разделы E8d и E9)
- Время уходит на размер контекста и число вызовов: «медиана времени до первого токена 8–14 с… главный рычаг —
  размер контекста и число вызовов». (`DIARY.md`, «Где уходит время»)
- Правка выбранного прототипа откатывала пайплайн на шаг 5 («лист устарел»). (`DIARY.md`, E8q)
- Ответы кнопками ломаются на разборе текста: «как рекомендуешь» не засчитано, «а а а» переспрошено.
  (`DIARY.md`, E8b, E8q; `run.py:493-553` разбирает варианты из текста)
- Шаг 8 «выложить» только спрашивает. Деплоя нет, есть «Скачать архив» и «Открыть папку».
  (`app/docs/prsloy/STATUS-design.md`, этап 4; `stages.json`, шаг 8)
- Правило «цвета только из 02-brand.md» кодом не проверяется: `flow.py` смотрит только наличие палитры
  (`design-pipeline/tools/flow.py:813-829`), гейт цвета на странице не сверяет.

---

## Топ-10: ценность на усилие

Порядок: сначала то, что сильнее всего сокращает ожидание владельца при малой работе.

### 1. «Ткни и скажи» на превью

- **Что даёт владельцу.** На готовой странице он жмёт «Править», наводит мышь, кликает на заголовок и пишет
  «крупнее» или жмёт кнопку «Убрать». Не надо описывать словами, где это. Несколько булавок уходят одной правкой.
- **У кого есть.**
  - bolt.diy, MIT (`353b44c`): `public/inspector-script.js` (432 строки, чистый JS, без фреймворка). Подсветка,
    клик, `postMessage` родителю, вычисленные стили (`getRelevantStyles`), путь элемента (`getElementPath`, стр. 195),
    живые правки стилей с откатом (`handleEditMessage`, стр. 297). Как выбор уходит в задание:
    `app/components/chat/Chat.client.tsx:943-953`. [V]
  - Open CoDesign, MIT (`4cf3393`): `packages/runtime/src/overlay.ts` (837 строк). Скрипт вставляется в iframe,
    шлёт `ELEMENT_SELECTED` с XPath, тегом, `outerHTML`, `parentOuterHTML`, прямоугольником (стр. 363-370,
    451-476). Переподвешивает слушатели каждые 200 мс, если код страницы их снял (стр. 707). Задание агенту:
    `packages/core/src/index.ts:378` (`buildApplyCommentUserPrompt`: «Prioritize the selected element first and avoid
    unrelated edits»). Булавки и пакет правок: `apps/desktop/src/renderer/src/components/comment/PinOverlay.tsx`,
    `components/chat/CommentChipBar.tsx` (кнопка «Применить» шлёт все ждущие правки одним ходом),
    `store/slices/comments.ts`. [V]
  - screenshot-to-code, MIT (`a813977`): `frontend/src/components/select-and-edit/utils.ts` (59 строк).
    `describeElementContext` пишет путь из 6 предков и предупреждает, если такой же разметки на странице несколько
    («выбран номер 2 из 3, якорись на родителе»). Системное правило «Targeted element edits»:
    `backend/prompts/system_prompt.py:91-95`. [V]
  - Dyad, Apache-2.0 вне `src/pro/` (`1be2b4b`): `worker/proxy_server.js:248` (`injectHTML` вставляет скрипты в
    HTML превью на лету), `worker/dyad-component-selector-client.js` (подъём к ближайшему предку с меткой
    исходника, стр. 263 и 380; сообщение о выборе, стр. 508-520). Задание агенту:
    `src/ipc/handlers/chat_stream_handlers.ts:1735-1775` (файл, строка, фрагмент с пометкой `// <-- EDIT HERE`). [V]
  - react-grab, MIT: `packages/react-grab/src/core/html-preview.ts` (164 строки) — короткий фрагмент элемента с
    обрезкой атрибутов, экономит токены. [V]
- **Есть ли у нас.** Нет. Есть превью в `<iframe sandbox="allow-scripts">` на loopback
  (`app/apps/desktop/src/renderer/components/PreviewFrame.tsx:58-61`) и статический сервер
  (`app/apps/desktop/src/main/design/preview-server.ts`). Идея описана в `research/13-design-pipeline.md:351,363`
  (оверлей «à la Agentation»), кода нет.
- **План переноса.**
  1. **design:** в `preview-server.ts` режим правки (`?edit=1` или второй сервер). Для `text/html` вставлять
     `edit-overlay.js` перед `</body>` (как `injectHTML` у Dyad). Файлы на диске не трогаются, гейт и судья
     смотрят чистую страницу.
  2. **design:** там же размечать каждый исходный тег атрибутом `data-pl="index.html:строка:колонка"`. Позиции даёт
     parse5 (MIT) с `sourceCodeLocationInfo: true`. parse5 уже есть в дереве зависимостей приложения
     (`app/node_modules/.pnpm/parse5@7.3.0`, `parse5@8.0.1`, через jsdom); main собирается vite и сторонние пакеты
     не выносит (`vite.main.config.ts:12-22`).
  3. **design + ui:** `edit-overlay.js` собрать из `inspector-script.js` bolt.diy (база) и двух кусков:
     подъём к предку с `data-pl` (узлы, которые создал `motion.js`, меток не имеют) и `describeElementContext`.
     Родитель проверяет `event.source === iframe.contentWindow`: у песочницы без `allow-same-origin` origin равен
     `"null"`.
  4. **ui:** в `DesignPage.tsx` (около стр. 685-705, блок превью) кнопка «Править», всплывашка у элемента:
     «Крупнее», «Мельче», «Поменять текст», «Убрать», «Своими словами…». Булавки копятся, «Применить N правок».
  5. **дирижёр:** `run.py say --edit <json>`. Короткая сессия Pi вне лестницы шагов: бюджет 10–15 вызовов,
     5 минут, дешёвая модель. Задание: файл и строки, фрагмент с пометкой «ПРАВИТЬ ЗДЕСЬ», путь, «номер N из M»,
     слова владельца. Политика: точечная правка после шага 6 не откатывает пайплайн, полный гейт и судья —
     один раз перед «выложить» (решает дирижёр; сейчас `flow.py` требует отчёт свежее последней правки).
- **Усилие.** Оценка: 3–4 дня (скрипт и сервер — 1–2, интерфейс — 1, `run.py` — 1).
- **Ценность и риск.** Ценность высокая: меньше переспросов, маленький контекст на правку. Оценка: правка за
  1–3 минуты вместо круга шагов. Риск: скрипт правки попадёт в сайт. Лечится тем, что он живёт только в ответе
  сервера в режиме правки, а `check.py` можно научить ловить его маркер.
- **Вердикт: TAKE CODE.** `inspector-script.js` (MIT, © StackBlitz и контрибьюторы bolt.diy), куски `overlay.ts` и
  `buildApplyCommentUserPrompt` (MIT, © OpenCoworkAI), `utils.ts` (MIT, © Abi Raja). Атрибуция в
  `app/NOTICE.md`. Из Dyad брать только приём `injectHTML` (Apache-2.0, сохранить NOTICE).

### 2. Быстрая проверка правки: «до/после» с маской

- **Что даёт владельцу.** После «крупнее» он сразу видит результат, а система сама убеждается, что вне выбранного
  блока ничего не сломалось. Не нужно ждать полный гейт и судью ради одной правки.
- **У кого есть.** pixelmatch, ISC (`ab76f52`): `index.js` (605 строк), порог в OKLab, отсев сглаживания
  (`antialiased`), маска игнорирования (`ignoreMask`, стр. 83). Им пользуются Playwright (`toHaveScreenshot`,
  [docs](https://playwright.dev/docs/test-snapshots)) и Lost Pixel (`package.json:72-73`). Lost Pixel, MIT:
  маски, порог и повторы при дрожании (`src/config.ts:28,38,62,361`). BackstopJS, MIT: `hideSelectors`,
  `removeSelectors`, `readySelector`, `misMatchThreshold` (`README.md:178-193`). [V]
- **Есть ли у нас.** Нет. Гейт снимает контакт-листы, но не сравнивает «до» и «после» (`design-pipeline/tools/`
  без попиксельного сравнения). Зато есть то, чего нет у них: `Motion.seek(t)` и `?t=` замораживают движение
  (`playbooks/site/motion/README.md`, «Режимы»), кадры детерминированы.
- **План переноса.** **дирижёр** (Python-инструмент в `playbooks/site/harness/`, рядом с `check.py`):
  `edit_check.py --before a.png --after b.png --mask x,y,w,h`. numpy и Pillow уже стоят в venv
  (`STATUS-design.md`, раздел 2). Формула цветовой разницы и отсев сглаживания — порт из `pixelmatch/index.js`.
  Снимки — Playwright с `?t=1` на ширине, где кликнули. Затем `slop_lint` и `text_diff`. Итог владельцу:
  одна картинка «было / стало».
- **Усилие.** Оценка: 1 день.
- **Ценность и риск.** Высокая в паре с пунктом 1. Риск: правка законно сдвигает соседей (блок стал выше). Тогда
  считать сдвиг по вертикали и сравнивать ниже со смещением, а не валить.
- **Вердикт: TAKE CODE** (логика pixelmatch, ISC, © Mapbox; сохранить текст ISC в шапке файла). Можно и пакет
  PyPI `pixelmatch` 0.4.0 (ISC), но он на чистом Python и медленный на полной высоте страницы [V, PyPI].

### 3. Бренд по адресу сайта владельца

- **Что даёт владельцу.** Он вставляет адрес своего сайта или кабинета. Через 10–20 секунд видит свои цвета,
  шрифты и кнопки уже в листе направлений. Шаги 0a–2 короче, вкус идёт из его бренда, а не из памяти модели
  (главный вывод E8d в `DIARY.md`).
- **У кого есть.**
  - dembrandt, MIT, v0.39.2 (`90e2691`). Playwright открывает страницу и читает вычисленные стили
    (`README.md`, «What you get»). Цвета с ролями и уверенностью (`lib/extractors/colors.ts`, 1098 строк),
    типографика с адресами файлов шрифтов (`lib/extractors/typography.ts:141` `filterFontUrls`), радиусы, тени,
    **движение: длительности и кривые** (`lib/extractors/index.ts:815-905`), контраст WCAG (`--wcag`). Выгрузка в
    DTCG, DESIGN.md, Tailwind, shadcn. Проверяет robots.txt (`lib/robots.ts`). Зависимости: `playwright-core`
    1.64.0, по желанию `onnxruntime-node` (`package.json`). Может подключиться к уже запущенному Chromium по
    `BROWSER_CDP_ENDPOINT` (`index.ts:71`). [V]
  - OpenDesign, Apache-2.0 (`9724c44`): `clipper/brand-capture.js` (1803 строки, один файл для вставки в
    страницу). Нужные функции: `collectPalette` (стр. 313), `deriveBrandColors` (425), `collectFontFaces` (524),
    `collectTypography` (552), `collectComponents` (796), `deriveAtoms` (837). Методика:
    `skills/brand-extract/SKILL.md` («Every value you emit must trace to something you measured»). [V]
- **Есть ли у нас.** Частично. Скриншоты и мудборды — `palette.py` (k-means в Lab по чистым пикселям,
  `design-pipeline/tools/README.md`, раздел palette.py). Токены в CSS бренда с правкой контраста — `moves.py
  candidates` (`STATUS-design.md`, этап 3). С адреса сайта шаг 2 велит агенту снимать стили руками
  (`PIPELINE.md`, шаг 2: «getComputedStyle(document.documentElement)»).
- **План переноса.** **дирижёр:** `playbooks/site/harness/brand_probe.py --url <адрес> --out design/<p>/`.
  Python Playwright (тот же Edge, `DP_BROWSER_CHANNEL`), `page.evaluate` с функциями `collect*` из
  `brand-capture.js`. На выходе `brand-probe.json`, черновик токенов для `02-brand.md`,
  `motion/brands/<slug>.css` через уже готовый код `moves.py`, файлы шрифтов в `fonts/` и сразу `font_check.py`
  на кириллицу. Модель не нужна. **design:** поле «Адрес вашего сайта» в карточке шага 0. dembrandt держать как
  второй путь (через node из бандла), если нужен DESIGN.md или DTCG.
- **Усилие.** Оценка: 1–2 дня.
- **Ценность и риск.** Высокая для владельцев с сайтом или кабинетом. Риск: сайт за антибот-стеной или пустой.
  Тогда остаётся `palette.py` по скриншотам. Шрифты со скриншота не определит никто из аналогов: dembrandt и
  OpenDesign читают только живую страницу.
- **Вердикт: TAKE CODE** (функции из `brand-capture.js`, Apache-2.0: сохранить заголовок лицензии и пометку об
  изменениях; или dembrandt целиком, MIT).

### 4. Текст правится сам, без модели

- **Что даёт владельцу.** «Поменять текст» = кликнул, набрал, Enter. Ноль ожидания, ноль вызовов модели.
- **У кого есть.**
  - Dyad: `worker/dyad-visual-editor-client.js:144-220` — `contentEditable`, `input` → `postMessage` с новым
    текстом, финал при выходе (Apache-2.0, этот файл вне `src/pro/`). Запись обратно в исходник у Dyad — в
    `src/pro/main/ipc/handlers/visual_editing_handlers.ts`, это FSL, не брать. [V]
  - Open CoDesign: `SOURCE_EDITING.md` — правила «детерминированной» правки исходника без LLM: пишем, только если
    место однозначно, иначе отказ с причиной; не ищем «первую похожую строку» по файлу. [V]
- **Есть ли у нас.** Нет.
- **План переноса.** **design:** в `edit-overlay.js` режим текста (как у Dyad). Main знает точное место текстового
  узла по позициям parse5 из пункта 1. Пишет, только если узел — чистый текст без вложенных тегов, и строка в
  исходнике совпадает. Иначе — отказ и обычная правка через агента. **дирижёр:** после записи — `text_diff.py` и
  `slop_lint.py`; новая фраза дописывается в источник текста владельца, чтобы `text_diff` не падал.
- **Усилие.** Оценка: 1 день поверх пункта 1.
- **Ценность и риск.** Высокая: правки текста — самые частые. Риск: число, которое `motion.js` перерисовывает
  (одометр, «число с торможением»). Такие узлы помечены `data-move` — для них отказ.
- **Вердикт: ADAPT IDEA** (кусок Dyad можно взять кодом, Apache-2.0; запись в исходник пишем свою).

### 5. Выкладка в РФ: Yandex Object Storage и FTP

- **Что даёт владельцу.** Шаг 8 перестаёт быть вопросом. «Выложить» → адрес, который открывается в России без VPN.
- **У кого есть.** Готовые деплоеры у аналогов только зарубежные: bolt.diy `app/routes/api.netlify-deploy.ts`
  (276 строк, MIT, API с хэшами файлов), `api.vercel-deploy.ts`; OpenDesign `apps/daemon/src/deploy.ts`
  (Vercel и Cloudflare Pages, Apache-2.0). Для РФ готового кода нет. [V]
- **Есть ли у нас.** Нет. Шаг 8 спрашивает и пишет общий рецепт отката (`stages.json`, шаг 8). Есть «Скачать
  архив» (`app/apps/desktop/src/main/design/zip.ts`).
- **План переноса.**
  - **core:** хранение ключей хостинга в том же `keyStore`, что и ключ PRSLOY (`STATUS-design.md`, раздел 1).
  - **design:** мастер «Куда выложить» с тремя вариантами: «Яндекс Облако (нужен аккаунт и карта)», «Бесплатный
    хостинг Beget (нужны ФИО, почта, телефон)», «Свой сервер (как сейчас)». Загрузка в main.
  - Yandex: S3 API с подписью SigV4, регион `ru-central1`, адрес `https://storage.yandexcloud.net`
    ([docs](https://yandex.cloud/ru/docs/storage/s3/signing-requests)). Подпись — ~100 строк на `node:crypto`.
    Брать AWS SDK не нужно (botocore — 16 МБ, PyPI). Тот же код подойдёт для Selectel и Timeweb S3.
  - Beget и другие обычные хостинги: FTP. В Python — `ftplib.FTP_TLS` из стандартной библиотеки.
  - **дирижёр:** шаг 8 в `stages.json` предлагает эти варианты, рецепт отката пишет по выбранному.
- **Усилие.** Оценка: 2–3 дня.
- **Ценность и риск.** Высокая: закрывает последний шаг. Риск: аккаунт в Яндекс Облаке для казуала тяжёл
  (Яндекс ID, организация, платёжный аккаунт; у физлиц нет пробного периода, но есть грант на 60 дней,
  [billing quickstart](https://yandex.cloud/ru/docs/billing/quickstart/)). Поэтому Beget — первым для тех, у кого
  нет карты. Подробности и источники — в разделе «Вопрос 5».
- **Вердикт: ADAPT IDEA** (свой код; Netlify из bolt.diy — только как справка, MIT).

### 6. Ползунки токенов без модели

- **Что даёт владельцу.** Рядом с превью 3–5 ручек: акцентный цвет (из его палитры), «крупнее/мельче» для
  шрифтов, «плотнее/свободнее». Двигает — страница меняется сразу. «Сохранить» — и всё, без хода агента.
- **У кого есть.** Open CoDesign, MIT. Протокол `EDITMODE`: агент объявляет плоский JSON решений между метками
  `/*EDITMODE-BEGIN*/…/*EDITMODE-END*/`, среда превращает ключи в CSS-переменные `--ocd-tweak-*`
  (`packages/core/src/prompts/sections/editmode-protocol.md`). Живое обновление через `postMessage`
  (`packages/runtime/src/tweaks-bridge.ts`, 204 строки), запись обратно в исходник
  (`apps/desktop/src/renderer/src/preview/tweak-persistence.ts`, 195 строк), инструмент агента
  `packages/core/src/tools/tweaks.ts`. [V]
- **Есть ли у нас.** Половина. Все токены бренда уже лежат CSS-переменными на `:root`
  (`playbooks/site/motion/brands/prsloy.css`: `--paper`, `--ink`, `--accent`, `--m-ease`, `--radius`…).
  Нет интерфейса и записи.
- **План переноса.** **design + ui:** панель «Настроить» читает `:root` из CSS бренда сайта, рисует ручки
  (цвет — только из `palette-*.json`, размеры — в безопасных пределах). Живое обновление:
  `document.documentElement.style.setProperty` через тот же `edit-overlay.js`. «Сохранить» переписывает блок
  `:root` в файле бренда. **дирижёр:** в задание шага 6 строка «размеры и отступы через переменные шкалы»
  (`--step`, `--space`), иначе ручкам нечего двигать.
- **Усилие.** Оценка: 2 дня.
- **Ценность и риск.** Средняя-высокая. Риск: ручка выводит из контраста. Лечится тем же расчётом контраста, что
  уже есть в `moves.py` (7:1 и 3:1).
- **Вердикт: ADAPT IDEA** (протокол и мост читать у Open CoDesign; наш код короче, потому что у нас статический
  HTML, а не React).

### 7. Кодом: «только цвета бренда» и CSS-слоп

- **Что даёт владельцу.** Меньше раундов судьи. Самые частые находки («чужой цвет», фиолетовый градиент,
  эмодзи-иконки) ловятся за секунду до показа.
- **У кого есть.**
  - dembrandt `lib/drift.ts` (965 строк, MIT): сравнение двух выгрузок, ΔE в Lab, `DEFAULT_DRIFT_CONFIG`
    (`colorSame: 2.3`, `colorShift: 15`, `failThreshold: 10`). [V]
  - OpenDesign `apps/daemon/src/lint-artifact.ts` (1000 строк, Apache-2.0): правила `purple-gradient`,
    `ai-default-indigo`, `emoji-icon`, `raw-hex`, `sans-display`, `all-caps-no-tracking`, `left-accent-card`,
    `invented-metric`, `filler-copy`, `trust-gradient`, `accent-overuse` и др.; 11 правил уровня P0. Находка
    уходит агенту системным сообщением. [V]
- **Есть ли у нас.** Текстовый слоп по-русски — да (`slop_lint.py`). Растровые картинки и `data-signature` — да
  (`check.py`). Цвета на странице против `02-brand.md` — нет. CSS-слоп — нет (в `research/13` предложен
  Impeccable `detect`, не подключён).
- **План переноса.** **дирижёр:** в `check.py` (или отдельный `brand_check.py`) — Playwright проходит видимые
  элементы, берёт `color`, `background-color`, `border-color`, считает ΔE до ближайшего токена бренда
  (Lab-перевод уже есть в `palette.py`). ΔE > 6 на заметной площади → провал с селектором. Плюс 5–6 правил
  `lint-artifact.ts` регулярками по CSS. **PR в пайплайн** (решает дирижёр): то же в `gate.py`.
- **Усилие.** Оценка: 1 день.
- **Ценность и риск.** Средняя. Риск: оттенки из смесей (`mid`, `line`) и картинки владельца. Брать все цвета из
  `02-brand.md`, включая смеси, а `<img>` и `<svg>` логотипа пропускать.
- **Вердикт: ADAPT IDEA** (пороги dembrandt, MIT; список правил OpenDesign, Apache-2.0 — переписываем на Python).

### 8. Типизированный вопрос владельцу (`ask`) вместо разбора текста

- **Что даёт владельцу.** Ответ кнопкой всегда засчитан. Нет переспросов «буквами», «как рекомендуешь» закрывает
  выбор.
- **У кого есть.** Open CoDesign, MIT: `packages/core/src/tools/ask.ts` (348 строк) — инструмент Pi с пятью типами:
  `text-options`, `svg-options`, `slider`, `file`, `freeform` (стр. 16-57). Ход агента заканчивается, ответ
  возвращается результатом инструмента (`answered` / `cancelled`, стр. 86). [V]
- **Есть ли у нас.** Нет. Агент пишет текст, `run.py` вытаскивает варианты регулярками (`run.py:493-553`,
  `inline_options`, `options_of`), второе мнение проверяет формат. Сбои — в `DIARY.md` (E8b, E8q, E9 баг 3).
- **План переноса.** **harness:** расширение Pi с инструментом `ask_owner` (схема — с `ask.ts`; у нас тот же Pi).
  Результат пишется в `owner/messages.jsonl` в том же виде, что сейчас. **дирижёр:** `run.py` берёт вопрос из
  вызова инструмента, а не из текста; старый разбор оставить запасным. **design:** карточка уже умеет группы
  кнопок (`STATUS-design.md`, раздел 3).
- **Усилие.** Оценка: 2 дня.
- **Ценность и риск.** Средняя-высокая: убирает целый класс сбоев. Риск: `flow.py` сверяет цитаты владельца с
  перепиской. Формат записи в `messages.jsonl` менять нельзя.
- **Вердикт: TAKE CODE** (схема вопросов из `ask.ts`, MIT, © OpenCoworkAI).

### 9. Судья: 12 вопросов «да/нет» и предел раундов

- **Что даёт владельцу.** Шаг 7 короче. Судья не находит «ещё больше» на каждом круге.
- **У кого есть.** Open CoDesign, MIT: `BENCHMARKS.md` и `packages/core/src/tools/verify-ui-kit-visual-parity.ts`
  (375 строк). Судья отвечает на 12 фиксированных вопросов «да/нет» с причиной в одно предложение; балл =
  доля «да»; статус по порогам (12/12, ≥ 11, ≥ 8); не больше 2 итераций. Довод из файла: «yes/no is harder to fudge
  than a number; same input, similar checks across runs». [V]
- **Есть ли у нас.** Судья есть (`playbooks/site/harness/judge.py`, Opus, `max_rounds: 3` в `stages.json`), но
  находки открытые. В E9 их число росло 2 → 7 → 14 (`DIARY.md`).
- **План переноса.** **дирижёр:** в `judge.py` после свободного разбора — обязательный блок из 10–12 булевых
  вопросов по нашим осям (смысл, дубли, элементы без функции, бренд, читаемость на 390, CTA видна сразу).
  Раунд 2 перепроверяет только «нет» из раунда 1, новых находок не добавляет. Формат `JUDGE.md` — согласовать с
  пайплайном (PR, решает дирижёр).
- **Усилие.** Оценка: 1 день.
- **Ценность и риск.** Высокая по времени (шаг 7 — самый долгий). Риск: судья станет мягче. Держать список вопросов
  из реальных находок E8–E9.
- **Вердикт: ADAPT IDEA** (рубрику читать у Open CoDesign).

### 10. Красные пометки на картинке

- **Что даёт владельцу.** На листе вариантов или на снимке страницы он обводит место красным и пишет пару слов.
  Это проще, чем объяснять.
- **У кого есть.** tldraw make-real: системное правило «Red = Annotation: Exclude all red-colored elements from
  final design» (`prompts/anthropic-system-prompt.md`, раздел Interpretation Rules). Сам холст tldraw не брать
  (см. «Что не брать»). [V]
- **Есть ли у нас.** Нет. Картинки в карточке открываются в просмотрщике (`DesignPage.tsx`,
  `ImagePreviewDialog`).
- **План переноса.** **ui:** в просмотрщике картинки — кисть (обычный `<canvas>` поверх, один цвет). Результат —
  PNG, прикладывается к ответу как файл (механизм вложений уже есть). **дирижёр:** одна строка в задание: «красное
  на картинке — пометки владельца, не дизайн».
- **Усилие.** Оценка: 0,5–1 день.
- **Ценность и риск.** Средняя. Риск: дешёвая модель плохо видит картинки. Такие правки отдавать модели со зрением
  (в E8p Kimi K3.1 Pro «картинки видит лучше Qwen»).
- **Вердикт: ADAPT IDEA.**

---

## Пять вопросов заказчика

### Вопрос 1. Правка кликом по живому превью

**Как это делают другие.**

| Кто | Как элемент связан с исходником | Как правка уходит агенту | Подходит статике? |
|---|---|---|---|
| Onlook (Apache-2.0, `423e2e9`) | Babel вписывает `data-oid` прямо в JSX-файлы (`packages/parser/src/ids.ts`). Скрипт в iframe отдаёт элемент по точке (`apps/web/preload/script/api/elements/helpers.ts`, `elementFromPoint` с обходом shadow DOM) | Контекст «Code Selection»: путь `файл#Lстрока:Lстрока` и фрагмент (`packages/ai/src/contexts/classes/highlight.ts`). Стили и текст правит сам, без модели, через Babel (`packages/parser/src/code-edit/style.ts`, `text.ts`) | Нет: только React/Next. Сейчас «early access» по листу ожидания (`README.md`) |
| Dyad (Apache-2.0 / FSL, `1be2b4b`) | Плагин сборки вешает `data-dyad-id="файл:строка:колонка"`; он в `src/pro/ui/*-component-tagger` (FSL) | Прокси вставляет скрипт в HTML (`worker/proxy_server.js:248`). Задание: файл, строка, фрагмент с `// <-- EDIT HERE` (`chat_stream_handlers.ts:1735-1775`) | Приём `injectHTML` и подъём к предку — да |
| bolt.diy (MIT, `353b44c`) | Не связывает: отдаёт селектор, путь, вычисленные стили | Элемент кладётся в сообщение JSON-ом, плюс список живых правок стилей (`Chat.client.tsx:943-953`) | Да, скрипт не зависит от фреймворка |
| screenshot-to-code (MIT, `a813977`) | Не связывает: `outerHTML` как «локатор», путь из 6 предков, «номер N из M» | Правило «найди код по тегу, классам, тексту, правь только его» (`system_prompt.py:91-95`) | Да, это именно один HTML-файл |
| Open CoDesign (MIT, `4cf3393`) | XPath + `outerHTML` + родитель; для JSX — метки источника и привязка текстовых узлов (`source-edit-instrumentation.ts`) | `buildApplyCommentUserPrompt` (`packages/core/src/index.ts:378`); булавки копятся и уходят одним ходом | Да |
| react-grab (MIT) | React fiber, стек компонентов | Строка «элемент в Компонент (at файл:строка:колонка)» в буфер обмена (`README.md`) | Только короткий фрагмент (`html-preview.ts`) |
| click-to-component, LocatorJS, code-inspector (MIT) | `_debugSource` React или плагин сборщика | Открыть файл в редакторе | Нет: нужен сборщик или React |
| VisBug (Apache-2.0) | Не связывает; инструменты дизайнера поверх любой страницы (`app/features/metatip.js`, `selectable.js`) | Нет агента | Только идеи интерфейса |
| Agentation | Тулбар для React 18+, MCP | См. `research/13-design-pipeline.md:80-107` | Лицензия PolyForm Shield — не брать |

**Ответ для нас.** Да, маленький вставляемый скрипт справится, и у нас проще, чем у Onlook и Dyad. Им нужен
сборщик, чтобы связать DOM с JSX. У нас сайт — статический HTML: файл на диске и есть то, что отдаёт сервер превью.
Позиции тегов даёт parse5 в момент отдачи. Узлы, которые создаёт `motion.js`, меток не имеют — скрипт поднимается к
ближайшему размеченному предку. План и файлы — пункты 1, 2, 4 топа.

### Вопрос 2. Бренд из материалов владельца в CSS-токены

| Вход | Чем | Есть у нас | Что взять |
|---|---|---|---|
| Адрес сайта или кабинета | dembrandt (MIT), `brand-capture.js` OpenDesign (Apache-2.0) | Нет (агент руками) | Пункт 3 топа |
| Скриншот, мудборд, логотип | `palette.py` (Lab k-means, чистые пиксели) | Да | Ничего. node-vibrant (MIT, медианный срез MMCQ, `packages/vibrant-quantizer-mmcq`) и colorthief (MIT, npm) грубее |
| Шрифт со скриншота | Открытого инструмента не нашли. Open CoDesign делает токены из картинки моделью со зрением (`packages/core/src/tools/decompose-to-ui-kit.ts`) | Нет | Шаг для модели со зрением: «категория шрифта» → подбор из нашего списка кириллических шрифтов (идея из `research/13`, TL;DR 7) |
| Готовые токены → файлы | dembrandt `--dtcg`, `--design-md`, `--tailwind` | `moves.py` пишет `motion/brands/<slug>.css` | Брать формат DTCG, только если понадобится обмен с Penpot или Figma. Сейчас не нужно |
| Кривые движения бренда | dembrandt: `extractMotionStatic`, `extractMotion` (`lib/extractors/index.ts:815-905`) | Нет | В `brand_probe.py`: кривая сайта → `--m-ease`. В E8q приём взял кривую `--anatomy-ease` из кабинета, это сработало (`DIARY.md`) |

Отказаться: brand-extract у open-lovable — это платный внешний API Firecrawl (`app/api/extract-brand-styles/route.ts`,
`formats: ['branding']`, ключ обязателен по `README.md`).

### Вопрос 3. Быстрый первый черновик

**Что умеют открытые генераторы.**

| Кто | Что делает | Скорость | Годится нам |
|---|---|---|---|
| screenshot-to-code (MIT) | Скриншот, текст или видео → один HTML. 4 варианта параллельно, модели по кругу (`backend/config.py:3`, `routes/generate_code.py:455-500`). Правило «create_file один раз, дальше edit_file заменами» и самопроверка снимком на телефоне и ПК (`system_prompt.py`, Tooling instructions; `preview_screenshot/playwright_backend.py`) | Минуты [U: замеров в репо нет] | Приёмы — да |
| Open CoDesign (MIT) | Промпт → HTML/JSX на Pi; DESIGN.md; инструмент `preview` для самопроверки (`packages/core/src/tools/preview.ts`, до 16 шагов на вызов) | Картинка → набор UI: 56–366 с, $0.045–1.32 (`BENCHMARKS.md`) | Приёмы — да |
| OpenDesign (Apache-2.0) | 171 скилл, 116 шаблонов, 154 «дизайн-системы» брендов (`skills/`, `design-templates/`, `design-systems/`) | — | Шаблоны — нет (вид шаблона, бренды чужие) |
| make-real (tldraw) | Набросок → одностраничник на Tailwind, картинки с placehold.co, скрипты только с cdnjs (`prompts/anthropic-system-prompt.md:14-19`) | Минуты | Только «красное = пометки» |
| llamacoder (MIT) | Одно приложение на React по промпту, превью через esbuild-wasm (`README.md`, `architecture.md`) | Минуты | Нет: React-приложения, не лендинги |
| bolt.diy, open-lovable, fragments | Полные конструкторы приложений в WebContainer или облачной песочнице (Vercel, E2B) | Минуты | Нет: другая парадигма, облако |

**Вывод.** Первая страница за минуты — это уровень шаблона. Наш замер: шаги 0–5 в E8d заняли ≈45 минут, сборка —
9 минут, а судья — 2–3 часа (`DIARY.md`). Черновик не главное узкое место. Что брать:
- **Параллельные прототипы одним вызовом** на шаге 5. Сейчас это одна сессия до 40 минут и 90 вызовов
  (`stages.json`, шаг 5). Вместо неё — 2–3 одноразовых вызова «создай `index.html` целиком» на разных моделях
  лестницы, параллельно, с блоком дизайн-системы (как `prompts/design_system.py` у screenshot-to-code: «если
  конфликт — побеждает дизайн-система»), затем обычный `compare_sheet.py`. Полоса — **дирижёр**. Риск для качества:
  проверить A/B-стендом (`simulate.py`, `abreport.py`) до включения.
- **«Создать один раз, дальше только замены»** — уже так у Pi (инструмент edit). Повторить в задании шага 6.
- **Булев судья** — пункт 9 топа.

### Вопрос 4. Визуальная регрессия и доступность: что взять вместо своих скриптов

| Инструмент | Лицензия | Что даёт | Решение |
|---|---|---|---|
| axe-core | MPL-2.0 (`LICENSE`) | Доступность | Уже есть: `design-pipeline/tools/vendor/axe.min.js` + лицензия рядом. Оставить |
| pixelmatch | ISC (`LICENSE`) | Попиксельная разница, сглаживание, маска | Взять логику в `edit_check.py` (пункт 2) |
| Playwright `toHaveScreenshot` | Apache-2.0 | Снимки-эталоны на pixelmatch ([docs](https://playwright.dev/docs/test-snapshots)) | Нет: только в JS-раннере. В Python-API такого утверждения нет ([docs](https://playwright.dev/python/docs/test-assertions)) |
| BackstopJS | MIT (`LICENSE`) | Сценарии, `hideSelectors`, `misMatchThreshold`, отчёт | Не брать фреймворк (Node). Взять идеи порога и скрытия |
| Lost Pixel | MIT (`LICENSE`) | Маски, порог, повторы, odiff + pixelmatch | Не брать (Node, Docker-режим). Идея повторов при дрожании |
| reg-suit | MIT (`LICENSE.txt`) | Сравнение и публикация отчётов в CI | Не нужно: у нас один сайт, не CI |
| odiff | MIT (`LICENSE.txt`) | Быстрое сравнение нативным бинарником | Не нужно: страница одна, numpy хватит |
| pa11y | LGPL-3.0 (`LICENSE`) | Обёртка над axe и HTML_CodeSniffer | Не брать: дублирует axe, лицензия слабый копилефт |
| Lighthouse | Apache-2.0 (npm `lighthouse` 13.5.0) | Скорость, SEO, мета-теги | Не тащить целиком (Node, тяжёлый). Перед «выложить» — 30 строк на Python: `<title>`, `meta description`, `lang="ru"`, `og:image`, `favicon`, `viewport` |
| dembrandt drift | MIT | Сравнение токенов с эталоном | Идея для «только цвета бренда» (пункт 7) |
| OpenDesign `lint-artifact.ts` | Apache-2.0 | CSS-слоп правилами | Правила переписать на Python (пункт 7) |

### Вопрос 5. Выкладка статики из России без VPN

Замерить из РФ отсюда нельзя (прокси в США). Ниже — источники и наши выводы.

| Где | Нужен ли аккаунт | Доступность из РФ | Вердикт |
|---|---|---|---|
| **Yandex Object Storage** | Яндекс ID → организация → платёжный аккаунт «Физическое лицо»; у физлиц нет пробного периода, есть грант на 60 дней ([billing](https://yandex.cloud/ru/docs/billing/quickstart/), [free-trial](https://yandex.cloud/ru/docs/free-trial/)) | Домашняя инфраструктура [U: вывод]. Адрес `https://<бакет>.website.yandexcloud.net` ([hosting](https://yandex.cloud/ru/docs/storage/concepts/hosting)). Бесплатно в месяц: 1 ГБ, 100 ГБ исходящего трафика, 100 000 GET ([pricing](https://yandex.cloud/ru/docs/storage/pricing)) | **Брать** (пункт 5) |
| **Beget, бесплатный хостинг** | ФИО, почта, телефон ([beget.com/ru/hosting/free](https://beget.com/ru/hosting/free)) | Российский хостинг [U: вывод]. 1 ГБ, 1 сайт, 1 FTP, поддержки нет; про SSL на бесплатном тарифе страница молчит [U] | **Брать** как путь без карты, по FTP |
| Timeweb Cloud S3 | Аккаунт, платно | Российский. Адрес `*.website.twcstorage.ru` — только по блогу пользователя ([teletype](https://teletype.in/@beaverclan/blogontimewebs3)) [U] | Можно тем же кодом S3 |
| Selectel S3 | Аккаунт, платно | Российский. Публичный контейнер под сайт — статья в блоге Selectel ([habr](https://habr.com/ru/articles/822895)) [U] | Можно тем же кодом S3 |
| Свой сервер | Доступ к серверу | Как у сервера | Уже есть рецепт шага 8 в пайплайне |
| GitHub Pages | Аккаунт GitHub | `github.io` на адресах 185.199.108–111.153 (наш `getent`). В мае 2026 у `github.com` аномалий по OONI до 10–16%, РКН ограничения отрицает ([Meduza](https://meduza.io/news/2026/05/08/github-stal-ploho-otkryvatsya-v-rossii-roskomnadzor-utverzhdaet-chto-ne-blokiruet-ego), [kod.ru](https://kod.ru/is-github-blocked-in-russia)). По `github.io` замеров не нашли [U]. Правила: «not intended for… free web-hosting service to run your online business» ([limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)) | Запасной путь, не по умолчанию |
| Netlify | Аккаунт; Netlify Drop без аккаунта, но сайт истекает, если не забрать ([blog](https://www.netlify.com/blog/thirteen-years-of-netlify-drop)) | Блокировки по IP бывали ([answers.netlify.com/t/372](https://answers.netlify.com/t/netlify-cdn-or-dns-blocked-in-russia/372), [/21036](https://answers.netlify.com/t/update-on-availability-from-russia/21036), [/121260](https://answers.netlify.com/t/seems-like-my-website-is-blocked-in-russia-by-mistake/121260)); свежих данных нет [U] | Запасной путь |
| Cloudflare Pages | Аккаунт | С 9 июня 2025 Ростелеком, МегаФон, Вымпелком, МТС, МГТС режут сайты за Cloudflare до первых 16 КБ ([Cloudflare blog](https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/), [Медиазона](https://zona.media/news/2025/06/27/cf-confirmed)) | **Не брать** |
| Vercel | Аккаунт; Hobby — «non-commercial personal use only» ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)) | Свои домены на IP Vercel недоступны у части провайдеров РФ, жалобы с 2024-10 по 2026-05 ([1](https://community.vercel.com/t/urgent-production-domain-bbqp-pro-is-blocked-in-russia-confirmed-vercel-ip-issue/29141), [2](https://community.vercel.com/t/custom-domain-unreachable-from-some-russian-isps-while-vercel-app-works/48756)) | **Не брать** |
| Surge | Почта и пароль в CLI (npm `surge` 0.47.0, ISC) | `surge.sh` → 159.203.50.177, это сеть DigitalOcean (наш `getent`). DigitalOcean в числе зарубежных хостингов под ограничением ([3DNews](https://3dnews.ru/1125069)) [U: вывод] | **Не брать** |

**Порядок в мастере шага 8:** «Beget бесплатно» (нет карты) → «Яндекс Облако» (есть карта, нужен надёжный
адрес) → «Свой сервер» → «Пока папкой» (как сейчас). Перед загрузкой — проверка мета-тегов (вопрос 4) и
вопрос владельцу «выкладываю?», как требует пайплайн.

---

## Полная таблица всего, что смотрели

| Проект | Что это | Лицензия (файл) | Полезное для нас | Есть у нас? | Вердикт |
|---|---|---|---|---|---|
| Open CoDesign `OpenCoworkAI/open-codesign` (`4cf3393`) | Electron + Pi, «Claude Design» локально | MIT (`LICENSE`) | Оверлей выбора, булавки, `EDITMODE`-ручки, правка исходника без LLM, `ask`, булев судья | Нет | **TAKE CODE** (пп. 1, 6, 8, 9) |
| bolt.diy `stackblitz-labs/bolt.diy` (`353b44c`) | Конструктор приложений в WebContainer | MIT (`LICENSE`) | `public/inspector-script.js`; деплой Netlify и Vercel | Нет | **TAKE CODE** (скрипт выбора) |
| screenshot-to-code `abi/screenshot-to-code` (`a813977`) | Скриншот/видео/текст → HTML | MIT (`LICENSE`) | Локатор выбранного элемента, правило точечной правки, 4 варианта параллельно, самопроверка снимком | Нет | **TAKE CODE** (`utils.ts`), ADAPT (варианты) |
| Dyad `dyad-sh/dyad` (`1be2b4b`) | Electron-конструктор приложений | Apache-2.0, кроме `src/pro/` — FSL-1.1-ALv2 (`LICENSE`, `src/pro/LICENSE`) | `injectHTML`, клиент выбора, фрагмент «EDIT HERE», текст через `contentEditable` | Нет | **TAKE CODE** вне `src/pro/`; `src/pro/` — SKIP |
| Onlook `onlook-dev/onlook` (`423e2e9`) | Визуальный редактор React/Next с ИИ | Apache-2.0 (`LICENSE.md`) | Схема `data-oid`, контекст «Code Selection», правки через Babel | Нет | ADAPT IDEA (статике не нужен Babel) |
| dembrandt `dembrandt/dembrandt` (`90e2691`) | CLI: токены бренда с живого сайта | MIT (`LICENSE`) | Цвета, шрифты, движение, WCAG, drift | Частично (`palette.py`) | **TAKE CODE** (п. 3) / ADAPT (п. 7) |
| OpenDesign `nexu-io/open-design` (`9724c44`) | Рабочее место дизайн-агента | Apache-2.0 (`LICENSE`) | `brand-capture.js`, `lint-artifact.ts`, `brand-extract` | Нет | **TAKE CODE** (функции бренда), ADAPT (линтер); шаблоны и бренд-системы — SKIP |
| react-grab `aidenybai/react-grab` (`ea4bbec`) | Скопировать элемент для агента | MIT (`LICENSE`) | `html-preview.ts`, `create-element-selector.ts` | Нет | TAKE CODE (мелкие утилиты) |
| VisBug `GoogleChromeLabs/ProjectVisBug` (`fef96fa`) | Инструменты дизайнера поверх страницы | Apache-2.0 (`LICENSE`) | Подсказка стилей при наведении (`metatip.js`) | Нет | ADAPT IDEA |
| stagewise `stagewise-io/stagewise` (`43c6b25`) | Тулбар выбора элемента, теперь свой браузер | AGPL-3.0 (`LICENSE`) | — | — | SKIP (AGPL) |
| click-to-component (`f8be09c`), LocatorJS (`ac4ed50`), code-inspector (`6235e8a`) | Клик → файл в редакторе | MIT (`LICENSE`; LocatorJS — `apps/extension/LICENSE` и `package.json` пакетов) | — | — | SKIP (нужен React или сборщик) |
| tldraw `tldraw/tldraw` (`12921f6`) | SDK холста | tldraw license (`LICENSE.md`): «Not to use the Software in Production Environments» без ключа | — | — | SKIP |
| make-real `tldraw/make-real` (`928c4c4`) | Набросок → HTML | `package.json`: MIT, файла LICENSE нет; зависит от `tldraw ^4.4.0` | Правило «красное = пометки» | Нет | ADAPT IDEA (п. 10) |
| make-real-starter `tldraw/make-real-starter` (`81baa9b`) | Стартер make-real | AGPL-3.0 (`LICENSE`) + tldraw | — | — | SKIP |
| Penpot `penpot/penpot` (`74add05`), `penpot-mcp` (`73e0cd2`), `penpot-plugins` (`ed371b0`) | Открытый Figma, MCP, плагины | MPL-2.0 (`LICENSE`) | MCP перенесён в основной репо, `penpot-mcp` в архиве с 2026-02-03 (`penpot-mcp/README.md`); `@penpot/library` собирает `.penpot` (`library/README.md`) | — | SKIP (нужен сервер Penpot; казуалу не нужен редактор) |
| GrapesJS `GrapesJS/grapesjs` (`f47fbde`) | Блочный редактор страниц | BSD-3-Clause (`LICENSE`, `packages/core/package.json:6`) | ИИ — в коммерческом Studio SDK [U, поиск] | — | SKIP |
| Webstudio `webstudio-is/webstudio` (`74af992`) | Визуальный конструктор | AGPL-3.0-or-later (39 пакетов), один пакет проприетарный (`packages/sdk-components-animation/package.json:7`) | — | — | SKIP |
| Puck `puckeditor/puck` (`6a823ce`) | Визуальный редактор на React, страница = JSON блоков | MIT (`LICENSE`, `packages/core/package.json:65`) | Идея «страница из одобренных блоков»; Puck AI — облачный и платный ([blog](https://puckeditor.com/blog/puck-ai)) | Наши блоки — `motion.js` | SKIP (другая парадигма) |
| Mitosis `BuilderIO/mitosis` (`38bbdbc`) | Компилятор компонентов под фреймворки | MIT (`LICENSE`) | — | — | SKIP |
| micro-agent `BuilderIO/micro-agent` (`f33523c`, 2024-11) | Агент «до зелёных тестов» | MIT (`LICENSE`) | Визуальный тест = две картинки рядом в LLM (`src/helpers/visual-test.ts`) | У нас `compare_sheet.py` сильнее | SKIP |
| llamacoder `Nutlope/llamacoder` (`5d57b70`) | «Открытые Artifacts» | MIT (`LICENSE`) | — | — | SKIP |
| open-lovable `firecrawl/open-lovable` (`806b807`) | Клон сайта → React | MIT (`LICENSE`) | План поиска места правки (`app/api/analyze-edit-intent/route.ts`) | — | SKIP (нужны Firecrawl и облачная песочница) |
| openui `wandb/openui` (`42d7ab4`) | Описание → UI | Apache-2.0 (`LICENSE`) | — | — | SKIP |
| fragments `e2b-dev/fragments` (`3b11c7f`) | Генерация кода в песочнице E2B | Apache-2.0 (`LICENSE`) | — | — | SKIP |
| BackstopJS (`a11d365`), Lost Pixel (`f08221f`), reg-suit (`5c09c8e`), odiff (`6dd1e96`) | Визуальная регрессия | MIT | Идеи порогов, масок, повторов | Нет | ADAPT IDEA (п. 2) |
| pixelmatch `mapbox/pixelmatch` (`ab76f52`) | Попиксельное сравнение | ISC (`LICENSE`) | Формула, сглаживание, маска | Нет | **TAKE CODE** (п. 2) |
| axe-core `dequelabs/axe-core` (`6b52b84`) | Доступность | MPL-2.0 (`LICENSE`) | — | Да, вшит в гейт | Оставить |
| pa11y `pa11y/pa11y` (`aede96f`) | Обёртка проверок доступности | LGPL-3.0 (`LICENSE`) | — | axe есть | SKIP |
| node-vibrant `Vibrant-Colors/node-vibrant` (`ed86836`) | Палитра из картинки | MIT (`packages/*/package.json`) | — | `palette.py` лучше | SKIP |
| Agentation (по `research/13`) | Тулбар замечаний к элементам | PolyForm Shield (`research/13-design-pipeline.md:72,395`) | Идея | Нет | SKIP кода |

---

## Таблица лицензий

| Лицензия | Проекты | Можно брать код? | Что сделать при переносе |
|---|---|---|---|
| MIT | Open CoDesign, bolt.diy, screenshot-to-code, dembrandt, react-grab, Puck, Mitosis, micro-agent, llamacoder, open-lovable, BackstopJS, Lost Pixel, reg-suit, odiff, node-vibrant, click-to-component, LocatorJS, code-inspector; npm: parse5, `@medv/finder` | Да | Сохранить строку copyright и текст MIT в шапке файла или в `app/NOTICE.md` |
| ISC | pixelmatch; npm `surge` | Да | Сохранить copyright и текст ISC |
| Apache-2.0 | OpenDesign, Onlook, VisBug, openui, fragments, Dyad (вне `src/pro/`), Playwright, Lighthouse | Да | Копия лицензии, пометка «файл изменён», перенос NOTICE, если есть (у Dyad есть `NOTICE`) |
| BSD-3-Clause | GrapesJS | Да | Сохранить copyright; не использовать имя автора для продвижения |
| MPL-2.0 | Penpot, axe-core | Да, пофайлово | Изменённые файлы MPL остаются открытыми. axe-core уже лежит как отдельный файл с лицензией — так и держать |
| LGPL-3.0 | pa11y | Не брать | — |
| AGPL-3.0 | stagewise, Webstudio, make-real-starter | **Нет** | Сеть = распространение; несовместимо с закрытыми частями |
| FSL-1.1-ALv2 | Dyad `src/pro/` (тегеры компонентов, запись визуальных правок) | **Нет** (станет Apache-2.0 только через 2 года после выпуска версии, по условиям FSL) | — |
| PolyForm Shield | Agentation | **Нет** (запрет конкурирующего использования) | — |
| tldraw license | tldraw SDK, а значит make-real и стартеры на нём | **Нет** без коммерческого ключа; хобби-ключ — с водяным знаком и по усмотрению tldraw ([license key](https://tldraw.dev/sdk-features/license-key)) | — |
| Проприетарная | Webstudio `sdk-components-animation`; облачные Puck AI, GrapesJS Studio AI | **Нет** | — |

---

## Что НЕ брать и почему

- **tldraw и всё на нём** (make-real, стартеры). Лицензия прямо запрещает прод без ключа и требует не трогать
  проверку ключа (`tldraw/LICENSE.md`, Conditions). Холст для пометок пишем сами на `<canvas>`.
- **AGPL:** stagewise, Webstudio, make-real-starter. Несовместимо с закрытым установщиком.
- **Dyad `src/pro/`.** Тегеры компонентов и запись визуальных правок — FSL. Брать только файлы из `worker/`.
- **Agentation.** PolyForm Shield (`research/13`). Идею повторяем своим кодом (пункт 1).
- **Конструкторы приложений как движок** (bolt.diy, llamacoder, open-lovable, fragments). Это React-приложения в
  WebContainer или облачной песочнице. У нас статический лендинг с проверками; движок не меняем.
- **Каталоги «дизайн-систем» известных брендов** (OpenDesign `design-systems/`: airbnb, apple, bmw…). Против
  нашего правила «известные сайты из памяти запрещены» (E8d в `DIARY.md`) и против чужих товарных знаков.
- **Готовые шаблоны лендингов** (OpenDesign `design-templates/`, промпты make-real с Tailwind и placehold.co).
  Владелец уже ругал «выглядит как шаблон» (E8b), а картинки-заглушки ломают правило «без растра» (`check.py`).
- **Penpot.** Нужен сервер с базой. Казуалу редактор не нужен. MCP требует запущенного Penpot.
- **GrapesJS и Puck как редакторы.** Казуал не собирает страницу блоками. Их ИИ — платное облако.
- **BackstopJS, Lost Pixel, reg-suit, odiff целиком.** Node-фреймворки под CI многих страниц. Нам нужна одна
  функция сравнения — 100 строк на numpy.
- **Playwright `toHaveScreenshot`.** Есть только в JS-раннере, наши инструменты на Python.
- **pa11y.** LGPL и дублирует axe, который уже есть.
- **node-vibrant, colorthief.** Медианный срез грубее нашего `palette.py`.
- **Firecrawl branding** (через open-lovable). Платный внешний API, ключ, данные уходят наружу.
- **micro-agent.** Заброшен с 2024-11, визуальная проверка слабее нашей.
- **Деплой на Cloudflare Pages, Vercel, Surge** — недоступность из РФ (вопрос 5). Код деплоя OpenDesign
  (`apps/daemon/src/deploy.ts`) и bolt.diy читать можно, ставить по умолчанию — нет.

---

## Источники

Код (клоны в `/tmp/claude-0/-home-user/a2168356-4e49-54b0-8478-8ce494ada718/scratchpad/analogs-design/`):
- https://github.com/OpenCoworkAI/open-codesign — `4cf3393`
- https://github.com/stackblitz-labs/bolt.diy — `353b44c`
- https://github.com/abi/screenshot-to-code — `a813977`
- https://github.com/dyad-sh/dyad — `1be2b4b`
- https://github.com/onlook-dev/onlook — `423e2e9`
- https://github.com/dembrandt/dembrandt — `90e2691`
- https://github.com/nexu-io/open-design — `9724c44`
- https://github.com/aidenybai/react-grab — `ea4bbec`
- https://github.com/GoogleChromeLabs/ProjectVisBug — `fef96fa`
- https://github.com/stagewise-io/stagewise — `43c6b25`
- https://github.com/ericclemmons/click-to-component — `f8be09c`; https://github.com/infi-pc/locatorjs — `ac4ed50`;
  https://github.com/zh-lx/code-inspector — `6235e8a`
- https://github.com/tldraw/tldraw — `12921f6`; https://github.com/tldraw/make-real — `928c4c4`;
  https://github.com/tldraw/make-real-starter — `81baa9b`
- https://github.com/penpot/penpot — `74add05`; https://github.com/penpot/penpot-mcp — `73e0cd2`;
  https://github.com/penpot/penpot-plugins — `ed371b0`
- https://github.com/GrapesJS/grapesjs — `f47fbde`; https://github.com/webstudio-is/webstudio — `74af992`;
  https://github.com/puckeditor/puck — `6a823ce`
- https://github.com/BuilderIO/mitosis — `38bbdbc`; https://github.com/BuilderIO/micro-agent — `f33523c`
- https://github.com/Nutlope/llamacoder — `5d57b70`; https://github.com/firecrawl/open-lovable — `806b807`;
  https://github.com/wandb/openui — `42d7ab4`; https://github.com/e2b-dev/fragments — `3b11c7f`
- https://github.com/garris/BackstopJS — `a11d365`; https://github.com/lost-pixel/lost-pixel — `f08221f`;
  https://github.com/reg-viz/reg-suit — `5c09c8e`; https://github.com/dmtrKovalenko/odiff — `6dd1e96`;
  https://github.com/mapbox/pixelmatch — `ab76f52`
- https://github.com/dequelabs/axe-core — `6b52b84`; https://github.com/pa11y/pa11y — `aede96f`;
  https://github.com/Vibrant-Colors/node-vibrant — `ed86836`

Реестры (проверено 2026-10-25): npm `lighthouse` 13.5.0 Apache-2.0, `@medv/finder` 4.0.2 MIT, `parse5` 8.0.1 MIT,
`pixelmatch` 8.0.0 ISC, `odiff-bin` 4.5.0 MIT, `dembrandt` 0.39.2 MIT, `surge` 0.47.0 ISC, `netlify-cli` 27.14.2 MIT,
`wrangler` 4.152.0 MIT OR Apache-2.0; PyPI `pixelmatch` 0.4.0 ISC, `boto3`/`botocore` 1.43.118 Apache-2.0 (колесо
botocore 16 МБ), `playwright` 1.64.1 Apache-2.0.

Документация и новости:
- Playwright: https://playwright.dev/docs/test-snapshots ; https://playwright.dev/python/docs/test-assertions
- tldraw: https://tldraw.dev/sdk-features/license-key
- Puck AI: https://puckeditor.com/blog/puck-ai
- Yandex Cloud: https://yandex.cloud/ru/docs/storage/concepts/hosting ; https://yandex.cloud/ru/docs/storage/pricing ;
  https://yandex.cloud/ru/docs/storage/s3/signing-requests ; https://yandex.cloud/ru/docs/billing/quickstart/ ;
  https://yandex.cloud/ru/docs/free-trial/
- Beget: https://beget.com/ru/hosting/free
- Timeweb S3 (пользовательский блог): https://teletype.in/@beaverclan/blogontimewebs3
- Selectel (блог на Хабре): https://habr.com/ru/articles/822895
- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ;
  GitHub в РФ: https://meduza.io/news/2026/05/08/github-stal-ploho-otkryvatsya-v-rossii-roskomnadzor-utverzhdaet-chto-ne-blokiruet-ego ;
  https://kod.ru/is-github-blocked-in-russia
- Cloudflare в РФ: https://blog.cloudflare.com/russian-internet-users-are-unable-to-access-the-open-internet/ ;
  https://zona.media/news/2025/06/27/cf-confirmed ; https://3dnews.ru/1125069
- Vercel: https://vercel.com/docs/limits/fair-use-guidelines ;
  https://community.vercel.com/t/urgent-production-domain-bbqp-pro-is-blocked-in-russia-confirmed-vercel-ip-issue/29141 ;
  https://community.vercel.com/t/custom-domain-unreachable-from-some-russian-isps-while-vercel-app-works/48756
- Netlify: https://www.netlify.com/blog/thirteen-years-of-netlify-drop ;
  https://answers.netlify.com/t/netlify-cdn-or-dns-blocked-in-russia/372 ;
  https://answers.netlify.com/t/update-on-availability-from-russia/21036 ;
  https://answers.netlify.com/t/seems-like-my-website-is-blocked-in-russia-by-mistake/121260
- dembrandt (обзор): https://dev.to/thevangelist/i-built-dembrandt-extract-any-websites-design-system-in-seconds-open-source-2n6d

Наши файлы: `DIARY.md` (E8b–E9, A/B), `app/docs/prsloy/STATUS-design.md`, `PLAN-alpha.md:89-97`,
`research/13-design-pipeline.md`, `playbooks/site/harness/{run.py,stages.json,check.py,judge.py,moves.py}`,
`playbooks/site/motion/{README.md,brands/prsloy.css}`, `app/apps/desktop/src/main/design/preview-server.ts`,
`app/apps/desktop/src/renderer/components/PreviewFrame.tsx`, `app/apps/desktop/vite.main.config.ts`,
`design-pipeline/{AGENTS.md,PIPELINE.md,tools/README.md,tools/flow.py}` (приватный репозиторий, только ссылки).
