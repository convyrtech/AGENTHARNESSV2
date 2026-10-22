"""E6 (fair protocol): screen «Готово» built 3 ways x 2 samples with identical inputs and budget.
a) direct  b) text spec first  c) gpt-image mockups -> picked by GPT-6.1 + Gemini 4 (pairwise, both orders) -> build to mockup.
All: builder Opus 5.5 (guaranteed pool), 2 rounds of render -> critique (GPT-6.1 vision, same prompt for all) -> revise."""
import sys, os, re, json, time, random, base64, itertools, subprocess, requests, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.dirname(HERE))
from lib import a6
OUT = os.path.join(HERE, "e6"); REF = os.path.join(os.path.dirname(HERE), "council", "inputs", "prsloy-b4.png")
BUILDER = ("claude-opus-5-5", {"reasoning_effort": "high"}); CRITIC = ("gpt-6.1-sol", {"reasoning_effort": "high"})
PICKERS = [("gpt-6.1-sol", {"reasoning_effort": "high"}), ("gemini-4-argon", {})]
BRIEF = """ЭКРАН: «Готово» — результат задачи в десктоп-приложении PRSLOY (ИИ-помощник для обычных людей, не технарей). Окно 1440×900.
Слева узкая колонка: логотип «PRSLOY» и точка «работает»; переключатель «Код» / «Креатив» / «Повседнев» (выбран «Креатив»); чаты «Сайт для кофейни» (активный), «Пост в Telegram», «Письмо арендатору»; внизу кнопка «Новый чат».
Сверху справа бюджет: механический счётчик «36,61» и «из 50 ₽ сегодня», линейка с делениями, последние 20% заштрихованы красным.
Основная часть — результат:
- заголовок «Готово: сайт для кофейни «Зерно»», под ним «Заняло 3 мин 12 с · потрачено 4,20 ₽»;
- превью сайта в рамке (упрощённая схема страницы кофейни, настоящая картинка не нужна);
- блок «Что сделано»: «Главная с меню и ценами», «Страница „Контакты“ с картой», «Кнопка „Заказать“ ведёт в Telegram»;
- блок «Что проверено»: «Открывается на телефоне», «Все ссылки работают», «Тексты без ошибок», «Загружается за 1,2 с» — у каждого отметка-штамп; и честный пункт «Не проверено: оплата онлайн — её не было в задаче»;
- кнопки «Открыть сайт» (главная), «Исправить что-то», «Опубликовать»; ссылка «Подробнее»;
- внизу поле ввода «Что поменять?» с кнопкой микрофона.
Пользователь — обычный человек: крупно, понятно, без воды, читается как 12-летним."""
BRAND = """БРЕНД PRSLOY (образец — приложенный скриншот нашего кабинета): тёплая эстетика старинного измерительного прибора / инженерного чертежа на бумаге.
Цвета: фон-бумага #f3eee3, карточки #faf7f0, чернила #3b2a1e (текст и тонкие рамки 1px), второстепенный текст #7a6352, линии #ddd2c1, акцент #a4472c, штамп #b23a26 (скупо).
Шрифты: заголовки — Piazzolla (с засечками), интерфейс — Geologica, мелкие подписи — моноширинный, заглавными, в рамке. Оба с кириллицей (Google Fonts).
Мотивы: механический счётчик с ячейками цифр, стрелочный индикатор, линейки с делениями, винтики в углах рамок, пунктир для пустых мест, штриховой рисунок прибора. Углы 2–4px.
Запрещено: градиенты, неон, стекло, фиолетовый, «карточки со статистикой», размытые тени."""
TECH = "Сверстай ОДИН самодостаточный HTML-файл (inline CSS, без JS-фреймворков; шрифты можно подключить с Google Fonts). Экран ровно 1440×900 без прокрутки. Верни только код в блоке ```html."
def img(path, mime=None):
    mime = mime or ("image/png" if path.endswith(".png") else "image/jpeg")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()}}
