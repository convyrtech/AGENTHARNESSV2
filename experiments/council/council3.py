"""Council v3: same brief for all variants (date, owner facts, explicit formulas), Opus with reasoning_effort=high.
V0 single Opus | V4 Opus x5 + synthesis | V2 council v2 (text math, peer review) |
V5 council v3: seats give assumptions as JSON -> code computes unit economics, break-even, capacity, sensitivity ->
anonymous peer review over the computed table -> chair may only use table numbers or [расчёт: expr = value] ->
code evaluates every [расчёт] + a verifier of another family checks the rest -> one fix pass."""
import sys, os, re, ast, json, random, time, statistics, threading, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
from lib import a6
CFG = json.load(open(sys.argv[1])); OUT = os.path.join(HERE, "runs", CFG["out_dir"]); os.makedirs(OUT, exist_ok=True)
CORE, DATA, SEATS = CFG["core"], CFG["data"], CFG["seats"]
CHAIR, HIGH = "claude-opus-5-5", {"reasoning_effort": "high"}
VERIFIER = ("gpt-6.1-sol", HIGH)
PRICE, TRAFFIC, RENT, CELLS = 1900, 6000, 6000, 12
META, LOCK = [], threading.Lock()

def ask(model, system, text, tag, extra=None, max_tokens=32000):
    body = {"model": model, "max_tokens": max_tokens, "stream_options": {"include_usage": True},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}], **(extra or {})}
    for attempt in range(3):
        try:
            r = a6.chat_stream(body, tag=tag, timeout=1500)
        except Exception as e:
            r = {"status": f"exc {e!r}", "chunks": [], "secs": 0}
        ch = [c for c in r["chunks"] if isinstance(c, dict)]
        delta = lambda c: ((c.get("choices") or [{}])[0].get("delta") or {})
        out = "".join(delta(c).get("content") or "" for c in ch)
        rc = "".join(delta(c).get("reasoning_content") or "" for c in ch)
        u = [c["usage"] for c in ch if c.get("usage")]
        if r["status"] == 200 and len(out.strip()) > 40:
            with LOCK:
                META.append({"tag": tag, "model": model, "secs": r["secs"], "words": len(out.split()), "reasoning_chars": len(rc),
                             "out_tok": u[-1].get("completion_tokens") if u else None, "in_tok": u[-1].get("prompt_tokens") if u else None})
            return out.strip()
    return f"(нет ответа: {r['status']})"

ACCOUNT = ("Ты совладелец: твоя доля — 5% от прибыли в худшем сценарии. Твой прогноз сверят с первыми неделями продаж: "
           "если твои цифры ошибутся больше чем на 30%, ты выбываешь из совета. Уверенная ошибка хуже честного «не знаю».")
CARD = ("Ответ — максимум 200 слов, по-русски, без вступлений и без пересказа брифа. Строго так:\n"
        "ПРЕДЛОЖЕНИЕ: (твоё решение и ключевые цифры)\nПОЧЕМУ: (до 3 пунктов)\nРАСЧЁТ: (одна-две строки с цифрами)\n"
        "РИСК: (главный риск и как закрыть)\nПРОГНОЗ: (одна метрика первых недель, которую ты предсказываешь, с числом)\nВСЕ УПУСТЯТ: (одна вещь)")
