# ГОТОВЫЙ КОМПЛЕКТ: 90-дневная кампания продвижения API без бюджета

Ниже — артефакты, которые можно копировать и использовать сразу. Плейсхолдеры: `{API}` — название, `{BASE}` — базовый URL, `{NICHE}` — домен задачи (например «парсинг чеков», «валидация телефонов», «геокодирование»).

---

## 1. БАЗА: позиционирование в одну строку

Заполните один раз, используйте везде дословно:

```
{API} — {РЕЗУЛЬТАТ} за {ВРЕМЯ} с помощью {N} строк кода.
```

Пример формата: `{API} — валидация и нормализация телефонов в 120 странах за 50 мс, 3 строки кода, без таблиц country-codes.`

**3 JTBD-задачи** (выпишите до старта, всё контент-производство привязано к ним):

| # | Задача разработчика | Что сейчас делает | Что делает с {API} |
|---|---|---|---|
| J1 | {{ЗАДАЧА_1}} | {{КОСТЫЛЬ_1}} (часы/дни) | 1 вызов, ~10 строк |
| J2 | {{ЗАДАЧА_2}} | {{КОСТЫЛЬ_2}} | 1 вызов |
| J3 | {{ЗАДАЧА_3}} | {{КОСТЫЛЬ_3}} | 1 вызов |

---

## 2. КАЛЕНДАРЬ: что делается в какую неделю

| Недели | Deliverable | Объём | Выход |
|---|---|---|---|
| 1–2 | 5 GitHub-репозиториев | 5 репо | Код |
| 1–2 | 1 Postman/Apidog public workspace | 1 коллекция | Код |
| 3–6 | 8 туториалов | 8 статей | Трафик + SEO |
| 4 | Comparison page | 1 страница | Trust + SEO |
| 7–10 | 50+ комментариев | 2 в день | Лиды |
| 11–12 | Product Hunt + 20 рассылок | запуск | Всплеск |

Правило: **не начинайте недели 7–10 раньше, чем готовы репозитории.** Комментарий без ссылки на рабочий пример = спам.

---

## 3. БЛОК A — 5 GitHub-репозиториев (недели 1–2)

### 3.1 Список репозиториев

| Репо | Стек | Что демонстрирует | Целевой поиск |
|---|---|---|---|
| `{api}-nextjs-starter` | Next.js 14 App Router + TS | Server Action → {API} | `nextjs api example` |
| `{api}-fastapi-example` | FastAPI + Pydantic | Валидация на входе + вызов | `fastapi third party api` |
| `{api}-python-quickstart` | requests + .env | Минимум кода, 10 строк | `{niche} python` |
| `{api}-node-cli` | Node 20 + clipboard | CLI-утилита как реальный кейс | `{niche} cli` |
| `{api}-curl-postman` | curl + Postman collection | Ноль зависимостей, «запусти за 30 сек» | `{niche} api curl` |

### 3.2 README-шаблон (копировать в каждый репо)

```markdown
# {API} + {STACK} example

> {ПОЗИЦИОНИРОВАНИЕ_В_ОДНУ_СТРОКУ}

![demo](demo.gif)

## Run in 2 minutes

```bash
git clone https://github.com/{you}/{repo}
cd {repo}
cp .env.example .env      # вставьте ключ с https://{domain}/signup?utm_source=github&utm_medium=readme&utm_campaign={repo}
npm install               # или pip install -r requirements.txt
npm run dev               # или uvicorn main:app --reload
```

Open http://localhost:3000 — введите значение, получите результат.

## What happens inside

| Строка | Что делает |
|---|---|
| `main.ts:12` | отправляет `{PARAM}` на `{BASE}/v1/{endpoint}` |
| `main.ts:15` | обрабатывает ошибку 429 и ретраит с backoff |
| `main.ts:22` | кэширует ответ на 60 сек |

## Error handling
```ts
// 429 -> Retry-After header, 3 попытки, экспоненциальный backoff
// 422 -> показать пользователю поле `errors[0].field`
```

## License
MIT — форкайте и используйте в продакшене.
```

### 3.3 Спецификация demo.gif

- Длительность 8–12 сек, 1280×720, ≤2 МБ.
- Сцена: терминал → `npm run dev` → браузер → ввод → результат за <1 сек → закрыть.
- Без музыки, без курсора-анимаций, без заставки с логотипом.
- Генерация бесплатно: `asciinema` + `svg-term`, или OBS + `ffmpeg -vf "fps=12,scale=1280:-1"`.

### 3.4 Гигиена репозиториев (это и есть SEO)

