"""Pairwise design selection with labels burned into images, both orders, several vision models.
Agreement with the owner's pick (#2 > #1 > #3) is the metric."""
import sys, os, json, re, base64, io, itertools, concurrent.futures as cf
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib import a6
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(os.path.dirname(HERE), "council", "inputs", "prsloy-b4.png")
CANDS = {"1": "mockups/prsloy-t1.png", "2": "mockups/prsloy-r1.png", "3": "mockups/prsloy-nb1.png"}
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def labelled(path, label, maxw=1400):
    im = Image.open(path).convert("RGB")
    if im.width > maxw: im = im.resize((maxw, int(im.height * maxw / im.width)))
    bar = 90; out = Image.new("RGB", (im.width, im.height + bar), "white"); out.paste(im, (0, bar))
    d = ImageDraw.Draw(out)
    try: f = ImageFont.truetype(FONT, 56)
    except OSError: f = ImageFont.load_default()
    d.text((20, 15), label, fill="black", font=f)
    b = io.BytesIO(); out.save(b, "JPEG", quality=90)
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()}}
MODELS = {"opus": ("claude-opus-5-5", {"reasoning_effort": "high"}), "gemini4": ("gemini-4-argon", {}), "gpt61": ("gpt-6.1-sol", {"reasoning_effort": "high"})}
Q = ("На первой картинке (подпись «ОБРАЗЕЦ БРЕНДА — НЕ КАНДИДАТ») — наш существующий кабинет PRSLOY. На двух следующих — кандидаты X и Y: макеты главного окна "
     "нашего десктоп-приложения ИИ-помощника для обычных людей (не технарей). Какой макет взять за основу вёрстки? Критерии: похож на бренд; сдержанность "
     "(в приложении сидят часами); реально сверстать кодом на 80–90%; читаемость для казуала; ошибки (опечатки, английский текст). "
     "Ответь только JSON: {\"winner\": \"X\" или \"Y\", \"why\": \"одно предложение\"}")
def judge(model_key, a, b):
    model, extra = MODELS[model_key]
    parts = [labelled(REF, "ОБРАЗЕЦ БРЕНДА — НЕ КАНДИДАТ"), labelled(os.path.join(HERE, CANDS[a]), "КАНДИДАТ X"),
             labelled(os.path.join(HERE, CANDS[b]), "КАНДИДАТ Y"), {"type": "text", "text": Q}]
    body = {"model": model, "max_tokens": 16000, "stream_options": {"include_usage": True}, "messages": [{"role": "user", "content": parts}], **extra}
    for _ in range(2):
        r = a6.chat_stream(body, tag=f"pick2-{model_key}-{a}{b}", timeout=900)
        t = "".join(((c.get("choices") or [{}])[0].get("delta") or {}).get("content") or "" for c in r["chunks"] if isinstance(c, dict))
        m = re.search(r"\{.*?\}", t, re.S)
        if m:
            try:
                j = json.loads(m.group(0)); w = (j.get("winner") or j.get("better") or "").strip().upper()[:1]
                if w in "XY": return {"model": model_key, "x": a, "y": b, "winner": a if w == "X" else b, "why": j.get("why") or j.get("reason")}
            except ValueError: pass
    return {"model": model_key, "x": a, "y": b, "winner": None, "raw": t[:200]}
if __name__ == "__main__":
    jobs = [(m, a, b) for m in MODELS for a, b in itertools.permutations("123", 2)]
    with cf.ThreadPoolExecutor(9) as ex: res = list(ex.map(lambda j: judge(*j), jobs))
    json.dump(res, open(os.path.join(HERE, "pick2-results.json"), "w"), ensure_ascii=False, indent=1)
    owner_better = {("2", "1"), ("2", "3"), ("1", "3")}  # owner/Claude ranking 2 > 1 > 3
    for m in MODELS:
        rs = [r for r in res if r["model"] == m]
        wins = {k: sum(r["winner"] == k for r in rs) for k in "123"}
        agree = sum(1 for r in rs if r["winner"] and (r["winner"], r["y"] if r["winner"] == r["x"] else r["x"]) in owner_better)
        consist = sum(1 for a, b in itertools.combinations("123", 2)
                      if (x := next((r["winner"] for r in rs if (r["x"], r["y"]) == (a, b)), None)) and x == next((r["winner"] for r in rs if (r["x"], r["y"]) == (b, a)), None))
        print(f"{m}: wins {wins} | agree with owner {agree}/6 | same answer in both orders {consist}/3 | none {sum(r['winner'] is None for r in rs)}")
