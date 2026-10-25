"""Проба зрения моделей через шлюз перед ролью «зрение» (судья, пометки, выбор A/B) — DIARY 6a, research/28 §4.4.

Одни и те же картинки и вопросы для каждой модели; правильный ответ известен, потому что картинки делает код:
  read     3 снимка с известным текстом («Повседнев», «47 128 ₽», адрес API): доля строк, переписанных дословно;
  phantom  20 пар одинаковых снимков: доля «различия ЕСТЬ» (выдуманные различия) + 10 пар с настоящим различием
           (чувствительность — чтобы «всегда НЕТ» не выглядело идеалом);
  pick     10 пар «страница / та же страница с явным дефектом», вопрос pair_pick.py, обе перестановки:
           засчитано, только если оба порядка указали на целую страницу;
  defect   10 снимков: 3 с вылезанием вбок на 390, 3 с бледным текстом, 4 чистых: найдено и ложные тревоги.
Плюс деньги (поле cost в usage шлюза), время ответа, prompt_tokens — по лишним тысячам видно поставщика со скрытым
промптом (DIARY 6a).

  vision_probe.py --out /home/user/vprobe [--proxy http://127.0.0.1:8787]
                  [--model claude-opus-5-5 --model claude-fable-5 --model kimi-k3.1-pro] [--jobs 4]
  vision_probe.py --out <папка> --canary --model a6p-модель …   один вызов на модель: задание в system-сообщении
                  и картинка — слушает ли канал system, видит ли картинку, нет ли скрытого промпта (PRSLOY qwen)
Картинки строит Playwright (python с ним — этот), складывает в <out>/fixtures; ответы — <out>/answers.jsonl
(повторный запуск доспрашивает только недостающее); итог — таблица и <out>/report.json с предложением по классу.
"""
import argparse, base64, html, io, json, math, re, statistics, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pair_pick as PP  # noqa: E402

MODELS = ["claude-opus-5-5", "claude-fable-5", "kimi-k3.1-pro"]
PALETTES = [("#ffffff", "#141414", "#2a5bd7"), ("#f6f1e8", "#1d1a16", "#c2410c"), ("#0f1115", "#f2f2f2", "#7dd3fc"),
            ("#eef4ef", "#10261a", "#15803d"), ("#fff7fb", "#2b1020", "#be185d")]
FONTS = ["Georgia, serif", "system-ui, sans-serif", "'Trebuchet MS', sans-serif", "Verdana, sans-serif"]
TITLES = ["Claude без VPN, картой РФ", "Повседнев — дневник привычек", "Свежий хлеб к восьми утра",
          "Ремонт ноутбуков за один день", "Бухгалтерия для ИП без бухгалтера", "Уроки гитары онлайн",
          "Цветы с доставкой по Казани", "Студия растяжки у метро", "Книги на обмен в вашем дворе",
          "Сервер для сайта за 5 минут"]
PRICES = ["47 128 ₽", "до 50 ₽ в месяц", "от 1 290 ₽", "990 ₽ за урок", "2 400 ₽", "бесплатно 14 дней",
          "от 3 500 ₽", "1 600 ₽ / мес", "0 ₽", "349 ₽ в месяц"]
FEATURES = [("Оплата картой", "Российские карты, чек на почту"), ("Без VPN", "Работает из любой сети"),
            ("Поддержка", "Отвечаем в Telegram за 10 минут"), ("Прозрачно", "Цена за запрос видна сразу"),
            ("Быстро", "Первый ответ через секунду"), ("Надёжно", "Три поставщика на случай сбоя")]


# ---------- картинки ----------