- Description: `{ПОЗИЦИОНИРОВАНИЕ}` + `#starter #boilerplate`.
- Topics: `{niche}`, `api`, `starter`, `boilerplate`, `{stack}`, `example`.
- В каждом репо — бейдж `![API](https://img.shields.io/badge/API-{API}-blue)`.
- Файл `.github/FUNDING.yml` не нужен. Нужен `CONTRIBUTING.md` из 3 строк: «Issues → используем как фидбек по API».
- В `package.json` / `pyproject.toml` в `homepage` — ссылка с UTM.

---

## 4. БЛОК B — 8 туториалов (недели 3–6)

### 4.1 Сетка статей

| # | Заголовок (EN) | JTBD | Площадка |
|---|---|---|---|
| 1 | `How to {J1} in 10 lines of {LANG} (no library)` | J1 | Dev.to |
| 2 | `{J1} at scale: batching 10k requests with {API}` | J1 | Hashnode |
| 3 | `{J2}: the part nobody tells you about rate limits` | J2 | Dev.to |
| 4 | `FastAPI + {API}: Pydantic validation done right` | J2 | Dev.to |
| 5 | `{J3} in a Next.js Server Action (with caching)` | J3 | Hashnode |
| 6 | `I replaced {X_HOURS} of code with one API call. Here's the diff.` | J3 | Medium |
| 7 | `{API} vs {COMPETITOR}: an honest comparison` | — | Dev.to → сравнение на сайте |
| 8 | `Error handling for third-party APIs: 429, 5xx, timeouts` | — | Dev.to |

### 4.2 Скелет статьи (все 8 по этой схеме)

```
1. Проблема (3–5 строк, с цифрой: "это 340 строк и 2 дня работы")
2. Код ДО — свёрнутый блок, 15–25 строк костыля
3. Код ПОСЛЕ — 10 строк с {API}, полный, рабочий
4. Результат — скриншот/таблица output, честное время выполнения
5. Грабли — 3 пункта: rate limits, retry, что делать с 422
6. Ссылка: repo из Блока A + signup с UTM
```

**Жёсткие ограничения:** 80% площади — код и скриншоты. Ноль слов `revolutionary`, `game-changing`, `seamless`, `supercharge`. Ни одного абзаца без кода длиннее 5 строк.

### 4.3 Canonical URL (обязательно, иначе SEO-каннибализм)

Публикуете на Dev.to первым → в Hashnode/Medium ставите в настройках:

```html
<link rel="canonical" href="https://dev.to/{you}/{slug}" />
```

Соответственно, `utm_campaign=article_0{N}` — разные для каждой площадки, чтобы видеть, какая реально даёт регистрации.

### 4.4 Пост-затравка для Dev.to (первые 3 строки решают всё)

```
TL;DR: {РЕЗУЛЬТАТ} за {ВРЕМЯ} вместо {X_HOURS}. Полный код ниже, копипастится как есть.

Мне надоело писать {КОСТЫЛЬ} в каждом проекте, поэтому вот рабочее решение на {API}.
```

---

## 5. БЛОК C — Comparison page (неделя 4)

URL: `/{domain}/vs/{competitor}` — по одной странице на каждого из 2–3 конкурентов.

### 5.1 Шаблон страницы

```markdown
# {API} vs {COMPETITOR}

Обновлено: {дата}. Цены сверены {дата}, источник — {ссылка на прайс}.

## Короткий ответ
- Выбирайте {COMPETITOR}, если вам нужны {ИХ_СИЛЬНАЯ_СТОРОНА}.
- Выбирайте {API}, если вам нужно {НАША_СИЛЬНАЯ_СТОРОНА}.

## Таблица

| | {API} | {COMPETITOR} |
|---|---|---|
| Free tier | {N} запросов/мес | {N} |
| Цена за 100k | ${X} | ${Y} |
| p95 latency | {X} мс | {Y} мс (по их docs) |
| SDK | {список} | {список} |
| Self-hosted | нет / да | да / нет |
| Rate limit (free) | {N}/мин | {N}/мин |
| Response format | JSON | JSON + XML |

## Где мы проигрываем  ← ОБЯЗАТЕЛЬНЫЙ РАЗДЕЛ
- У нас нет {ФИЧА}. Если она критична — берите {COMPETITOR}.
- Наш SDK для {LANG} в бете.

## Код: одна и та же задача в обоих

```bash
# {API}
curl {BASE}/v1/{endpoint} -H "Authorization: Bearer $KEY" -d '{...}'

# {COMPETITOR}
curl https://api.{competitor}.com/... -H "..." -d '{...}'
```

## Миграция за 15 минут
[скрипт замены base URL + маппинг полей таблицей]
```

### 5.2 Почему раздел «где мы проигрываем» не опционален

Это единственное, что отличает comparison page от рекламы. Именно на него ссылаются в комментариях Reddit («у них, кстати, честная таблица, реально так»). Заполняйте его первым.