LOG = []
def ask(model_extra, parts, tag, max_tokens=64000):
    model, extra = model_extra
    body = {"model": model, "max_tokens": max_tokens, "stream_options": {"include_usage": True}, "messages": [{"role": "user", "content": parts}], **extra}
    for _ in range(3):
        try:
            r = a6.chat_stream(body, tag=f"e6-{tag}", timeout=1500)
        except Exception as e:
            continue
        ch = [c for c in r["chunks"] if isinstance(c, dict)]
        t = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in ch)
        rc = sum(len(((c.get("choices") or [{}])[0].get("delta") or {}).get("reasoning_content") or "") for c in ch)
        u = [c["usage"] for c in ch if c.get("usage")]
        if r["status"] == 200 and len(t.strip()) > 20:
            LOG.append({"tag": tag, "model": model, "secs": r["secs"], "reasoning_chars": rc, "in": u[-1].get("prompt_tokens") if u else None, "out": u[-1].get("completion_tokens") if u else None})
            return t
    return ""
def html_of(t):
    m = re.search(r"```html\s*(.*?)```", t, re.S) or re.search(r"(<!DOCTYPE html.*?</html>)", t, re.S | re.I)
    return m.group(1).strip() if m else t
def render(html, path):
    hp = path.replace(".png", ".html"); open(hp, "w").write(html)
    r = subprocess.run(["node", os.path.join(HERE, "shot1.mjs"), hp, path], capture_output=True, text=True, timeout=120)
    return r.stdout.strip()[-300:]
def build_parts(extra_parts):
    return [{"type": "text", "text": f"{BRIEF}\n\n{BRAND}"}, {"type": "text", "text": "Образец бренда:"}, img(REF)] + extra_parts
def critique(shot, tag):
    parts = [{"type": "text", "text": f"{BRIEF}\n\n{BRAND}"}, {"type": "text", "text": "Образец бренда:"}, img(REF), {"type": "text", "text": "Скриншот текущей вёрстки:"}, img(shot),
             {"type": "text", "text": "Ты строгий арт-директор. Сравни скриншот с брифом и образцом бренда. Дай до 8 конкретных правок списком «что не так → как исправить»: "
              "ошибки вёрстки и обрезанный текст, нарушения бренда, читаемость для обычного человека, недостающие элементы брифа, шаблонные штампы. Без похвалы, без вступления."}]
    return ask(CRITIC, parts, f"{tag}-crit", 8000)
MOCK_PROMPT = ("Use the attached screenshot ONLY as the style reference of our brand PRSLOY (colors, typography, hairline frames with rivets, mechanical counters, rulers, paper). "
               "Do NOT copy its layout or content. Draw a high-fidelity UI mockup of a NEW desktop app screen (straight-on, no device frame), ALL text in Russian exactly as given:\n")
def mockup(i, tag):
    with open(REF, "rb") as f:
        r = requests.post(a6.BASE + "/v1/images/edits", headers={"Authorization": "Bearer " + a6._KEY},
                          files={"image": ("ref.png", f, "image/png")}, data={"model": "gpt-image-2.5", "prompt": MOCK_PROMPT + BRIEF + "\n" + BRAND, "size": "1536x1024", "n": "1"}, timeout=900)
    p = os.path.join(OUT, f"{tag}-mock{i}.png")
    try:
        d = r.json()["data"][0]; open(p, "wb").write(base64.b64decode(d["b64_json"])); return p
    except Exception:
        return None
def label(path, text):
    from PIL import Image, ImageDraw, ImageFont
    import io
    im = Image.open(path).convert("RGB"); im = im.resize((1400, int(im.height * 1400 / im.width)))
    out = Image.new("RGB", (im.width, im.height + 90), "white"); out.paste(im, (0, 90))
    ImageDraw.Draw(out).text((20, 15), text, fill="black", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 56))
    b = io.BytesIO(); out.save(b, "JPEG", quality=90)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()}}
