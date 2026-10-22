"""E7: vague casual request, NO brand. a) direct + 2 critique rounds | d) owner's method: 2 different coded variants -> builder's hybrid |
c) gpt-image mockups -> GPT-6.1 + Gemini 4 pick (pairwise, both orders) -> build to mockup + 2 critique rounds. 2 samples each, builder Opus, 3 builder calls each."""
import sys, os, re, json, time, random, base64, itertools, subprocess, requests, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.dirname(HERE))
import e6
from e6 import ask, html_of, label, BUILDER, CRITIC, PICKERS
from lib import a6
OUT = os.path.join(HERE, "e7"); AS = os.path.join(OUT, "assets")
REQUEST = "сделай сайт для моей кофейни, чтобы было красиво"
FACTS = ("Что рассказал владелец: кофейня «Зерно», Москва, ул. Ленина, 12. Работаем каждый день 8:00–22:00. Варим кофе (эспрессо, капучино, латте, раф, фильтр), "
         "свежая выпечка каждое утро (круассаны, синнабоны). Заказ навынос через Telegram @zerno_coffee, телефон +7 900 123-45-67. "
         "Фото прислал (лежат рядом с сайтом): assets/cup.jpg — чашка капучино, assets/interior.jpg — зал кофейни, assets/pastry.jpg — выпечка.")
TECH = ("Сверстай ОДИН самодостаточный HTML-файл лендинга (inline CSS, можно немного ванильного JS; шрифты — Google Fonts с кириллицей; фото — только из assets/, "
        "других внешних картинок нет). Адаптивно: десктоп 1440 и телефон 390. Верни только код в блоке ```html.")
CHECK = ("Чек-лист: 1) ошибки вёрстки, обрезанный или налезающий текст, мобильная версия; 2) шаблонный «нейро-сайт» (градиентный hero + большая фраза + карточки со статистикой + неон, "
         "одинаковые карточки с иконками) — предложи своё решение; 3) дубли (одно и то же показано дважды) и украшения без смысла; 4) пояснения очевидного прямо на странице "
         "(«это наше меню», «нажмите, чтобы…») — убрать; 5) понятно ли обычному человеку за 5 секунд: что это, где, когда, как заказать; 6) выдуманные факты, которых не давал владелец.")
def img(p):
    mime = "image/png" if p.endswith(".png") else "image/jpeg"
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(open(p, "rb").read()).decode()}}
def small(p, w=900):
    from PIL import Image; import io
    im = Image.open(p).convert("RGB")
    if im.width > w: im = im.resize((w, int(im.height * w / im.width)))
    if im.height > 4000: im = im.crop((0, 0, im.width, 4000))
    b = io.BytesIO(); im.save(b, "JPEG", quality=80)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()}}
def photos():
    return [{"type": "text", "text": "Фото владельца (assets/cup.jpg, assets/interior.jpg, assets/pastry.jpg):"}] + [small(os.path.join(AS, f), 512) for f in ("cup.jpg", "interior.jpg", "pastry.jpg")]
def task():
    return [{"type": "text", "text": f"Запрос клиента: «{REQUEST}».\n{FACTS}"}]
def render(html, base):
    hp = base + ".html"; open(hp, "w").write(html)
    r = subprocess.run(["node", os.path.join(HERE, "shot7.mjs"), hp, base], capture_output=True, text=True, timeout=180)
    return r.stdout.strip()[-200:]
def critique(base, tag):
    parts = task() + [{"type": "text", "text": "Первый экран (десктоп):"}, img(base + "-top.png"), {"type": "text", "text": "Вся страница (десктоп, уменьшено):"}, small(base + "-full.jpg"),
             {"type": "text", "text": "Телефон:"}, small(base + "-mobile.png", 390),
             {"type": "text", "text": "Ты строгий арт-директор. Дай до 8 конкретных правок «что не так → как исправить». " + CHECK + " Без похвалы и вступлений."}]
    return ask(CRITIC, parts, f"e7-{tag}-crit", 8000)
