"""Council v2 experiment: known designs (Karpathy llm-council, Council Mode) + our hypotheses, vs single model and self-consistency.
V0 single Opus | V2 sharp personas, <=200 words, per-seat data, accountability, anonymous peer review, synthesis
V3 same without peer review | V4 Opus x5 samples + synthesis (self-consistency). Outputs blind-labelled finals for the owner."""
import sys, os, json, random, time, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); import council as C
CFG = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else None
OUT = os.path.join(HERE, "runs", CFG["out_dir"] if CFG else "pricing-v2-2026-10-22"); os.makedirs(OUT, exist_ok=True)
CHAIR = "claude-opus-5-5"

CORE = """РЕШЕНИЕ: тарифы. У нас ДВА продукта для разных аудиторий:
1) Десктоп-приложение с ИИ-агентом (сайты, код, тексты, повседневные задачи, Telegram) — для казуальных пользователей из РФ, которые не умеют писать промпты. Монетизация — подписка. Основатель склоняется к $10 и $50 в месяц.
2) API-сервис (ключи, кабинет с дневным лимитом в ₽, OpenAI- и Anthropic-совместимые адреса) — для энтузиастов и разработчиков.
Оба работают через наш шлюз поверх маркетплейса a6api. Без VPN и зарубежной карты, оплата картами РФ и криптой. Реализацию и доработки делают ИИ-агенты: это часы, а не дни.
ВАРИАНТЫ (можно предложить свой): A) подписки $10/$50 с бюджетом «в официальных долларах» как у OpenCode Go; B) только оплата по факту с наценкой; C) подписка + дневной лимит в ₽ + перерасход с баланса; D) бесплатный старт → C; E) сначала бета с замером потребления.
НУЖНО: конкретные цены и лимиты для обоих продуктов, наша маржа, как объяснить казуалу, защита от злоупотреблений, что проверить первым."""

DATA = {
 "fin": """ТВОИ ДАННЫЕ (себестоимость, $ за 1M токенов, вход/выход, цены a6, октябрь 2026): DeepSeek V4.1 Flash 0.0012–0.0068 / 0.0048–0.027 (цена прыгнула ×5.7 при смене поставщика за день); GLM 5.3 0.008–0.017 / 0.026–0.053; MiniMax M3 0.023 / 0.093; Qwen 3.8 Max 0.036 / 0.108; Kimi K3 0.041 / 0.204; Gemini 3.8 Flash 0.026–0.030 / 0.13–0.15; GPT-6.1 0.015–0.077 / 0.077–0.385; Claude Opus 5.5 0.096 / 0.48 (официально 4 / 20); Gemini 4 0.17–0.20 / 0.84–1.02. Допущения: курс 85 ₽/$, комиссии/налоги/возвраты 12%.""",
 "mkt": """ТВОИ ДАННЫЕ (рынок): OpenCode Go $10/мес (Go Plus $40), внутри месячные лимиты в долларах по моделям (DeepSeek V4.1 Flash $80/$160), окна 20% за 5 ч и 50% за неделю; по наблюдению основателя, на всё, кроме акционных моделей, жёсткие лимиты порядка $6. OpenCode Zen: по факту + 4.6% + $0.31. Kilo Gateway: без наценки + 5%. Cursor $20/$60/$200. a6api — публичный сайт, продвинутые могут купить там напрямую.""",
 "cx": """ТВОИ ДАННЫЕ (клиент): казуал не знает, что такое токен, боится «сгорающих» денег и непонятных списаний. В кабинете API уже нарисован дневной лимит в ₽ («32,41 из 50 ₽ сегодня»). Допущения о потреблении казуала в приложении: лёгкий — чат и тексты 2–3 раза в неделю; средний — сайты и задачи несколько часов в неделю; тяжёлый — агент каждый день, премиум-модели.""",
 "risk": """ТВОИ ДАННЫЕ (риски поставок, факты): дешёвые Claude/GPT на a6 идут через пулы подписок и реверс-прокси; поставщики меняются, цены прыгают (DeepSeek ×5.7 за день), часть подмешивает скрытые промпты (до 5К токенов), один поставщик GLM игнорирует системный промпт, аккаунты могут банить. Кэш промптов у DeepSeek через a6 почти не работает. Официальные цены в 40–125 раз выше.""",
 "ops": """ТВОИ ДАННЫЕ (измерено нами): простая задача по коду на DeepSeek ~$0.00002; сайт (~64K токенов вывода) на DeepSeek ~$0.0003–0.002; план от Opus ~$0.005–0.01; вызов диспетчера ~$0.00003; совет из 5 моделей ~$0.05–0.1. Лучшая схема для сайтов: Opus пишет ТЗ, DeepSeek делает. Риск злоупотреблений: Telegram-боты и скрипты могут слать тысячи мелких запросов в день, перепродажа ключей.""",
}
SEATS = [
 {"key": "fin", "name": "Аркадий Вершинин", "role": "финансист", "model": "gpt-6.1-sol", "extra": {"reasoning_effort": "high"},
  "line": "Красная линия: маржа в худшем сценарии ниже 50% — ты против, без исключений."},
 {"key": "mkt", "name": "Лера Огнева", "role": "маркетолог роста", "model": "gemini-4-argon",
  "line": "Красная линия: если мы для пользователя дороже или запутаннее OpenCode Go — не продадим, ты против."},
 {"key": "cx", "name": "Мирон Тихий", "role": "голос казуального клиента", "model": "claude-opus-5-5",
  "line": "Красная линия: если обычный человек не поймёт тариф за 10 секунд или почувствует себя обманутым — ты против."},
 {"key": "risk", "name": "Глеб Резкий", "role": "страж от разорения", "model": "grok-4.7",
  "line": "Красная линия: любой сценарий, где один день или один пользователь может увести нас в минус, — ты против. Всегда исходи из худшего."},
 {"key": "ops", "name": "Савва Счётов", "role": "операционный директор", "model": "deepseek-v4.1-flash-1017",
  "line": "Красная линия: если тариф нельзя защитить от абьюза автоматикой — ты против."},
]
if CFG:
    CORE = CFG["core"]; DATA = CFG["data"]; SEATS = CFG["seats"]