SCHEMA = """```json
{
 "kg_day": [пессимистично, база, оптимистично],      // продажи одной точки, кг в день, ноябрь 2026 – январь 2027
 "summer_factor": [п, б, о],     // во сколько раз продажи летом 2027 выше, чем в ноябре–январе
 "margin_kg": [п, б, о],         // маржа ₽ на проданный кг (основатель: 300–400, всё входит)
 "rent_in_margin": false,        // входит ли аренда 6 000 ₽/мес в маржу (твоё прочтение)
 "acquiring_pct": [п, б, о],     // эквайринг, % от выручки
 "other_fixed_month": [п, б, о], // прочие фиксированные расходы точки, ₽ в месяц (связь, электричество, сервис), если не в марже
 "extra_writeoff_pct": [п, б, о],// списания СВЕРХ заложенных в маржу, % непроданного товара
 "avg_pack_kg": [п, б, о],       // средний вес одной покупки, кг
 "loads_per_week": [п, б, о]     // сколько раз в неделю загружаем автомат
}
```"""
CARD3 = ("Сначала блок допущений строго по схеме (только числа, без комментариев внутри JSON):\n" + SCHEMA +
         "\nПрибыль, безубыточность и ёмкость НЕ считай — их посчитает код по твоим допущениям. Затем карточка, максимум 200 слов, по-русски:\n"
         "ПРЕДЛОЖЕНИЕ: (решение по своему фокусу, конкретно)\nПОЧЕМУ: (до 3 пунктов)\nРИСК: (главный риск и как закрыть)\n"
         "ПРОГНОЗ: (одна метрика первых недель с числом)\nВСЕ УПУСТЯТ: (одна вещь)")
SYNTH = ("Ты — председатель. Сам не споришь. Сведи ответы экспертов. Максимум 400 слов, простым языком, по-русски. Разделы:\n"
         "СОГЛАСИЕ: что предлагают почти все.\nРАЗНОГЛАСИЯ: где расходятся и чьи аргументы сильнее.\n"
         "УНИКАЛЬНЫЕ НАХОДКИ: идеи, которые есть только у одного эксперта, — оставь ценные.\nОШИБКИ: неверные цифры и логика, с исправлением.\n"
         "РЕКОМЕНДАЦИЯ: план запуска 8 автоматов и ключевые цифры.\nПРАВИЛА: держать / переносить / докупать — с числами.\n"
         "ЧТО НЕИЗВЕСТНО: какие допущения решают исход и как их проверить.\nЧТО МЕРИТЬ С ПЕРВОГО ДНЯ.")
NUMRULE = ("\n\nПРАВИЛО ЧИСЕЛ: сам в уме не считай. Все суммы, проценты и килограммы бери из ТАБЛИЦЫ РАСЧЁТА. "
           "Если нужно число, которого в таблице нет, пиши его вместе с формулой в квадратных скобках, например [расчёт: 6000 / 30 = 200]. "
           "Формулы проверит код.")

def seat_sys(s):
    return f"Ты — {s['name']}, {s['role']}. Говоришь резко и по делу, не поддакиваешь. {s['line']} {ACCOUNT}"

# ---------- calculator ----------
BETTER_HIGH = {"kg_day", "summer_factor", "margin_kg", "avg_pack_kg", "loads_per_week"}
VARS = ["kg_day", "summer_factor", "margin_kg", "acquiring_pct", "other_fixed_month", "extra_writeoff_pct", "avg_pack_kg", "loads_per_week"]

def parse_json(text):
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S) or re.search(r"(\{[^{}]*\"kg_day\".*?\})", text, re.S)
    if not m: return None
    raw = re.sub(r"//[^\n]*", "", m.group(1))
    try:
        d = json.loads(raw)
    except ValueError:
        return None
    out = {"rent_in_margin": bool(d.get("rent_in_margin", False))}
    for v in VARS:
        x = d.get(v)
        if isinstance(x, (int, float)): x = [x, x, x]
        if not (isinstance(x, list) and len(x) == 3 and all(isinstance(i, (int, float)) for i in x)): return None
        lo, hi = min(x), max(x)
        out[v] = {"p": lo if v in BETTER_HIGH else hi, "b": x[1], "o": hi if v in BETTER_HIGH else lo}
    return out