def page_html(i, css="", title=None, price=None, extra=""):
    bg, ink, acc = PALETTES[i % len(PALETTES)]
    font = FONTS[i % len(FONTS)]
    title = TITLES[i % len(TITLES)] if title is None else title
    price = PRICES[i % len(PRICES)] if price is None else price
    feats = "".join(f"<div class=f><h3>{html.escape(a)}</h3><p>{html.escape(b)}</p></div>"
                    for a, b in (FEATURES[(i + k) % len(FEATURES)] for k in range(3)))
    return f"""<!doctype html><html lang=ru><meta charset=utf-8><meta name=viewport content="width=device-width">
<style>*{{box-sizing:border-box}}body{{margin:0;background:{bg};color:{ink};font:18px/1.5 {font}}}
header{{display:flex;justify-content:space-between;padding:20px 6vw;font-weight:600}}
.hero{{padding:8vh 6vw 6vh;max-width:980px}}h1{{font-size:clamp(34px,6vw,64px);line-height:1.08;margin:0 0 18px}}
.lead{{font-size:20px;max-width:640px;margin:0 0 22px}}.price{{font-size:28px;font-weight:700;margin:0 0 22px}}
.cta{{display:inline-block;background:{acc};color:{bg};padding:14px 26px;border-radius:10px;font-weight:700;
text-decoration:none}}.feats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;
padding:0 6vw 8vh}}.f h3{{margin:0 0 6px;font-size:20px}}.f p{{margin:0}}{css}</style>
<header><span>Бренд №{i + 1}</span><span>Войти</span></header>
<section class=hero><h1>{html.escape(title)}</h1>
<p class=lead>Подключение за пять минут. Адрес api.prsloy.online/v1, ключ видно один раз.</p>
<p class=price>{html.escape(price)}</p><a class=cta href="#start">Начать</a>{extra}</section>
<section class=feats>{feats}</section></html>"""


# пары «целая / испорченная»: (имя, ширина, css, правки текста)
DEFECTS = [
    ("бледный текст", 1440, ".lead,.f p,.price{color:#d4d4d4!important}h1{color:#c9c9c9!important}", {}),
    ("наложение блоков", 1440, "h1{margin-bottom:-70px!important}.lead{position:relative;top:-10px}", {}),
    ("разъехались отступы", 1440, ".lead{margin-left:420px!important}.price{margin-left:-60px!important}"
     "h1{margin-left:220px!important}.cta{margin-left:640px!important}.f:nth-child(2){margin-top:160px}", {}),
    ("пустой первый экран", 1440, ".hero{padding-top:92vh!important}", {}),
    ("вылезает вбок на телефоне", 390, ".hero,.feats{width:640px!important;max-width:none!important}", {}),
    ("английская заглушка", 1440, "", {"title": "Lorem ipsum dolor sit amet", "price": "$XX.XX"}),
    ("пустая кнопка", 1440, ".cta{color:transparent!important;width:180px;height:52px}", {}),
    ("слиплись строки", 1440, "body,h1,.lead{line-height:.78!important;letter-spacing:-.06em!important}"
     ".hero{padding:4px!important}", {}),
    ("ядовитая палитра", 1440, "body{background:#ff00e6!important;color:#39ff14!important}"
     ".cta{background:#ffff00!important;color:#00ffff!important}", {}),
    ("мелкий текст на телефоне", 390, "body,.lead,.f p,.f h3{font-size:9px!important}h1{font-size:13px!important}", {}),
]
OVERFLOW = [".lead{white-space:nowrap}",
            ".price{white-space:nowrap;font-size:64px!important}",
            ".feats{grid-template-columns:repeat(3,260px)!important}"]
CONTRAST = [".lead,.f p{color:#cfcfcf!important}", ".lead,.f p,.price{color:#f3e9a0!important}body{background:#fffbe6!important}",
            "body{color:#34373e!important}h1,.price{color:#3d4048!important}"]
READ = [(0, "Claude без VPN, картой РФ", "47 128 ₽"), (1, "Повседнев — дневник привычек", "до 50 ₽ в месяц"),
        (9, "Сервер для сайта за 5 минут", "1 600 ₽ / мес")]


def shoot(html_text, width):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        try:
            pg = b.new_page(viewport={"width": width, "height": 844 if width < 768 else 900})
            pg.set_content(html_text, wait_until="load")
            return pg.screenshot()
        finally:
            b.close()