---

## 6. БЛОК D — 50+ комментариев (недели 7–10)

### 6.1 Где искать (бесплатные источники)

| Источник | Как искать | Объём |
|---|---|---|
| Reddit | `site:reddit.com "{niche}" api` + подписка на r/webdev, r/node, r/Python, r/SideProject | 20 |
| Stack Overflow | теги `{niche}`, `api`, `rate-limiting`, фильтр «unanswered, last 24h» | 15 |
| Hacker News | `hn.algolia.com/?q={niche}` → комменты за последний месяц | 8 |
| GitHub Issues | поиск `{niche} rate limit` в чужих репо | 5 |
| Discord/Slack сообщества | 3 сервера по {NICHE} | 5 |

### 6.2 Правило 80/20

Из 10 комментариев — 8 без ссылки вообще. Ссылка только когда в треде буквально спрашивают «чем это делать». Нарушение = бан и сожжённый аккаунт.

### 6.3 Пять готовых архетипов ответов (адаптируйте под тред)

**A. Чистое решение, без упоминания продукта**

```
The 429 is almost always because you're not honoring Retry-After. Minimal fix:

```python
for attempt in range(3):
    r = requests.get(url, headers=h)
    if r.status_code != 429:
        break
    time.sleep(float(r.headers.get("Retry-After", 2 ** attempt)))
```

Also cap concurrency with `asyncio.Semaphore(5)` — most people hammer with 50 parallel requests and then wonder why they get throttled.
```

**B. Решение + ссылка на репо (только если спросили)**

```
Same problem here. I keep a working example that handles the retry + backoff case end to end:
github.com/{you}/{repo} — the relevant part is `main.ts:15`, ~10 lines, no deps.

Not trying to sell anything, it's MIT. The `Retry-After` parsing is the bit worth copying.
```

**C. Ответ на «что выбрать» (сравнение честно)**

```
Depends on volume. Under ~{N}k/mo the free tiers are all fine, pick whatever has the SDK you like.
Above that it's mostly about the error semantics: {COMPETITOR} returns {X} on {edge case}, {API} returns {Y}.
We wrote up the trade-offs here {link} — I'm biased ({API} team), but the table has our weak spots listed too.
```

**D. Разбор чужого кода (лучший источник репутации)**

```
Line 12: `data["items"]` will KeyError when the API returns an error object instead of a list.
Check `res.ok` first, or the try/except will swallow real failures into empty results.
Rest looks right.
```

**E. HN/Show HN-стиль, сухо**

```
Author here. It's a {niche} API. The only unusual bit: {ОДНА_ТЕХНИЧЕСКАЯ_ДЕТАЛЬ}.

Pricing (free tier is {N}/mo): {link}
Happy to answer anything about the implementation.
```

### 6.4 Трекинг

Каждый комментарий → строка в таблице: `дата | платформа | URL треда | архетип | ссылка с UTM | переходы | регистрации`. Ссылки в комментариях: `?utm_source=reddit&utm_medium=comment&utm_campaign={thread_slug}`.

---

## 7. БЛОК E — Product Hunt (недели 11–12)

### 7.1 Pre-launch (за 14 дней)

- Аккаунт старше 30 дней, 10+ осмысленных комментариев в чужих запусках (не про свой продукт).
- Страница-тизер в PH «Ship» с датой.
- Пост в r/SideProject за 7 дней: «Launching {date}, would love a roast of the landing page» — это единственный законный способ собрать аудиторию заранее.

### 7.2 Копия для запуска

**Tagline (60 симв.):**
```
{NICHE} API — {РЕЗУЛЬТАТ} in 10 lines, no {КОСТЫЛЬ}
```

**Description:**
```
{API} does one thing: {РЕЗУЛЬТАТ}. You send {INPUT}, you get {OUTPUT} back in ~{N}ms.

Why it exists: {КОСТЫЛЬ} takes {X_HOURS} to build and breaks on {EDGE_CASE}. We handle {EDGE_CASE}, retries, and {REGION/SCALE} so you don't write it again.

What you get on the free tier: {N} requests/month, no card, no sales call.
Working examples: Next.js, FastAPI, Python, Node CLI — all under 2 minutes to run.

Honest limits: no {ФИЧА}, SDK only for {LANG} so far, self-hosting not available.
```

**First comment (публикуется автором сразу после запуска):**
```
Maker here. Two things worth knowing up front:

1. The free tier is actually free — {N}/mo, no card. I'd rather you test it than talk to sales.
2. Where we're weak: {СЛАБОЕ_МЕСТО}. If that's a blocker, {COMPETITOR} is a better fit and I'll say so.

Fastest way to try: `npx {package}` or the curl snippet in the gallery. Happy to answer anything technical.
```