def econ(a, sc, rent_in_margin=None):
    g = lambda v: a[v][sc] if isinstance(a[v], dict) else a[v]
    rim = a["rent_in_margin"] if rent_in_margin is None else rent_in_margin
    kg, m, acq, other, wo = g("kg_day"), g("margin_kg"), g("acquiring_pct"), g("other_fixed_month"), g("extra_writeoff_pct")
    per_kg = m - PRICE * acq / 100 - (PRICE - m) * (wo / 100) / (1 - wo / 100)
    fixed = (0 if rim else RENT) + other
    profit = kg * 30 * per_kg - fixed
    be = fixed / (30 * per_kg) if per_kg > 0 else float("inf")
    cap = CELLS * g("loads_per_week") / 7 * g("avg_pack_kg")
    conv = kg / g("avg_pack_kg") / TRAFFIC * 100
    # extra write-off at which the point earns zero
    need = fixed / (30 * kg) if kg else float("inf"); x = (m - PRICE * acq / 100 - need) / (PRICE - m)
    wo_zero = 100 * x / (1 + x) if x > 0 else 0.0
    return {"profit": profit, "per_kg": per_kg, "be": be, "cap": cap, "conv": conv, "wo_zero": wo_zero, "kg": kg}

def rub(x): return f"{x:,.0f}".replace(",", " ") + " ₽"
def num(x, d=1): return ("∞" if x == float("inf") else f"{x:.{d}f}".replace(".", ","))

def table(assump, alias):
    lines = ["ТАБЛИЦА РАСЧЁТА (посчитано кодом по допущениям экспертов; цена 1 900 ₽/кг, трафик 6 000/день, аренда 6 000 ₽/мес, 12 ячеек).", "",
             "| Эксперт | Аренда в марже? | кг/день п/б/о | Прибыль точки в месяц п / б / о | Чистыми с кг (база) | Безубыточность, кг/день (база) | Конверсия (база) | Ёмкость кг/день при 1 ячейке = 1 заказ (база) | Точка в ноль при списаниях сверх плана (база) |",
             "|---|---|---|---|---|---|---|---|---|"]
    for k, a in assump.items():
        if not a: lines.append(f"| {alias[k]} | — | JSON не распознан | | | | | | |"); continue
        e = {sc: econ(a, sc) for sc in "pbo"}
        lines.append(f"| {alias[k]} | {'да' if a['rent_in_margin'] else 'нет'} | {num(a['kg_day']['p'])} / {num(a['kg_day']['b'])} / {num(a['kg_day']['o'])} | "
                     f"{rub(e['p']['profit'])} / {rub(e['b']['profit'])} / {rub(e['o']['profit'])} | {rub(e['b']['per_kg'])} | {num(e['b']['be'])} | "
                     f"{num(e['b']['conv'], 2)}% | {num(e['b']['cap'])}{' ⚠️ меньше продаж' if e['b']['cap'] < a['kg_day']['b'] else ''} | {num(e['b']['wo_zero'])}% |")
    ok = [a for a in assump.values() if a]
    comb = {"rent_in_margin": False}
    for v in VARS:
        comb[v] = {sc: statistics.median(a[v][sc] for a in ok) for sc in "pbo"}
    lines += ["", "СВОДНЫЙ СЦЕНАРИЙ (медиана допущений всех экспертов):", "",
              "| | Пессимистично | База | Оптимистично |", "|---|---|---|---|",
              "| кг в день на точку | " + " | ".join(num(comb["kg_day"][s]) for s in "pbo") + " |"]
    for rim, name in [(False, "аренда отдельно"), (True, "аренда внутри маржи")]:
        e = {sc: econ(comb, sc, rim) for sc in "pbo"}
        lines.append(f"| Прибыль точки в месяц ({name}) | " + " | ".join(rub(e[s]["profit"]) for s in "pbo") + " |")
        lines.append(f"| Прибыль 8 точек в месяц ({name}) | " + " | ".join(rub(8 * e[s]["profit"]) for s in "pbo") + " |")
        lines.append(f"| Безубыточность, кг/день ({name}) | " + " | ".join(num(e[s]["be"]) for s in "pbo") + " |")
    e = {sc: econ(comb, sc, False) for sc in "pbo"}
    lines.append("| Чистыми с проданного кг | " + " | ".join(rub(e[s]["per_kg"]) for s in "pbo") + " |")
    lines.append("| Покупок в день на точку | " + " | ".join(num(comb["kg_day"][s] / comb["avg_pack_kg"][s]) for s in "pbo") + " |")
    lines.append("| Конверсия трафика | " + " | ".join(num(e[s]["conv"], 2) + "%" for s in "pbo") + " |")
    lines.append("| Ёмкость, кг/день (1 ячейка = 1 заказ) | " + " | ".join(num(e[s]["cap"]) for s in "pbo") + " |")
    lines.append("| Точка в ноль при списаниях сверх плана | " + " | ".join(num(e[s]["wo_zero"]) + "%" for s in "pbo") + " |")
    summer = {sc: econ(dict(comb, kg_day={s: comb["kg_day"][s] * comb["summer_factor"][s] for s in "pbo"}), sc, False) for sc in "pbo"}
    lines.append("| Лето 2027: кг/день | " + " | ".join(num(summer[s]["kg"]) for s in "pbo") + " |")
    lines.append("| Лето 2027: прибыль точки в месяц | " + " | ".join(rub(summer[s]["profit"]) for s in "pbo") + " |")
    base = econ(comb, "b", False)["profit"]; sens = []
    for v in ["kg_day", "margin_kg", "extra_writeoff_pct", "acquiring_pct", "other_fixed_month"]:
        lo = econ(dict(comb, **{v: {s: comb[v]["p"] for s in "pbo"}}), "b", False)["profit"]
        hi = econ(dict(comb, **{v: {s: comb[v]["o"] for s in "pbo"}}), "b", False)["profit"]
        sens.append((abs(hi - lo), v, lo, hi))
    names = {"kg_day": "продажи кг/день", "margin_kg": "маржа на кг", "extra_writeoff_pct": "списания сверх плана", "acquiring_pct": "эквайринг", "other_fixed_month": "прочие фикс. расходы"}
    lines += ["", f"ЧУВСТВИТЕЛЬНОСТЬ (база = {rub(base)} на точку в месяц, аренда отдельно; меняем одну переменную от пессимистичной до оптимистичной):", "",
              "| Переменная | Прибыль при худшем значении | При лучшем | Размах |", "|---|---|---|---|"]
    for sw, v, lo, hi in sorted(sens, reverse=True):
        lines.append(f"| {names[v]} ({num(comb[v]['p'])} → {num(comb[v]['o'])}) | {rub(lo)} | {rub(hi)} | {rub(sw)} |")
    return "\n".join(lines)