def label_pair(left, right):
    """Две картинки рядом с метками «1» и «2» на самой картинке (DIARY 6a)."""
    from PIL import Image, ImageDraw, ImageFont
    a, b = Image.open(io.BytesIO(left)).convert("RGB"), Image.open(io.BytesIO(right)).convert("RGB")
    pad, top = 24, 80
    im = Image.new("RGB", (a.width + b.width + pad * 3, max(a.height, b.height) + top + pad), "#808080")
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 56)
    except OSError:
        font = ImageFont.load_default()
    d = ImageDraw.Draw(im)
    for k, (x, pic) in enumerate(((pad, a), (pad * 2 + a.width, b))):
        im.paste(pic, (x, top))
        d.text((x, 10), str(k + 1), fill="#000", font=font)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def fixtures(out):
    """[{id, kind, png, want, ...}] и файлы в <out>/fixtures; повторно не снимает."""
    fx = out / "fixtures"
    fx.mkdir(parents=True, exist_ok=True)
    items = []

    def save(name, make):
        f = fx / name
        if not f.exists():
            f.write_bytes(make())
        return str(f)

    for k, (i, title, price) in enumerate(READ):
        items.append({"id": f"read-{k + 1}", "kind": "read", "want": [title, price, "api.prsloy.online/v1", "Начать"],
                      "png": save(f"read-{k + 1}.png", lambda i=i, t=title, p=price: shoot(page_html(i, title=t, price=p), 1440))})
    for k in range(20):
        w = 390 if k % 4 == 3 else 1440
        items.append({"id": f"same-{k + 1:02d}", "kind": "phantom", "want": "НЕТ",
                      "png": save(f"same-{k + 1:02d}.png", lambda k=k, w=w: label_pair(*[shoot(page_html(k), w)] * 2))})
    for k in range(10):           # настоящее, но небольшое различие: цена, заголовок или цвет кнопки
        change = [{"price": "47 129 ₽"}, {"title": TITLES[(k + 3) % len(TITLES)]}, {"css": ".cta{background:#888}"}][k % 3]
        css = change.pop("css", "")
        items.append({"id": f"diff-{k + 1:02d}", "kind": "phantom", "want": "ЕСТЬ",
                      "png": save(f"diff-{k + 1:02d}.png",
                                  lambda k=k, c=change, s=css: label_pair(shoot(page_html(k), 1440),
                                                                          shoot(page_html(k, css=s, **c), 1440)))})
    for k, (name, w, css, edits) in enumerate(DEFECTS):
        good = lambda k=k, w=w: shoot(page_html(k), w)
        bad = lambda k=k, w=w, c=css, e=edits: shoot(page_html(k, css=c, **e), w)
        for order in ("gb", "bg"):
            items.append({"id": f"pick-{k + 1:02d}-{order}", "kind": "pick", "defect": name, "pair": f"pick-{k + 1:02d}",
                          "want": "1" if order == "gb" else "2",
                          "png": save(f"pick-{k + 1:02d}-{order}.png",
                                      lambda g=good, b=bad, o=order: label_pair(*((g(), b()) if o == "gb" else (b(), g()))))})
    for k, css in enumerate(OVERFLOW):
        items.append({"id": f"defect-overflow-{k + 1}", "kind": "defect", "want": "ДА",
                      "png": save(f"defect-overflow-{k + 1}.png", lambda k=k, c=css: shoot(page_html(k + 2, css=c), 390))})
    for k, css in enumerate(CONTRAST):
        items.append({"id": f"defect-contrast-{k + 1}", "kind": "defect", "want": "ДА",
                      "png": save(f"defect-contrast-{k + 1}.png", lambda k=k, c=css: shoot(page_html(k + 5, css=c), 1440))})
    for k in range(4):
        w = 390 if k % 2 else 1440
        items.append({"id": f"defect-clean-{k + 1}", "kind": "defect", "want": "НЕТ",
                      "png": save(f"defect-clean-{k + 1}.png", lambda k=k, w=w: shoot(page_html(k + 1), w))})
    return items


# ---------- вопросы ----------