ACCOUNT = ("Ты совладелец: твоя доля — 5% от маржи в худшем сценарии. Твой прогноз сверят с данными беты: "
           "если твои цифры ошибутся больше чем на 30%, ты выбываешь из совета. Уверенная ошибка хуже честного «не знаю».")
CARD = ("Ответ — максимум 200 слов, по-русски, без вступлений и без пересказа брифа. Строго так:\n"
        "ПРЕДЛОЖЕНИЕ: (твоё решение и ключевые цифры)\nПОЧЕМУ: (до 3 пунктов)\nРАСЧЁТ: (одна-две строки с цифрами)\n"
        "РИСК: (главный риск и как закрыть)\nПРОГНОЗ: (одна метрика беты, которую ты предсказываешь, с числом)\nВСЕ УПУСТЯТ: (одна вещь)")

def seat_sys(s):
    return f"Ты — {s['name']}, {s['role']}. Говоришь резко и по делу, не поддакиваешь. {s['line']} {ACCOUNT}"

def chat(model, sys_, text, tag, extra=None, max_tokens=32000):
    return C.ask(model, sys_, text, tag, extra, max_tokens)

SYNTH = ("Ты — председатель. Сам не споришь. Сведи ответы экспертов. Максимум 350 слов, простым языком, по-русски. Разделы:\n"
         "СОГЛАСИЕ: что предлагают почти все.\nРАЗНОГЛАСИЯ: где расходятся и чьи аргументы сильнее.\n"
         "УНИКАЛЬНЫЕ НАХОДКИ: идеи, которые есть только у одного эксперта, — оставь ценные.\nОШИБКИ: неверные цифры и логика, с исправлением.\n"
         "РЕКОМЕНДАЦИЯ: решение и ключевые цифры.\nЧТО НЕИЗВЕСТНО: какие допущения решают исход и как их проверить.\nСАМЫЙ ДЕШЁВЫЙ ТЕСТ И КОГДА ОСТАНОВИТЬСЯ.")