# ---------- number check ----------
MARK = re.compile(r"\[расч[её]т:\s*([^\]]+?)=\s*([^\]=]+)\]")
def _num(s):
    s = s.replace(" ", "").replace(" ", "").replace(" ", "").replace("−", "-").replace("×", "*").replace("÷", "/").replace(",", ".")
    return s
def safe_eval(expr):
    tree = ast.parse(_num(expr), mode="eval")
    ok = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.USub, ast.UAdd, ast.Pow)
    if not all(isinstance(n, ok) for n in ast.walk(tree)): raise ValueError("not arithmetic")
    return eval(compile(tree, "<calc>", "eval"))
def check_marks(text):
    res = []
    for m in MARK.finditer(text):
        expr, val = m.group(1), m.group(2)
        try:
            got = safe_eval(expr); v = float(re.sub(r"[^0-9.\-]", "", _num(val)) or "nan")
            okk = abs(got - v) <= max(0.02 * abs(got), 0.51)
            res.append({"mark": m.group(0), "computed": round(got, 2), "stated": v, "ok": okk})
        except Exception as e:
            res.append({"mark": m.group(0), "error": str(e), "ok": False})
    return res

def verify(final, tbl):
    prompt = (f"{tbl}\n\nТЕКСТ ПРЕДСЕДАТЕЛЯ:\n{final}\n\nПроверь каждое число в тексте председателя: совпадает ли оно с таблицей расчёта или "
              "следует из неё простой арифметикой, не перепутаны ли единицы (кг/покупки, день/месяц, одна точка/8 точек). "
              "Ответь только JSON: {\"issues\": [{\"quote\": \"фрагмент текста\", \"problem\": \"что не так\", \"fix\": \"как правильно\"}]}. "
              "Если ошибок нет — {\"issues\": []}.")
    raw = ask(VERIFIER[0], "Ты — педантичный проверяющий цифр. Ничего не придумываешь.", prompt, "c3-V5-verify", VERIFIER[1])
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        return json.loads(m.group(0)).get("issues", []) if m else [{"problem": "verifier: no JSON", "raw": raw[:300]}]
    except ValueError:
        return [{"problem": "verifier: bad JSON", "raw": raw[:300]}]

