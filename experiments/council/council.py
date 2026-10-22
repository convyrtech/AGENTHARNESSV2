"""Multi-model expert council (Roast-Room-style protocol) over the a6 relay.
Seats = roles with invented names, each on a different model family. Chair = separate call that never argues.
Rounds: 1) independent opening cards  2) debate on anonymized cards + cruxes  3) ratify/amend chair's draft.
Usage: python3 council.py <config.json>   (config: brief, options, seats, chair, rounds, images, out_dir)"""
import sys, os, json, random, base64, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(HERE, "..", "lib")); import a6

def ask(model, system, user_parts, tag, extra=None, max_tokens=32000):
    content = user_parts if isinstance(user_parts, list) else [{"type": "text", "text": user_parts}]
    body = {"model": model, "max_tokens": max_tokens, "stream_options": {"include_usage": True},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}], **(extra or {})}
    for attempt in range(3):
        try:
            r = a6.chat_stream(body, tag=tag, timeout=1500)
        except Exception as e:
            r = {"status": f"exc {e!r}", "chunks": []}
        text = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in r["chunks"] if isinstance(c, dict))
        if r["status"] == 200 and len(text.strip()) > 40:
            return text.strip()
    return f"(нет ответа: {r['status']})"

def img_parts(paths):
    out = []
    for p in paths:
        mime = "image/png" if p.endswith(".png") else "image/jpeg"
        out.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(open(p, "rb").read()).decode()}})
    return out

SEAT_SYS = ("Ты — {name}, эксперт по направлению «{pillar}». Твой вопрос, за который ты отвечаешь: {question} "
            "Ты участвуешь в совете экспертов, который помогает основателю принять решение. Говори прямо, по-русски, своим голосом, "
            "без воды и без общих слов. Опирайся на факты из брифа; если считаешь — показывай расчёт; если чего-то не хватает — "
            "назови допущение явно. Не поддакивай основателю и другим экспертам: если не согласен — спорь.")
CARD = ("Формат ответа (строго эти заголовки):\n## Позиция\n(1–2 предложения: какой вариант и почему)\n"
        "## Оценки вариантов\n(каждый вариант: оценка 0–10 по твоему направлению и одна строка почему)\n"
        "## Главный аргумент\n## Расчёт или факты\n## Риски\n(включая строку «Риск разорения: нет / возможен / вероятен» и почему)\n"
        "## Условия\n(при каких условиях ты поддержишь решение)\n## Что упущено\n(что основатель не спросил, а зря)")