def revise_rounds(tag, html, extra):
    for rnd in (1, 2):
        base = os.path.join(OUT, f"{tag}-r{rnd-1}"); render(html, base)
        crit = critique(base, f"{tag}-r{rnd}"); open(os.path.join(OUT, f"{tag}-crit{rnd}.md"), "w").write(crit)
        html = html_of(ask(BUILDER, task() + extra + [{"type": "text", "text": "Текущий код:\n```html\n" + html + "\n```"}, {"type": "text", "text": "Первый экран сейчас:"}, img(base + "-top.png"),
                                       {"type": "text", "text": "Вся страница сейчас:"}, small(base + "-full.jpg"), {"type": "text", "text": "Замечания арт-директора:\n" + crit + "\n\nИсправь. " + TECH}], f"e7-{tag}-rev{rnd}"))
    return html
def mockup(i, tag):
    prompt = ("High-fidelity web design mockup of a landing page for a small coffee shop in Moscow, desktop, full first screen and next sections, straight-on, no device frame. "
              f"All text in Russian. Client request: «{REQUEST}». Facts: coffee shop «Зерно», ул. Ленина, 12, open daily 8:00–22:00, coffee (эспрессо, капучино, латте, раф, фильтр), "
              "fresh pastry (круассаны, синнабоны), takeaway order via Telegram @zerno_coffee, phone +7 900 123-45-67. Distinctive, crafted, not a generic template.")
    r = requests.post(a6.BASE + "/v1/images/generations", headers={"Authorization": "Bearer " + a6._KEY, "Content-Type": "application/json"},
                      json={"model": "gpt-image-2.5", "prompt": prompt, "size": "1024x1536", "n": 1}, timeout=900)
    p = os.path.join(OUT, f"{tag}-mock{i}.png")
    try: open(p, "wb").write(base64.b64decode(r.json()["data"][0]["b64_json"])); return p
    except Exception: return None
def pick(mocks, tag):
    if len(mocks) == 1: return mocks[0], {}
    wins = {m: 0 for m in mocks}
    def judge(pe, a, b):
        parts = task() + [label(a, "КАНДИДАТ X"), label(b, "КАНДИДАТ Y"), {"type": "text", "text": "Какой макет лучше как основа сайта для этой кофейни? Ответь только JSON: {\"winner\": \"X\" или \"Y\"}"}]
        t = ask(pe, parts, f"e7-{tag}-pick", 8000); m = re.search(r'"(?:winner|better)"\s*:\s*"([XYХ])', t)
        return (a if m.group(1) == "X" else b) if m else None
    with cf.ThreadPoolExecutor(12) as ex:
        res = list(ex.map(lambda j: judge(*j), [(pe, a, b) for pe in PICKERS for a, b in itertools.permutations(mocks, 2)]))
    for w in res:
        if w: wins[w] += 1
    return max(mocks, key=lambda m: wins[m]), {os.path.basename(k): v for k, v in wins.items()}
def pipeline(variant, sample):
    tag = f"{variant}{sample}"; t0 = time.time(); info = {"variant": variant, "sample": sample}
    if variant == "a":
        html = html_of(ask(BUILDER, task() + photos() + [{"type": "text", "text": TECH}], f"e7-{tag}-build"))
        html = revise_rounds(tag, html, [])
    elif variant == "c":
        with cf.ThreadPoolExecutor(3) as ex: mocks = [m for m in ex.map(lambda i: mockup(i, tag), range(3)) if m]
        chosen, votes = pick(mocks, tag); info.update(mock=os.path.basename(chosen), mock_votes=votes, n_mocks=len(mocks))
        extra = [{"type": "text", "text": "Утверждённый макет (сверстай близко к нему; тексты и факты — только из запроса владельца, фото — из assets/):"}, img(chosen)]
        html = html_of(ask(BUILDER, task() + photos() + extra + [{"type": "text", "text": TECH}], f"e7-{tag}-build"))
        html = revise_rounds(tag, html, extra)
    else:  # d
        notes = ["Вариант 1 из 2.", "Вариант 2 из 2: другая композиция и другое настроение, не похожие на самое очевидное решение."]
        with cf.ThreadPoolExecutor(2) as ex:
            hs = list(ex.map(lambda n: html_of(ask(BUILDER, task() + photos() + [{"type": "text", "text": n + " " + TECH}], f"e7-{tag}-v{notes.index(n)+1}")), notes))
        bases = []
        for i, h in enumerate(hs):
            b = os.path.join(OUT, f"{tag}-v{i+1}"); render(h, b); bases.append(b)
        parts = task() + [{"type": "text", "text": "Вариант 1 (код):\n```html\n" + hs[0] + "\n```"}, small(bases[0] + "-full.jpg"),
                          {"type": "text", "text": "Вариант 2 (код):\n```html\n" + hs[1] + "\n```"}, small(bases[1] + "-full.jpg"),
                          {"type": "text", "text": "Сравни два варианта как арт-директор: коротко (до 6 пунктов) — что берёшь из каждого и что исправляешь, затем сверстай ГИБРИД. " + TECH}]
        raw = ask(BUILDER, parts, f"e7-{tag}-hybrid"); open(os.path.join(OUT, f"{tag}-hybrid-notes.md"), "w").write(raw.split("```html")[0][:4000])
        html = html_of(raw)
    info["render_final"] = render(html, os.path.join(OUT, f"{tag}-final")); info["secs"] = round(time.time() - t0)
    return info