# ---------- variants ----------
def run_single():
    t0 = time.time()
    final = ask(CHAIR, "Ты — опытный советник основателя. Пиши по-русски, прямо, без воды.",
                CORE + "\n\nДай рекомендацию, максимум 400 слов: план запуска 8 автоматов, юнит-экономика в сценариях (на точку и на 8 точек), "
                "правила «держать / переносить / докупать» с числами, главные риски, что мерить с первого дня и что проверить первым.", "c3-V0", HIGH)
    open(os.path.join(OUT, "V0.md"), "w").write(final); return final, round(time.time() - t0)

def run_selfcons():
    t0 = time.time()
    with cf.ThreadPoolExecutor(5) as ex:
        samples = list(ex.map(lambda i: ask(CHAIR, f"Ты — независимый эксперт №{i+1}. Говоришь резко и по делу.", CORE + "\n\n" + CARD, f"c3-V4-s{i}", HIGH), range(5)))
    anon = "\n\n".join(f"### Эксперт {i+1}\n{x}" for i, x in enumerate(samples))
    final = ask(CHAIR, SYNTH, f"{CORE}\n\nОТВЕТЫ ЭКСПЕРТОВ:\n{anon}", "c3-V4-synth", HIGH)
    open(os.path.join(OUT, "V4.md"), "w").write(f"{anon}\n\n# ИТОГ\n{final}"); return final, round(time.time() - t0)

def _cards(label, card):
    with cf.ThreadPoolExecutor(5) as ex:
        return dict(zip([s["key"] for s in SEATS], ex.map(lambda s: ask(s["model"], seat_sys(s), f"{CORE}\n\n{DATA[s['key']]}\n\n{card}", f"c3-{label}-{s['key']}", s.get("extra")), SEATS)))

def _reviews(label, order, material):
    def rev(s):
        return ask(s["model"], seat_sys(s), f"{CORE}\n\n{material}\n\nМаксимум 120 слов: 1) две самые сильные идеи (номер эксперта и почему); "
                   "2) нереалистичные допущения или ошибки с исправлением; 3) что все упустили.", f"c3-{label}-rev-{s['key']}", s.get("extra"))
    with cf.ThreadPoolExecutor(5) as ex:
        revs = dict(zip([s["key"] for s in SEATS], ex.map(rev, SEATS)))
    return "\n\nВЗАИМНОЕ РЕВЬЮ (анонимно):\n" + "\n\n".join(f"### Ревьюер {i+1}\n{revs[k]}" for i, k in enumerate(order))

def run_v2():
    t0 = time.time(); cards = _cards("V2", CARD)
    order = [s["key"] for s in SEATS]; random.Random("V2").shuffle(order); alias = {k: f"Эксперт {i+1}" for i, k in enumerate(order)}
    anon = "\n\n".join(f"### {alias[k]}\n{cards[k]}" for k in order)
    reviews = _reviews("V2", order, f"Ответы экспертов (анонимно, твой тоже среди них):\n{anon}")
    final = ask(CHAIR, SYNTH, f"{CORE}\n\nОТВЕТЫ ЭКСПЕРТОВ:\n{anon}{reviews}", "c3-V2-synth", HIGH)
    open(os.path.join(OUT, "V2.md"), "w").write(f"{anon}{reviews}\n\n# ИТОГ\n{final}"); return final, round(time.time() - t0)

