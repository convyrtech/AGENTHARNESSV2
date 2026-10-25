"""Какой из двух прототипов шага 5 лучше — моделью, но в обеих перестановках (research/28 §2.2, §4.4).

Модель в паре предвзята к месту: у сильных моделей согласованная точность 16–31 % при случайных 25 % (PerceptUI).
Поэтому лист собирается дважды — «1: A, 2: B» и «1: B, 2: A», — каждый идёт отдельным вызовом с одной картинкой, и выбор
засчитывается, только если оба ответа указывают на один и тот же прототип. Иначе — «не уверена»: рекомендации нет,
решает владелец. Модель — судейская (класс Opus, run.py).

  pair_pick.py --a <05-proto/a/index.html> --b <05-proto/b/index.html> --brief <файл> --pipeline <design-pipeline>
               --out <папка> [--proxy http://127.0.0.1:8787] [--model claude-opus-5-5]
Печатает JSON: {"winner": "a"|"b"|null, "answers": ["1"|"2"|null, …], "orders": [["a","b"],["b","a"]]}.
"""
import argparse, base64, io, json, re, subprocess, sys, urllib.request
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

ASK = ("Ниже два варианта одной страницы, «1» и «2» (слева телефон 390, справа компьютер 1440). Задача владельца:\n\n"
       "{brief}\n\nКакой вариант лучше решает эту задачу: понятнее, аккуратнее, ближе к бренду? Порядок вариантов на "
       "листе случайный и ничего не значит. Коротко объясни, последней строкой строго «ВЫБОР: 1» или «ВЫБОР: 2».")
CHOICE = re.compile(r"ВЫБОР\s*:\s*([12])")


def sheet(pipeline, py, pages, out):
    r = subprocess.run([py, "-I", str(Path(pipeline) / "tools" / "compare_sheet.py"), "--engine", "chromium",
                        "--labels", "1,2", *[x for p in pages for x in ("--variant", str(p))], "--out", str(out)],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode or not out.exists():
        raise RuntimeError("compare_sheet: " + (r.stdout + r.stderr)[-300:])
    return out


def image(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    k = 1568 / max(im.size)
    if k < 1:
        im = im.resize((int(im.width * k), int(im.height * k)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()}}


def ask(proxy, model, brief, png):
    body = {"model": model, "max_tokens": 2000, "messages": [{"role": "user", "content": [
        {"type": "text", "text": ASK.format(brief=brief)}, image(png)]}]}
    req = urllib.request.Request(proxy.rstrip("/") + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.loads(r.read().decode("utf-8", "replace"))
    text = "".join((c.get("message") or {}).get("content") or "" for c in data.get("choices") or [])
    m = CHOICE.findall(text)
    return m[-1] if m else None


def consistent(answers, orders):
    """Прототип, на который указали оба порядка; None — расходятся или нет ответа."""
    picks = [order[int(x) - 1] if x in ("1", "2") else None for x, order in zip(answers, orders)]
    return picks[0] if picks[0] and all(p == picks[0] for p in picks) else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--brief", required=True)
    ap.add_argument("--pipeline", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--proxy", default="http://127.0.0.1:8787")
    ap.add_argument("--model", default="claude-opus-5-5")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    brief = Path(a.brief).read_text(encoding="utf-8")[:3000] if Path(a.brief).exists() else "лендинг для владельца"
    pages = {"a": Path(a.a), "b": Path(a.b)}
    orders = [["a", "b"], ["b", "a"]]
    answers = []
    for i, order in enumerate(orders):
        png = sheet(a.pipeline, sys.executable, [pages[x] for x in order], out / f"pair-{i + 1}.png")
        answers.append(ask(a.proxy, a.model, brief, png))
    print(json.dumps({"winner": consistent(answers, orders), "answers": answers, "orders": orders}))


if __name__ == "__main__":
    main()