**Gallery (5 слайдов, только скриншоты/код):**
1. Терминал с `npm run dev` → вывод.
2. Код «10 строк» целиком.
3. Таблица latency/цены.
4. GIF: запрос → ответ.
5. Repo list со ссылками.

**Кого просить:** не «друзей», а тех, кому вы реально помогли в комментариях недель 7–10. Их 20–30 человек, и они видели ваш код. Это законно и конвертирует.

---

## 8. БЛОК F — 20 рассылок + письмо

### 8.1 Список целей

- TLDR Newsletter (`tl;dr` submissions)
- JavaScript Weekly / Node Weekly
- Python Weekly
- Console DevTools
- Bytes (JS)
- Frontend Focus
- API-focused: Nordic APIs, APIs You Won't Hate
- Indie: Indie Hackers newsletter, Swipe Files
- 10 нишевых: рассылки {NICHE}-сообществ, митапов, локальных dev-сообществ

### 8.2 Письмо (отправлять с личного адреса, не `noreply@`)

```
Subject: {niche} API, free tier, working examples — for {newsletter}

Hi {name},

I run {API} — it does {РЕЗУЛЬТАТ} in one call. Free tier is {N}/mo, no card.

Not asking for a favor listing — here's what might be useful for your readers:

- Next.js starter (runs in 2 min): {link}
- FastAPI example with validation + retry: {link}
- Honest comparison vs {COMPETITOR}, including where we lose: {link}

If any of it fits a future issue, great. If not, no follow-up from me.

{Имя}, {API}
```

Правила: без вложений, без трекинга открытий, один фоллоу-ап через 10 дней максимум, дальше молчите.

---

## 9. UTM-схема (единая, не менять)

| Источник | utm_source | utm_medium | utm_campaign | utm_content |
|---|---|---|---|---|
| GitHub README | `github` | `readme` | `{repo_name}` | `cta` |
| Туториал Dev.to | `devto` | `article` | `art_01`…`art_08` | `inline_code` |
| Hashnode/Medium | `hashnode`/`medium` | `article` | `art_0N` | `canonical` |
| Комментарий Reddit | `reddit` | `comment` | `{thread_slug}` | `archetype_B` |
| Product Hunt | `producthunt` | `launch` | `ph_launch` | `first_comment` |
| Рассылка | `{newsletter}` | `email` | `outreach_01` | `body_link` |
| Comparison page | `{domain}` | `organic` | `vs_{competitor}` | — |

**Бонус:** в signup-форме скрытое поле `ref` из `utm_source` → в БД. Без этого вы не узнаете, что работает.

---

## 10. KPI: что считается нормой

| Недели | Метрика | План | Минимум |
|---|---|---|---|
| 2 | Репозиториев с demo.gif | 5 | 3 |
| 6 | Статей с canonical | 8 | 5 |
| 6 | Переходы на signup | 300 | 120 |
| 10 | Комментариев | 50 | 30 |
| 10 | Регистрации | 180 | 70 |
| 12 | PH upvotes | 200 | 60 |
| 12 | Регистрации из PH | 90 | 25 |
| 12 | **Активации** (первый успешный вызов) | 35% от регистраций | 20% |

Главная метрика — **активация, а не регистрация.** Если активация <20%, проблема не в продвижении, а в онбординге; останавливайте кампанию и правьте quickstart.

---

## 11. Чек-лист дня 1 (сегодня, 4 часа)

1. [ ] Заполнить `{ПОЗИЦИОНИРОВАНИЕ}` и таблицу J1–J3.
2. [ ] Создать 5 пустых репо с описаниями и топиками из §3.4.
3. [ ] Написать `{api}-python-quickstart` целиком (самый быстрый, 60 минут) + записать gif.
4. [ ] Опубликовать Postman public workspace (§12).
5. [ ] Поставить UTM на все ссылки в README и на сайте.
6. [ ] Завести таблицу трекинга: `дата | источник | URL | переходы | регистрации | активации`.

---

## 12. Postman / Apidog workspace

- Название: `{API} — quickstart collection`.
- 4 запроса: happy path, 422 (невалидный вход), 429 (rate limit), 500 (retry).
- В каждом запросе — тест-скрипт, который печатает `Response time: {{res.time}}ms` в консоль. Это то, что люди скриншотят.
- Environment с `baseUrl` и `apiKey`, без секретов.
- В описании коллекции — та же ссылка с UTM `utm_source=postman&utm_medium=workspace`.

---

**Что не входит в план и почему:** ни одного поста «Introducing our API», ни одного фейкового кейса с выдуманными цифрами, ни одной просьбы «check out my project» без контекста в треде. Первые два убивают доверие разработчиков навсегда, третье — аккаунт.