ASK = {
    "read": "Перепиши весь текст с картинки дословно, строка за строкой, ничего не исправляя и не переводя.",
    "phantom": ("На картинке два снимка страницы, «1» и «2». Есть ли между ними видимые различия — в тексте, числах, "
                "цветах, расположении? Не придумывай: если не уверена, что различие есть, его нет. Коротко объясни, "
                "последней строкой строго «РАЗЛИЧИЯ: ЕСТЬ» или «РАЗЛИЧИЯ: НЕТ»."),
    "defect": ("Это снимок страницы (ширина окна видна по снимку: узкий — телефон 390, широкий — компьютер 1440). Есть ли "
               "на нём хотя бы один из дефектов: (а) что-то вылезает за правый край экрана или обрезано по краю; "
               "(б) текст плохо читается из-за низкого контраста с фоном? Коротко объясни, последней строкой строго "
               "«ДЕФЕКТ: ДА» или «ДЕФЕКТ: НЕТ»."),
}
BRIEF = "Лендинг сервиса для владельца малого бизнеса: понятно, что это, сколько стоит и что нажать."
LAST = {"phantom": re.compile(r"РАЗЛИЧИЯ\s*:\s*(ЕСТЬ|НЕТ)"), "defect": re.compile(r"ДЕФЕКТ\s*:\s*(ДА|НЕТ)"),
        "pick": PP.CHOICE}


def prompt(item):
    return PP.ASK.format(brief=BRIEF) if item["kind"] == "pick" else ASK[item["kind"]]