def main(cfg_path):
    cfg = json.load(open(cfg_path)); out = os.path.join(HERE, cfg["out_dir"]); os.makedirs(out, exist_ok=True)
    brief = cfg["brief"]; images = img_parts(cfg.get("images", []))
    seats = cfg["seats"]; chair = cfg["chair"]
    def seat_call(seat, prompt, tag):
        sys_ = SEAT_SYS.format(**seat)
        return ask(seat["model"], sys_, [{"type": "text", "text": prompt}] + images, tag, seat.get("extra"))
    # Round 1
    p1 = f"БРИФ\n{brief}\n\nЭто раунд 1: дай свою независимую позицию.\n\n{CARD}"
    with cf.ThreadPoolExecutor(len(seats)) as ex:
        r1 = dict(zip([s["name"] for s in seats], ex.map(lambda s: seat_call(s, p1, f"council-r1-{s['model']}"), seats)))
    open(os.path.join(out, "round-1.md"), "w").write("\n\n".join(f"# {n} ({next(s for s in seats if s['name']==n)['pillar']})\n\n{t}" for n, t in r1.items()))
    # anonymize
    names = list(r1); random.Random(7).shuffle(names); alias = {n: f"Эксперт {i+1}" for i, n in enumerate(names)}
    anon1 = "\n\n".join(f"### {alias[n]}\n{r1[n]}" for n in names)
    chair_sys = ("Ты — председатель совета. Ты никогда не споришь сам и не добавляешь своих аргументов: ты ведёшь заседание, "
                 "находишь настоящие разногласия, проверяешь логику и цифры экспертов и пишешь итог простым языком для основателя, "
                 "который не любит воду. Пиши по-русски.")
    cruxes = ask(chair["model"], chair_sys, f"БРИФ\n{brief}\n\nКарточки раунда 1 (анонимно):\n{anon1}\n\n"
                 "Найди 2–4 ключевых разногласия (crux): фактическое, числовое или ценностное; кто на какой стороне. "
                 "Если все согласны — назови самую сильную альтернативу, которую никто не защитил, и потребуй её разобрать. "
                 "Отметь ошибки в расчётах, если видишь. Коротко.", "council-cruxes", chair.get("extra"))
    open(os.path.join(out, "cruxes.md"), "w").write(cruxes)
    # Round 2
    with cf.ThreadPoolExecutor(len(seats)) as ex:
        r2 = dict(zip([s["name"] for s in seats], ex.map(lambda s: seat_call(s,
            f"БРИФ\n{brief}\n\nКарточки раунда 1 (анонимно, твоя тоже среди них):\n{anon1}\n\nРазногласия от председателя:\n{cruxes}\n\n"
            "Раунд 2 — дебаты. Ответь по каждому разногласию, спорь с конкретными экспертами (по номеру), обнови оценки, "
            "если тебя переубедили — скажи чем. Тот же формат карточки.\n\n" + CARD, f"council-r2-{s['model']}"), seats)))
    anon2 = "\n\n".join(f"### {alias[n]}\n{r2[n]}" for n in names)
    open(os.path.join(out, "round-2.md"), "w").write("\n\n".join(f"# {n}\n\n{t}" for n, t in r2.items()))
    draft = ask(chair["model"], chair_sys, f"БРИФ\n{brief}\n\nРаунд 1:\n{anon1}\n\nРаунд 2:\n{anon2}\n\n"
                "Напиши проект решения: рекомендованный вариант с КОНКРЕТНЫМИ параметрами (цифры), условия, которые требовали эксперты "
                "(проверяемые), самый дешёвый тест, критерии остановки, следующие шаги с порядком. Взвешивай аргументы, а не число голосов: "
                "один решающий факт важнее трёх мнений. Если кто-то видит вероятный риск разорения — ограничь решение.", "council-draft", chair.get("extra"))
    open(os.path.join(out, "draft.md"), "w").write(draft)
    # Round 3
    with cf.ThreadPoolExecutor(len(seats)) as ex:
        r3 = dict(zip([s["name"] for s in seats], ex.map(lambda s: seat_call(s,
            f"БРИФ\n{brief}\n\nПроект решения председателя:\n{draft}\n\nРаунд 3 — ратификация. Ответь: «поддерживаю / поддерживаю с поправкой / против», "
            "максимум 2 поправки (конкретно, с цифрами), и одна строка — что будет, если проигнорировать твою поправку.", f"council-r3-{s['model']}"), seats)))
    open(os.path.join(out, "round-3.md"), "w").write("\n\n".join(f"# {n}\n\n{t}" for n, t in r3.items()))
    verdict = ask(chair["model"], chair_sys, f"БРИФ\n{brief}\n\nПроект:\n{draft}\n\nРатификация (с именами):\n" +
                  "\n\n".join(f"### {n} ({next(s for s in seats if s['name']==n)['pillar']})\n{t}" for n, t in r3.items()) +
                  "\n\nНапиши ИТОГ для основателя, максимум 350 слов, простыми словами:\n1) Вердикт одной фразой.\n2) Рекомендация с цифрами.\n"
                  "3) Три аргумента, которые решили дело (с именем эксперта).\n4) Главное возражение (с именем).\n5) Принятые поправки.\n"
                  "6) Самый дешёвый тест и когда остановиться.\n7) Следующие 3 шага.", "council-verdict", chair.get("extra"))
    open(os.path.join(out, "verdict.md"), "w").write(verdict)
    # control: one model alone with the same brief
    if cfg.get("control"):
        ctrl = ask(cfg["control"], "Ты — опытный советник основателя. Пиши по-русски, прямо, без воды.",
                   [{"type": "text", "text": f"БРИФ\n{brief}\n\nДай рекомендацию, максимум 350 слов: вердикт, рекомендация с цифрами, три главных аргумента, "
                     "главный риск, самый дешёвый тест и когда остановиться, следующие 3 шага."}] + images, "council-control", cfg.get("control_extra"))
        open(os.path.join(out, "control-single-model.md"), "w").write(ctrl)
    print("done", out)

if __name__ == "__main__":
    main(sys.argv[1])