def sheet(tag, L):
    from PIL import Image, ImageDraw, ImageFont
    full = Image.open(os.path.join(OUT, f"{tag}-final-full.jpg")).convert("RGB"); full = full.resize((1000, int(full.height * 1000 / full.width)))
    mob = Image.open(os.path.join(OUT, f"{tag}-final-mobile.png")).convert("RGB")
    W = 1000 + 40 + mob.width; H = 90 + max(full.height, mob.height)
    out = Image.new("RGB", (W, H), "white"); out.paste(full, (0, 90)); out.paste(mob, (1040, 90))
    ImageDraw.Draw(out).text((20, 14), f"Вариант {L}   (слева — компьютер, вся страница; справа — телефон)", fill="black", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 40))
    out.save(os.path.join(OUT, f"BLIND-{L}.jpg"), quality=82)
if __name__ == "__main__":
    t0 = time.time()
    # owner's photos, generated once and shared by all variants
    def photo(name, prompt):
        p = os.path.join(AS, name)
        if os.path.exists(p): return
        r = requests.post(a6.BASE + "/v1/images/generations", headers={"Authorization": "Bearer " + a6._KEY, "Content-Type": "application/json"},
                          json={"model": "gpt-image-2.5", "prompt": prompt + " Realistic phone photo by a small business owner, natural light, no text, no logos.", "size": "1536x1024", "n": 1}, timeout=900)
        from PIL import Image; import io
        Image.open(io.BytesIO(base64.b64decode(r.json()["data"][0]["b64_json"]))).convert("RGB").save(p, quality=85)
    with cf.ThreadPoolExecutor(3) as ex:
        list(ex.map(lambda a: photo(*a), [("cup.jpg", "A cappuccino with latte art on a wooden counter of a small Moscow coffee shop."),
                                          ("interior.jpg", "Interior of a small cozy coffee shop with a few tables, warm light, plants."),
                                          ("pastry.jpg", "Fresh croissants and cinnamon rolls on a bakery display in a small coffee shop.")]))
    with cf.ThreadPoolExecutor(6) as ex:
        infos = list(ex.map(lambda j: pipeline(*j), [(v, s) for v in "acd" for s in (1, 2)]))
    letters = list("ABCDEF"); random.Random("e7-blind").shuffle(letters)
    key = {f"{i['variant']}{i['sample']}": letters[n] for n, i in enumerate(infos)}
    for tag, L in key.items(): sheet(tag, L)
    json.dump({"key": key, "infos": infos, "t0": t0, "t1": time.time()}, open(os.path.join(OUT, "key-do-not-open.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(e6.LOG, open(os.path.join(OUT, "calls.json"), "w"), ensure_ascii=False, indent=1)
    print("done", round(time.time() - t0), [(i["variant"], i["sample"], i["secs"], i.get("mock_votes")) for i in infos])