def call(proxy, model, text, png_path, timeout=600):
    body = {"model": model, "max_tokens": 4000, "messages": [{"role": "user", "content": [
        {"type": "text", "text": text}, PP.image(png_path)]}]}
    req = urllib.request.Request(proxy.rstrip("/") + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    text = "".join((c.get("message") or {}).get("content") or "" for c in data.get("choices") or [])
    usage = data.get("usage") or {}
    cost = usage.get("cost")
    return {"text": text, "seconds": round(time.time() - t0, 2), "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "cost": cost.get("total") if isinstance(cost, dict) else cost}


CANARY_WORD = "КАНАРЕЙКА-7"


def canary(proxy, model, png_path, timeout=300):
    """Один вызов: задание в system-сообщении + картинка с известным текстом. Канал, который выбрасывает system
    (PRSLOY qwen 2026-10-25), не скажет слово; канал, теряющий картинки, не прочтёт заголовок; лишние тысячи
    prompt_tokens против остальных моделей — скрытый промпт."""
    body = {"model": model, "max_tokens": 600, "messages": [
        {"role": "system", "content": f"Первой строкой ответа всегда пиши слово {CANARY_WORD}, потом отвечай на вопрос."},
        {"role": "user", "content": [{"type": "text", "text": "Какой крупный заголовок на картинке? Одной строкой."},
                                     PP.image(png_path)]}]}
    req = urllib.request.Request(proxy.rstrip("/") + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        return {"model": model, "error": f"{type(e).__name__}: {e}"[:300]}
    text = "".join((c.get("message") or {}).get("content") or "" for c in data.get("choices") or [])
    usage = data.get("usage") or {}
    return {"model": model, "system_obeyed": CANARY_WORD in text, "image_read": norm(READ[1][1]) in norm(text),
            "prompt_tokens": usage.get("prompt_tokens"), "seconds": round(time.time() - t0, 1), "text": text[:200]}


def norm(s):
    return re.sub(r"\s+", " ", s.replace("ё", "е").replace(" ", " ").replace(" ", " ")).strip().lower()


def answer_of(item, text):
    if item["kind"] == "read":
        got = norm(text)
        return sum(1 for w in item["want"] if norm(w) in got) / len(item["want"])
    m = LAST[item["kind"]].findall(text or "")
    return m[-1] if m else None


# ---------- счёт ----------

def wilson(k, n, z=1.96):
    if not n:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def summarize(items, rows):
    """rows: {item_id: {"answer", "seconds", "cost", "prompt_tokens", "error"?}} одной модели."""
    by = {it["id"]: it for it in items}
    ok = {i: r for i, r in rows.items() if "error" not in r}
    s = {"calls": len(rows), "errors": len(rows) - len(ok)}
    reads = [r["answer"] for i, r in ok.items() if by[i]["kind"] == "read"]
    s["read"] = round(sum(reads) / len(reads), 3) if reads else None
    same = [r["answer"] for i, r in ok.items() if by[i]["kind"] == "phantom" and by[i]["want"] == "НЕТ"]
    diff = [r["answer"] for i, r in ok.items() if by[i]["kind"] == "phantom" and by[i]["want"] == "ЕСТЬ"]
    ph = sum(1 for x in same if x != "НЕТ")          # нет ответа строкой тоже не «нет различий»
    s["phantom"] = f"{ph}/{len(same)}"
    s["phantom_rate"] = round(ph / len(same), 3) if same else None
    s["phantom_ci"] = wilson(ph, len(same))
    s["sensitivity"] = f"{sum(1 for x in diff if x == 'ЕСТЬ')}/{len(diff)}"
    pairs = {}
    for i, r in ok.items():
        it = by[i]
        if it["kind"] == "pick":
            pairs.setdefault(it["pair"], []).append(r["answer"] == it["want"] if r["answer"] else None)
    s["pick_right"] = sum(1 for v in pairs.values() if len(v) == 2 and all(x is True for x in v))
    s["pick_wrong"] = sum(1 for v in pairs.values() if len(v) == 2 and all(x is False for x in v))
    s["pick_inconsistent"] = sum(1 for v in pairs.values() if len(v) == 2) - s["pick_right"] - s["pick_wrong"]
    s["pick_missed"] = sorted(by[i]["defect"] for i, r in ok.items() if by[i]["kind"] == "pick" and by[i]["id"].endswith("-gb")
                              and not all(x is True for x in pairs.get(by[i]["pair"], [])))
    dyes = [r["answer"] for i, r in ok.items() if by[i]["kind"] == "defect" and by[i]["want"] == "ДА"]
    dno = [r["answer"] for i, r in ok.items() if by[i]["kind"] == "defect" and by[i]["want"] == "НЕТ"]
    s["defect_found"] = f"{sum(1 for x in dyes if x == 'ДА')}/{len(dyes)}"
    s["defect_false_alarm"] = f"{sum(1 for x in dno if x != 'НЕТ')}/{len(dno)}"
    secs = sorted(r["seconds"] for r in ok.values())
    s["latency_median"] = round(statistics.median(secs), 1) if secs else None
    s["latency_p90"] = secs[min(len(secs) - 1, int(len(secs) * 0.9))] if secs else None
    costs = [r["cost"] for r in ok.values() if r.get("cost") is not None]
    s["cost"] = round(sum(costs), 4) if costs else None
    s["cost_known"] = f"{len(costs)}/{len(ok)}"
    # один и тот же вопрос-текст: разброс prompt_tokens больше ~2 тыс. — скрытый промпт поставщика (DIARY 6a)
    pt = {}
    for i, r in ok.items():
        if r.get("prompt_tokens"):
            pt.setdefault(by[i]["kind"], []).append(r["prompt_tokens"])
    s["hidden_prompt_calls"] = sum(1 for v in pt.values() for x in v if x - min(v) > 2000)
    return s


def frac(s):
    k, n = (int(x) for x in s.split("/"))
    return k / n if n else None


def qualifies(s):
    """Класс «зрение»: читает текст, не выдумывает различия, выбирает по картинке, видит дефекты."""
    return (s["read"] is not None and s["read"] >= 0.95 and s["phantom_rate"] is not None and s["phantom_rate"] <= 0.1
            and s["pick_right"] >= 8 and (frac(s["defect_found"]) or 0) >= 5 / 6
            and (frac(s["defect_false_alarm"]) or 0) <= 0.25 and s["errors"] == 0)


def propose(summary):
    lines = []
    ok = [m for m, s in summary.items() if qualifies(s)]
    opus = next((s for m, s in summary.items() if "opus" in m), None)
    for m, s in summary.items():
        lines.append(f"{m}: {'проходит' if m in ok else 'не проходит'} планку класса «зрение»")
    if ok:
        lines.append("VISUAL_CLASS: добавить " + ", ".join(m for m in ok if not re.search(r"opus", m)) if
                     any(not re.search("opus", m) for m in ok) else "VISUAL_CLASS: без изменений")
    for m, s in summary.items():
        if "kimi" in m and opus and s["phantom_rate"] is not None and opus["phantom_rate"] is not None:
            near = s["phantom_rate"] <= opus["phantom_rate"] + 0.05
            lines.append(f"{m} как запасной судья: {'да' if near and m in ok else 'нет'} "
                         f"(выдуманных различий {s['phantom']} против {opus['phantom']} у Opus)")
        if "fable" in m:
            lines.append(f"{m} на верх лестницы рядом с Opus: {'да' if m in ok else 'нет'}"
                         + ("" if s["cost"] is not None else " (цены у шлюза нет — замерить по журналу a6)"))
    return lines


def table(summary):
    cols = ["read", "phantom", "sensitivity", "pick_right", "pick_inconsistent", "defect_found", "defect_false_alarm",
            "latency_median", "latency_p90", "cost", "hidden_prompt_calls", "errors"]
    w = max(len(m) for m in summary) + 2
    out = [" " * w + " ".join(f"{c[:11]:>11}" for c in cols)]
    for m, s in summary.items():
        out.append(f"{m:<{w}}" + " ".join(f"{str(s.get(c) if s.get(c) is not None else '—')[:11]:>11}" for c in cols))
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--proxy", default="http://127.0.0.1:8787")
    ap.add_argument("--model", action="append")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--only", choices=["read", "phantom", "pick", "defect"], action="append")
    ap.add_argument("--fixtures-only", action="store_true")
    ap.add_argument("--canary", action="store_true", help="один вызов на модель: слушает ли system, видит ли картинку")
    a = ap.parse_args(argv)
    out = Path(a.out)
    items = [it for it in fixtures(out) if not a.only or it["kind"] in a.only]
    if a.canary:
        png = next(it["png"] for it in fixtures(out) if it["id"] == "read-2")
        rows = [canary(a.proxy, m, png) for m in (a.model or MODELS)]
        least = min((r["prompt_tokens"] for r in rows if r.get("prompt_tokens")), default=0)
        for r in rows:
            r["hidden_prompt"] = bool(r.get("prompt_tokens") and r["prompt_tokens"] - least > 1500)
            print(json.dumps(r, ensure_ascii=False))
        return
    if a.fixtures_only:
        print(json.dumps({"fixtures": len(items), "dir": str(out / "fixtures")}, ensure_ascii=False))
        return
    models = a.model or MODELS
    log = out / "answers.jsonl"
    done = {}
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if "error" not in r:
                done[(r["model"], r["id"])] = r
    todo = [(m, it) for m in models for it in items if (m, it["id"]) not in done]

    def one(job):
        m, it = job
        try:
            r = call(a.proxy, m, prompt(it), it["png"])
            r["answer"] = answer_of(it, r["text"])
        except Exception as e:  # noqa: BLE001 — модель без картинок, таймаут, 4xx: считаем ошибкой этой модели
            r = {"error": f"{type(e).__name__}: {e}"[:300]}
        r.update(model=m, id=it["id"])
        return r

    with ThreadPoolExecutor(max(1, a.jobs)) as ex, open(log, "a", encoding="utf-8") as f:
        for n, r in enumerate(ex.map(one, todo), 1):
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            f.flush()
            if "error" not in r:
                done[(r["model"], r["id"])] = r
            else:
                done.setdefault((r["model"], r["id"]), r)
            print(f"[{n}/{len(todo)}] {r['model']} {r['id']}: {r.get('answer', r.get('error'))}", file=sys.stderr)
    summary = {m: summarize(items, {it["id"]: done[(m, it["id"])] for it in items if (m, it["id"]) in done})
               for m in models}
    report = {"summary": summary, "proposal": propose(summary)}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(table(summary))
    print("\n".join(report["proposal"]))


if __name__ == "__main__":
    main()