def run_v5():
    t0 = time.time(); cards = _cards("V5", CARD3)
    order = [s["key"] for s in SEATS]; random.Random("V5").shuffle(order); alias = {k: f"Эксперт {i+1}" for i, k in enumerate(order)}
    assump = {k: parse_json(cards[k]) for k in order}
    for k in order:  # one retry for unparsable assumptions
        if assump[k] is None:
            s = next(x for x in SEATS if x["key"] == k)
            cards[k] = ask(s["model"], seat_sys(s), f"{CORE}\n\n{DATA[k]}\n\n{CARD3}\n\nВАЖНО: блок JSON строго по схеме, все значения — массивы из трёх чисел.", f"c3-V5-{k}-retry", s.get("extra"))
            assump[k] = parse_json(cards[k])
    strip = lambda t: re.sub(r"```(?:json)?\s*\{.*?\}\s*```", "", t, flags=re.S).strip()
    tbl = table(assump, alias)
    anon = "\n\n".join(f"### {alias[k]}\n{strip(cards[k])}" for k in order)
    reviews = _reviews("V5", order, f"{tbl}\n\nКарточки экспертов (анонимно, твоя тоже среди них):\n{anon}")
    draft = ask(CHAIR, SYNTH + NUMRULE, f"{CORE}\n\n{tbl}\n\nКАРТОЧКИ ЭКСПЕРТОВ:\n{anon}{reviews}", "c3-V5-synth", HIGH)
    marks, issues = check_marks(draft), verify(draft, tbl)
    bad = [m for m in marks if not m["ok"]] + issues
    final = draft
    if bad:
        final = ask(CHAIR, SYNTH + NUMRULE, f"{CORE}\n\n{tbl}\n\nТВОЙ ЧЕРНОВИК:\n{draft}\n\nПРОВЕРКА ЧИСЕЛ НАШЛА ОШИБКИ:\n{json.dumps(bad, ensure_ascii=False, indent=1)}\n\n"
                    "Исправь только эти места, остальное оставь как есть. Выведи итоговый текст целиком.", "c3-V5-fix", HIGH)
    marks2 = check_marks(final)
    report = {"assumptions": assump, "marks_draft": marks, "verifier_issues": issues, "marks_final": marks2}
    json.dump(report, open(os.path.join(OUT, "V5-checks.json"), "w"), ensure_ascii=False, indent=1)
    open(os.path.join(OUT, "V5.md"), "w").write(f"{tbl}\n\n{anon}{reviews}\n\n# ЧЕРНОВИК\n{draft}\n\n# ИТОГ\n{final}")
    return f"{final}\n\n---\n\n{tbl}", round(time.time() - t0)

if __name__ == "__main__":
    jobs = {"V0": run_single, "V2": run_v2, "V4": run_selfcons, "V5": run_v5}
    res = {}
    with cf.ThreadPoolExecutor(4) as ex:
        futs = {k: ex.submit(f) for k, f in jobs.items()}
        for k, f in futs.items(): res[k] = f.result()
    letters = list("ABCD"); random.Random("rakomat-v3").shuffle(letters); key = dict(zip(res, letters))
    blind = "\n\n---\n\n".join(f"# Вариант {key[k]}\n\n{res[k][0]}" for k in sorted(res, key=lambda k: key[k]))
    open(os.path.join(OUT, "BLIND-for-owner.md"), "w").write("Четыре ответа на вопрос о запуске 8 ракоматов. Какой полезнее для решения? Оцени каждый 1–5 и выбери лучший.\n\n" + blind)
    json.dump({"key": key, "secs": {k: v[1] for k, v in res.items()}}, open(os.path.join(OUT, "key-do-not-open.json"), "w"), ensure_ascii=False)
    json.dump(META, open(os.path.join(OUT, "meta.json"), "w"), ensure_ascii=False, indent=1)
    print("done", {k: v[1] for k, v in res.items()})