def run_council(label, peer_review):
    t0 = time.time()
    with cf.ThreadPoolExecutor(5) as ex:
        cards = dict(zip([s["key"] for s in SEATS], ex.map(lambda s: chat(s["model"], seat_sys(s), f"{CORE}\n\n{DATA[s['key']]}\n\n{CARD}", f"c2-{label}-{s['key']}", s.get("extra")), SEATS)))
    order = [s["key"] for s in SEATS]; random.Random(label).shuffle(order); alias = {k: f"Эксперт {i+1}" for i, k in enumerate(order)}
    anon = "\n\n".join(f"### {alias[k]}\n{cards[k]}" for k in order)
    reviews = ""
    if peer_review:
        def rev(s):
            return chat(s["model"], seat_sys(s), f"{CORE}\n\nОтветы экспертов (анонимно, твой тоже среди них):\n{anon}\n\n"
                        "Максимум 120 слов: 1) две самые сильные идеи (номер эксперта и почему); 2) ошибки в цифрах или логике с исправлением; 3) рейтинг ответов от лучшего к худшему.",
                        f"c2-{label}-rev-{s['key']}", s.get("extra"))
        with cf.ThreadPoolExecutor(5) as ex:
            revs = dict(zip([s["key"] for s in SEATS], ex.map(rev, SEATS)))
        reviews = "\n\nВЗАИМНОЕ РЕВЬЮ (анонимно):\n" + "\n\n".join(f"### Ревьюер {i+1}\n{revs[k]}" for i, k in enumerate(order))
    final = chat(CHAIR, SYNTH, f"{CORE}\n\nОТВЕТЫ ЭКСПЕРТОВ:\n{anon}{reviews}", f"c2-{label}-synth")
    open(os.path.join(OUT, f"{label}.md"), "w").write(f"{anon}{reviews}\n\n# ИТОГ\n{final}")
    return final, round(time.time() - t0)

ALLDATA = CORE + "\n\n" + "\n\n".join(DATA.values())
def run_single():
    t0 = time.time()
    final = chat(CHAIR, "Ты — опытный советник основателя. Пиши по-русски, прямо, без воды.",
                 ALLDATA + "\n\nДай рекомендацию, максимум 350 слов: согласие с основателем или нет, рекомендация цифрами для приложения и API, "
                 "главные аргументы, ошибки в допущениях основателя, главный риск, самый дешёвый тест и когда остановиться.", "c2-V0")
    open(os.path.join(OUT, "V0.md"), "w").write(final); return final, round(time.time() - t0)

def run_selfcons():
    t0 = time.time()
    prompt = ALLDATA + "\n\n" + CARD
    with cf.ThreadPoolExecutor(5) as ex:
        samples = list(ex.map(lambda i: chat(CHAIR, f"Ты — независимый эксперт №{i+1}. Говоришь резко и по делу.", prompt, f"c2-V4-s{i}"), range(5)))
    anon = "\n\n".join(f"### Эксперт {i+1}\n{x}" for i, x in enumerate(samples))
    final = chat(CHAIR, SYNTH, f"{CORE}\n\nОТВЕТЫ ЭКСПЕРТОВ:\n{anon}", "c2-V4-synth")
    open(os.path.join(OUT, "V4.md"), "w").write(f"{anon}\n\n# ИТОГ\n{final}"); return final, round(time.time() - t0)

if __name__ == "__main__":
    jobs = {"V0": run_single, "V2": lambda: run_council("V2", True), "V3": lambda: run_council("V3", False), "V4": run_selfcons}
    res = {}
    with cf.ThreadPoolExecutor(4) as ex:
        futs = {k: ex.submit(f) for k, f in jobs.items()}
        for k, f in futs.items(): res[k] = f.result()
    letters = list("ABCD"); random.Random(2026).shuffle(letters); key = dict(zip(res, letters))
    blind = "\n\n---\n\n".join(f"# Вариант {key[k]}\n\n{res[k][0]}" for k in sorted(res, key=lambda k: key[k]))
    open(os.path.join(OUT, "BLIND-for-owner.md"), "w").write("Четыре ответа на один вопрос. Какой полезнее для решения? Оцени каждый 1–5 и выбери лучший.\n\n" + blind)
    json.dump({"key": key, "secs": {k: v[1] for k, v in res.items()}}, open(os.path.join(OUT, "key-do-not-open.json"), "w"), ensure_ascii=False)
    print("done", {k: v[1] for k, v in res.items()})