def pick(mocks, tag):
    wins = {m: 0 for m in mocks}
    def judge(pe, a, b):
        parts = [{"type": "text", "text": BRIEF}, label(REF, "ОБРАЗЕЦ БРЕНДА — НЕ КАНДИДАТ"), label(a, "КАНДИДАТ X"), label(b, "КАНДИДАТ Y"),
                 {"type": "text", "text": "Какой макет лучше как основа для вёрстки этого экрана? Ответь только JSON: {\"winner\": \"X\" или \"Y\"}"}]
        t = ask(pe, parts, f"{tag}-pick", 8000); m = re.search(r'"(?:winner|better)"\s*:\s*"([XY])', t)
        return (a if m.group(1) == "X" else b) if m else None
    with cf.ThreadPoolExecutor(12) as ex:
        res = list(ex.map(lambda j: judge(*j), [(pe, a, b) for pe in PICKERS for a, b in itertools.permutations(mocks, 2)]))
    for w in res:
        if w: wins[w] += 1
    return max(mocks, key=lambda m: wins[m]), {os.path.basename(k): v for k, v in wins.items()}
def pipeline(variant, sample):
    tag = f"{variant}{sample}"; t0 = time.time(); info = {"variant": variant, "sample": sample}
    extra = []
    if variant == "b":
        spec = ask(BUILDER, build_parts([{"type": "text", "text": "Сначала напиши подробную спецификацию этого экрана для верстальщика: сетка и размеры в px, иерархия, компоненты, состояния, шрифты и кегли, цвета, отступы, все тексты. Только спецификация, без кода."}]), f"{tag}-spec", 32000)
        open(os.path.join(OUT, f"{tag}-spec.md"), "w").write(spec); extra = [{"type": "text", "text": "СПЕЦИФИКАЦИЯ ЭКРАНА (следуй ей):\n" + spec}]
    if variant == "c":
        with cf.ThreadPoolExecutor(3) as ex: mocks = [m for m in ex.map(lambda i: mockup(i, tag), range(3)) if m]
        chosen, wins = pick(mocks, tag); info["mock_votes"] = wins; info["mock"] = os.path.basename(chosen)
        extra = [{"type": "text", "text": "УТВЕРЖДЁННЫЙ МАКЕТ ЭКРАНА (сверстай максимально близко к нему, тексты — строго из брифа):"}, img(chosen)]
    html = html_of(ask(BUILDER, build_parts(extra + [{"type": "text", "text": TECH}]), f"{tag}-build"))
    for rnd in range(1, 3):
        shot = os.path.join(OUT, f"{tag}-r{rnd-1}.png"); info[f"render{rnd-1}"] = render(html, shot)
        crit = critique(shot, f"{tag}-r{rnd}"); open(os.path.join(OUT, f"{tag}-crit{rnd}.md"), "w").write(crit)
        html = html_of(ask(BUILDER, build_parts(extra + [{"type": "text", "text": "Текущая вёрстка (код):\n```html\n" + html + "\n```"},
                       {"type": "text", "text": "Её скриншот:"}, img(shot), {"type": "text", "text": "Замечания арт-директора:\n" + crit + "\n\nИсправь вёрстку. " + TECH}]), f"{tag}-rev{rnd}"))
    final = os.path.join(OUT, f"{tag}-final.png"); info["render_final"] = render(html, final); info["secs"] = round(time.time() - t0)
    return info
if __name__ == "__main__":
    t0 = time.time()
    with cf.ThreadPoolExecutor(6) as ex:
        infos = list(ex.map(lambda j: pipeline(*j), [(v, s) for v in "abc" for s in (1, 2)]))
    letters = list("ABCDEF"); random.Random("e6-blind").shuffle(letters)
    key = {f"{i['variant']}{i['sample']}": letters[n] for n, i in enumerate(infos)}
    from PIL import Image, ImageDraw, ImageFont
    for tag, L in key.items():
        im = Image.open(os.path.join(OUT, f"{tag}-final.png")).convert("RGB")
        out = Image.new("RGB", (im.width, im.height + 80), "white"); out.paste(im, (0, 80))
        ImageDraw.Draw(out).text((24, 12), f"Вариант {L}", fill="black", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 52))
        out.save(os.path.join(OUT, f"BLIND-{L}.png"))
    json.dump({"key": key, "infos": infos, "t0": t0, "t1": time.time()}, open(os.path.join(OUT, "key-do-not-open.json"), "w"), ensure_ascii=False, indent=1)
    json.dump(LOG, open(os.path.join(OUT, "calls.json"), "w"), ensure_ascii=False, indent=1)
    print("done", round(time.time() - t0), "s", [(i["variant"], i["sample"], i["secs"]) for i in infos])
