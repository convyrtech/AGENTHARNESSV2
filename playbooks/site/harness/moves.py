"""Шаг 1 без чужих роликов: три набора приёмов движения в цветах и словах владельца (лист + короткие видео).

Живой прогон 25.10: шаг 1 показал владельцу три одиночных кадра чужих видео, вариант A — почти пустой кадр с
кнопкой; выбрать было не из чего, ответ «как рекомендуешь». Здесь кандидаты — наши готовые приёмы
(`playbooks/site/motion`: VOCAB.md, vocab.json, motion.js, demo/index.html), снятые в токенах бренда и с
текстами из FACTS/анкеты.

  moves.py candidates --page design/<p>            01-cands/{A,B,C}.png + {A,B,C}.mp4 → 01-candidates.png (+ .json)
  moves.py pick --page design/<p> --pack A          01-frames/, 01-teardown.md, 01-pack.json

Входы агента (необязательные, иначе значения по умолчанию с предупреждением):
  01-cands/words.json   {"num": "1 250 ₽", "step1": "…", …} — слова владельца для демо (ключи — WORD_KEYS)
  01-cands/packs.json   {"A": {"name": "…", "rule": "одно правило-метафора", "why": "…", "moves": ["ringHead", …]}, …}
Токены: из 02-brand.md, если он уже есть; иначе из палитры материалов владельца (palette.py по materials/*).
Браузер: Playwright Chromium; DP_BROWSER_CHANNEL=msedge — установленный Edge (как в инструментах пайплайна).
Видео: ffmpeg из imageio-ffmpeg (ставится вместе с инструментами дизайна), из FFMPEG или из PATH.
"""
import argparse, colorsys, contextlib, functools, http.server, json, os, re, shutil, subprocess, sys, tempfile
import threading
from pathlib import Path

for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent

# компонент motion.js → id секции в demo/index.html
SECTION = {"ringHead": "ring", "odometer": "odometer", "stepsRail": "rail", "slotLift": "slot", "stamp": "stamp",
           "morph": "morph", "director": "director", "trailDot": "trail", "lineWord": "lineword",
           "shutter": "shutter", "dotCascade": "cascade"}
MAIN = ("ringHead", "director", "trailDot", "shutter", "lineWord")      # главный приём набора: ровно один
DEFAULT_PACKS = {
    "A": {"name": "Кольцо и счёт", "moves": ["ringHead", "odometer", "stepsRail"],
          "rule": "Одна линия обводит главное: кольцо вокруг цифры, цифра докручивается, шаги заливаются по очереди.",
          "why": "Главное на странице — число и три шага до него."},
    "B": {"name": "Выдача с печатью", "moves": ["lineWord", "slotLift", "stamp"],
          "rule": "Всё выдаётся из-под кромки: слово поднимается из-под линии, карточка выезжает, печать ставит точку.",
          "why": "Страница про то, что человек получает на руки."},
    "C": {"name": "Тропа к кнопке", "moves": ["trailDot", "morph"],
          "rule": "Одна точка ведёт по тропе от шага к шагу и превращается в нажатую кнопку.",
          "why": "Страница ведёт к одному действию."},
}
# ключ → текст по умолчанию (как в demo/index.html); числа нужны odometer'у
WORD_KEYS = {
    "num": "32,41 ₽", "step1": "Войдите", "step1Sub": "почта или Telegram", "step2": "Получите ключ",
    "step2Sub": "его видно один раз", "step3": "Вставьте адрес", "step3Sub": "api.prsloy.online/v1",
    "limitLabel": "лимит ключа на день", "limit": "1 250 ₽", "cardTag": "ключ «работа»", "cardMain": "sk-prs-…7qF2",
    "cardSub": "Claude Code", "stamp": "КЛЮЧ ВЫДАН", "liftTag": "новый ключ", "liftMain": "sk-prs-…7qF2",
    "node1": "вход", "node2": "ключ", "node3": "адрес", "copyLine": "https://api.prsloy.online/v1",
    "copyBtn": "Скопировать адрес", "pickLabel": "+12 рядом", "slogan": "Расход в ", "sloganRise": "рублях",
    "chapter1": "Глава 1", "chapter2": "Глава 2", "scene1Tag": "ключ", "scene1": "Ключ на программу",
    "scene2Tag": "лимит", "scene2": "Лимит в рублях на день", "scene3Tag": "расход", "scene3": "Расход видно сразу",
    "sceneNum": "50 ₽", "sceneStamp": "ЛИМИТ ЗАДАН",
}
NUMERIC_WORDS = ("num", "limit", "sceneNum")
# какие слова видны в каком приёме (предупреждение о пропущенных — только для приёмов наборов)
WORDS_OF = {"ringHead": ["num"], "stepsRail": ["step1", "step1Sub", "step2", "step2Sub", "step3", "step3Sub"],
            "odometer": ["limitLabel", "limit"], "stamp": ["cardTag", "cardMain", "cardSub", "stamp"],
            "slotLift": ["liftTag", "liftMain"], "trailDot": ["node1", "node2", "node3"], "morph": ["copyLine", "copyBtn"],
            "dotCascade": ["pickLabel"], "lineWord": ["slogan", "sloganRise"], "shutter": ["chapter1", "chapter2"],
            "director": ["scene1Tag", "scene1", "scene2Tag", "scene2", "scene3Tag", "scene3", "sceneNum", "sceneStamp"]}
FRAMES_SHEET = (0.12, 0.4, 0.7, 1.0)                      # 4 кадра на приём в листе набора
# кнопка-морф с первого же кадра сжимается и режет надпись: её лист начинается с целой кнопки
FRAMES_SHEET_OF = {"morph": (0.0, 0.3, 0.6, 1.0)}
FRAMES_PICK = (0.0, 0.17, 0.33, 0.5, 0.67, 0.83, 1.0)     # 7 точек на приём в 01-frames/
VW, VH, DPR = 390, 844, 2
FPS = 30
DEFAULT_TOKENS = {"paper": "#f4f1ea", "card": "#fbf9f4", "ink": "#2b2622", "mid": "#6f665e", "line": "#dcd5ca",
                  "accent": "#b4532a", "stamp": "#b4532a"}


def warn(msg):
    print(f"moves.py: внимание: {msg}")


def die(msg):
    print(f"moves.py: {msg}")
    sys.exit(1)


# ---------- paths ----------
class Ws:
    def __init__(self, page_arg, motion=None, pipeline=None):
        self.page = Path(page_arg).resolve()
        if not self.page.is_dir():
            die(f"нет папки страницы {self.page}")
        self.root = self.page.parent.parent if self.page.parent.name == "design" else self.page.parent
        self.slug = re.sub(r"[^a-z0-9-]", "", self.page.name.lower()) or "page"
        self.pipe = Path(pipeline).resolve() if pipeline else self.root / "design-pipeline"
        cand = [Path(motion)] if motion else [self.pipe / "motion", HERE.parent / "motion"]
        self.motion = next((c.resolve() for c in cand if (c / "motion.js").exists()), None)
        if not self.motion:
            die("нет библиотеки движения (design-pipeline/motion или playbooks/site/motion)")
        self.cands = self.page / "01-cands"

    def tool(self, name):
        p = self.pipe / "tools" / name
        return p if p.exists() else None


# ---------- vocabulary and packs ----------
def vocab(ws):
    data = json.loads((ws.motion / "vocab.json").read_text(encoding="utf-8"))
    by = {m["component"]: m for m in data["moves"] if m.get("component")}
    mech = {}
    for ln in (ws.motion / "VOCAB.md").read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if len(cells) >= 7 and cells[-1].strip("`") in by:
            mech[cells[-1].strip("`")] = {"when": cells[2], "how": cells[3], "tempo": cells[4], "risk": cells[5]}
    for k, m in by.items():
        m.update({f"md_{x}": y for x, y in mech.get(k, {}).items()})
    return by


def validate_packs(packs, known):
    """Rules of VOCAB.md «Как выбирать» in code. Returns a list of problems."""
    pr = []
    if sorted(packs) != ["A", "B", "C"]:
        pr.append(f"нужны наборы A, B, C, есть {sorted(packs)}")
    for key, p in packs.items():
        mv = p.get("moves") or []
        if not 2 <= len(mv) <= 3:
            pr.append(f"набор {key}: приёмов {len(mv)}, нужно 2–3")
        bad = [m for m in mv if m not in known or m not in SECTION]
        if bad:
            pr.append(f"набор {key}: нет готовых компонентов {bad}")
        if len(set(mv)) != len(mv):
            pr.append(f"набор {key}: приём повторяется")
        mains = [m for m in mv if m in MAIN]
        if len(mains) != 1:
            pr.append(f"набор {key}: главный приём должен быть ровно один из {', '.join(MAIN)}, есть {mains or 'ни одного'}")
        if "trailDot" in mv and "stepsRail" in mv:
            pr.append(f"набор {key}: тропа и рельс — про одно и то же, берём один из двух")
        for f in ("name", "rule"):
            if not str(p.get(f, "")).strip():
                pr.append(f"набор {key}: пустое поле {f}")
    keys = sorted(packs)
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            common = set(packs[a].get("moves", [])) & set(packs[b].get("moves", []))
            if len(common) > 1:
                pr.append(f"наборы {a} и {b} делят {len(common)} приёма ({sorted(common)}), можно не больше одного")
    return pr


def load_packs(ws, known):
    f = ws.cands / "packs.json"
    if f.exists():
        try:
            packs = json.loads(f.read_text(encoding="utf-8"))
        except ValueError as e:
            die(f"01-cands/packs.json не читается: {e}")
        for p in packs.values():
            p["moves"] = [m for m in p.get("moves", []) if isinstance(m, str)]
    else:
        warn("нет 01-cands/packs.json: беру наборы по умолчанию A, B, C (запиши свои под страницу)")
        packs = json.loads(json.dumps(DEFAULT_PACKS, ensure_ascii=False))
    pr = validate_packs(packs, known)
    if pr:
        die("наборы не годятся:\n  " + "\n  ".join(pr))
    return packs


def validate_words(words):
    """(problems, warnings) for 01-cands/words.json."""
    pr, wn = [], []
    if not isinstance(words, dict):
        return ["words.json: нужен объект {ключ: текст}"], wn
    for k, v in words.items():
        if k not in WORD_KEYS:
            pr.append(f"words.json: неизвестный ключ «{k}» (есть: {', '.join(WORD_KEYS)})")
        elif not isinstance(v, str) or not v.strip():
            pr.append(f"words.json: «{k}» должен быть непустой строкой")
        elif len(v) > 80:
            pr.append(f"words.json: «{k}» длиннее 80 знаков — на телефоне не влезет")
        elif k in NUMERIC_WORDS and not re.search(r"\d", v):
            pr.append(f"words.json: «{k}» — число для «числа с торможением», в «{v}» нет цифр")
        elif re.search(r"[<>]|\bTODO\b|lorem", v, re.I):
            pr.append(f"words.json: «{k}» похоже на заглушку: «{v}»")
    return pr, wn


def load_words(ws, moves_used):
    f = ws.cands / "words.json"
    words = {}
    if f.exists():
        try:
            words = json.loads(f.read_text(encoding="utf-8"))
        except ValueError as e:
            die(f"01-cands/words.json не читается: {e}")
        pr, _ = validate_words(words)
        if pr:
            die("слова не годятся:\n  " + "\n  ".join(pr))
    else:
        warn("нет 01-cands/words.json: на кадрах будут слова демо, а не владельца (возьми из FACTS.md и анкеты)")
    need = sorted({k for m in moves_used for k in WORDS_OF.get(m, [])} - set(words))
    if f.exists() and need:
        warn(f"в words.json нет ключей {', '.join(need)}: там останутся слова демо")
    return words


# ---------- colour ----------
def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def rgb_hex(c):
    return "#" + "".join(f"{max(0, min(255, round(x))):02x}" for x in c)


def mix(a, b, t):
    return rgb_hex([x + (y - x) * t for x, y in zip(hex_rgb(a), hex_rgb(b))])


def lum(h):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(v) for v in hex_rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def lightness(h):
    return 116 * (lum(h) ** (1 / 3) if lum(h) > 0.008856 else 7.787 * lum(h) + 16 / 116) - 16


def chroma(h):
    r, g, b = (v / 255 for v in hex_rgb(h))
    return colorsys.rgb_to_hls(r, g, b)[2] * (1 - abs(2 * colorsys.rgb_to_hls(r, g, b)[1] - 1))


def tokens_from_palette(colors):
    """colors: [{"hex", "share"}] from palette.py → paper/ink/accent (+ mixed mid/line/card)."""
    hexes = [c["hex"] for c in colors if isinstance(c, dict) and re.match(r"^#[0-9a-fA-F]{6}$", str(c.get("hex", "")))]
    if not hexes:
        return dict(DEFAULT_TOKENS), ["в палитре нет цветов: токены по умолчанию"]
    notes = []
    paper = max(hexes, key=lightness)
    ink = min(hexes, key=lightness)
    mids = [h for h in hexes if 30 <= lightness(h) <= 75] or hexes
    accent = max(mids, key=chroma)
    if lightness(paper) < 85:                                   # бумага должна быть светлой: подсветляем до читаемой
        paper = mix(paper, "#ffffff", 0.75)
        notes.append("самый светлый цвет материалов тёмный: бумага подсветлена к белому")
    if contrast(ink, paper) < 7:
        ink = mix(ink, "#000000", 0.6)
        notes.append("самый тёмный цвет материалов слабо читается на бумаге: чернила затемнены")
    if chroma(accent) < 0.15 or contrast(accent, paper) < 3:
        accent = DEFAULT_TOKENS["accent"] if contrast(DEFAULT_TOKENS["accent"], paper) >= 3 else ink
        notes.append("в материалах нет яркого цвета средней светлоты: акцент по умолчанию")
    t = {"paper": paper, "ink": ink, "accent": accent, "stamp": accent, "card": mix(paper, "#ffffff", 0.5),
         "mid": mix(ink, paper, 0.4), "line": mix(ink, paper, 0.8)}
    return t, notes


def tokens_from_brand(md):
    """--name: #hex in 02-brand.md (table rows or CSS)."""
    alias = {"paper": ("paper", "bg", "background", "фон"), "ink": ("ink", "text", "fg"), "accent": ("accent",),
             "mid": ("mid", "muted"), "line": ("line", "border", "rule"), "card": ("card", "surface"), "stamp": ("stamp",)}
    found = {}
    for name, hx in re.findall(r"--([a-z-]+)\W{1,12}?(#[0-9a-fA-F]{6})\b", md):
        for tok, names in alias.items():
            if name in names and tok not in found:
                found[tok] = hx.lower()
    return found


def brand_tokens(ws):
    notes = []
    brand = ws.page / "02-brand.md"
    if brand.exists():
        found = tokens_from_brand(brand.read_text(encoding="utf-8"))
        if {"paper", "ink", "accent"} <= set(found):
            t = {**DEFAULT_TOKENS, **found}
            t.setdefault("stamp", t["accent"])
            t["card"] = found.get("card", mix(t["paper"], "#ffffff", 0.5))
            t["mid"] = found.get("mid", mix(t["ink"], t["paper"], 0.4))
            t["line"] = found.get("line", mix(t["ink"], t["paper"], 0.8))
            return t, "02-brand.md", notes
        # шаблон 02-brand.md от flow.py --init без токенов — обычное дело до шага 2: тихо берём палитру
    imgs = sorted(p for p in (ws.root / "materials").glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
    tool = ws.tool("palette.py")
    colors = []
    if imgs and tool:
        out = ws.cands / "palette"
        for img in imgs[:6]:
            r = subprocess.run([sys.executable, "-I", str(tool), str(img), "--k", "6", "--out", str(out)],
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            pj = out / f"palette-{img.stem}.json"
            if r.returncode == 0 and pj.exists():
                colors += json.loads(pj.read_text(encoding="utf-8")).get("colors", [])
            else:
                notes.append(f"palette.py не разобрал {img.name}: {(r.stdout + r.stderr)[-160:]}")
    elif not imgs:
        notes.append("в materials/ нет картинок: токены по умолчанию (пришлёт логотип — пересними)")
    else:
        notes.append("нет design-pipeline/tools/palette.py: токены по умолчанию")
    if not colors:
        return dict(DEFAULT_TOKENS), "по умолчанию", notes
    t, n2 = tokens_from_palette(colors)
    return t, f"палитра материалов ({len(imgs)} файл.)", notes + n2


def write_brand(ws, tokens, source):
    css = ws.motion / "brands" / f"{ws.slug}.css"
    fonts = "../demo/fonts"
    css.write_text(
        f"/* {ws.slug}: токены для шага 1 (moves.py), источник: {source} */\n"
        f'@font-face {{ font-family: "Piazzolla"; src: url("{fonts}/Piazzolla-VF.ttf") format("truetype"); '
        "font-weight: 300 700; font-display: swap; }\n"
        f'@font-face {{ font-family: "Geologica"; src: url("{fonts}/Geologica-VF.ttf") format("truetype"); '
        "font-weight: 300 600; font-display: swap; }\n"
        f'@font-face {{ font-family: "IBM Plex Mono"; src: url("{fonts}/IBMPlexMono-Regular.ttf") format("truetype"); '
        "font-weight: 400; font-display: swap; }\n"
        ":root {\n"
        f"  --paper: {tokens['paper']}; --card: {tokens['card']}; --ink: {tokens['ink']}; --mid: {tokens['mid']}; "
        f"--line: {tokens['line']}; --accent: {tokens['accent']}; --stamp: {tokens['stamp']};\n"
        '  --head: "Piazzolla", Georgia, serif; --body: "Geologica", system-ui, sans-serif; '
        '--mono: "IBM Plex Mono", ui-monospace, monospace;\n'
        "  --m-ink: var(--ink); --m-accent: var(--accent); --m-paper: var(--card); --m-line: var(--line);\n"
        "  --m-stroke: 1.4px; --m-ease: cubic-bezier(.22, 1, .36, 1); --m-num: var(--mono);\n"
        "  --radius: 2px;\n}\n", encoding="utf-8")
    return css


def write_words(ws, words):
    js = ws.motion / "brands" / f"{ws.slug}.words.js"
    js.write_text("window.WORDS = " + json.dumps(words, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")
    return js


# ---------- rendering ----------
@contextlib.contextmanager
def serve(root):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


@contextlib.contextmanager
def browser():
    from playwright.sync_api import sync_playwright
    ch = os.environ.get("DP_BROWSER_CHANNEL")
    with sync_playwright() as p:
        b = p.chromium.launch(**({"channel": ch} if ch else {}))
        try:
            yield b
        finally:
            b.close()


class Stage:
    """One move of the demo on a 390×844 phone, frozen at any t via Motion.seek."""

    def __init__(self, b, base, slug, comp):
        self.comp = comp
        self.pg = b.new_page(viewport={"width": VW, "height": VH}, device_scale_factor=DPR)
        self.pg.goto(f"{base}/demo/index.html?brand={slug}&words={slug}&move={SECTION[comp]}&t=0")
        self.pg.evaluate("() => document.fonts.ready")
        self.pg.wait_for_timeout(300)
        sel = ".scene .m-stage" if comp == "director" else f"#{SECTION[comp]} .stage"
        self.box = self.pg.evaluate("""(s) => { const r = document.querySelector(s).getBoundingClientRect();
            return {x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth),
                    height: Math.min(r.height, innerHeight - Math.max(0, r.y))}; }""", sel)
        self.dur = self.pg.evaluate("""(c) => { const l = Motion.list();
            const i = c === 'director' ? l.find(x => x.name === 'director') : l.find(x => x.name === c && !x.driven);
            return i ? (i.dur || 2400) : 1000; }""", comp)

    def frame(self, t, path=None):
        from PIL import Image
        import io
        self.pg.evaluate("(t) => Motion.seek(t)", t)
        self.pg.wait_for_timeout(40)
        png = self.pg.screenshot(clip=self.box)
        if path:
            Path(path).write_bytes(png)
        return Image.open(io.BytesIO(png)).convert("RGB")

    def close(self):
        self.pg.close()


def font(ws, size, mono=False):
    from PIL import ImageFont
    name = "IBMPlexMono-Regular.ttf" if mono else "Geologica-VF.ttf"
    try:
        return ImageFont.truetype(str(ws.motion / "demo" / "fonts" / name), size)
    except OSError:
        return ImageFont.load_default()


def wrap(draw, text, fnt, width):
    lines, cur = [], ""
    for word in text.split():
        nxt = f"{cur} {word}".strip()
        if draw.textlength(nxt, font=fnt) <= width or not cur:
            cur = nxt
        else:
            lines.append(cur)
            cur = word
    return lines + ([cur] if cur else [])


def pack_sheet(ws, key, pack, rows, voc, tokens, out):
    """rows: [(comp, [frames])] → one sheet: letter, name, rule; a row of 4 frames per move."""
    from PIL import Image, ImageDraw
    cell = 300
    pad = 28
    gap = 14
    ims = [[f.resize((cell, max(1, round(f.height * cell / f.width)))) for f in fr] for _, fr in rows]
    row_h = [max(i.height for i in r) for r in ims]
    W = pad * 2 + len(FRAMES_SHEET) * cell + (len(FRAMES_SHEET) - 1) * gap
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    rule = wrap(probe, pack["rule"], font(ws, 26), W - 2 * pad)
    head = 70 + 36 * len(rule) + 18
    H = head + sum(h + 52 for h in row_h) + pad
    sheet = Image.new("RGB", (W, H), hex_rgb(tokens["paper"]))
    d = ImageDraw.Draw(sheet)
    ink, mid, line = hex_rgb(tokens["ink"]), hex_rgb(tokens["mid"]), hex_rgb(tokens["line"])
    d.text((pad, 22), f"{key} · {pack['name']}", fill=ink, font=font(ws, 40))
    for i, ln in enumerate(rule):
        d.text((pad, 76 + 36 * i), ln, fill=mid, font=font(ws, 26))
    y = head
    for (comp, _), r, h in zip(rows, ims, row_h):
        d.line((pad, y, W - pad, y), fill=line, width=2)
        d.text((pad, y + 12), f"{voc[comp]['name']}", fill=ink, font=font(ws, 24))
        x = pad
        for im in r:
            sheet.paste(im, (x, y + 46))
            x += cell + gap
        y += h + 52
    sheet.save(out)
    return out


def ffmpeg_exe():
    if os.environ.get("FFMPEG") and Path(os.environ["FFMPEG"]).exists():
        return os.environ["FFMPEG"]
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


def pack_video(clips, tokens, out):
    """clips: [[PIL frames]] per move → one mp4, frames centred on the paper colour (animated .webp without ffmpeg)."""
    from PIL import Image
    W = max(f.width for c in clips for f in c)
    H = max(f.height for c in clips for f in c)
    W, H = W + W % 2, H + H % 2
    bg = hex_rgb(tokens["paper"])
    frames = []
    for c in clips:
        for f in c:
            can = Image.new("RGB", (W, H), bg)
            can.paste(f, ((W - f.width) // 2, (H - f.height) // 2))
            frames.append(can)
    exe = ffmpeg_exe()
    if not exe:
        webp = out.with_suffix(".webp")
        frames[0].save(webp, save_all=True, append_images=frames[1:], duration=round(1000 / FPS), loop=0, quality=80)
        warn(f"нет ffmpeg (imageio-ffmpeg): вместо mp4 анимированный {webp.name}")
        return webp
    with tempfile.TemporaryDirectory() as td:
        for i, f in enumerate(frames):
            f.save(os.path.join(td, f"f{i:05d}.png"))
        r = subprocess.run([exe, "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(td, "f%05d.png"),
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart",
                            str(out)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode:
            die(f"ffmpeg: {r.stderr[-300:]}")
    return out


def clip_frames(stage):
    """Video frames of one move: its own duration at 30 fps, then half a second on the final state, at 2× (retina)."""
    n = max(12, round(stage.dur / 1000 * FPS))
    return [stage.frame(min(1.0, i / max(1, n - 1))) for i in range(n + FPS // 2)]


def set_field(page, name, value):
    st = page / "STATUS.md"
    if not st.exists():
        return
    t = st.read_text(encoding="utf-8")
    m = re.search(rf"(?m)^- {re.escape(name)}:(.*)$", t)
    cur = m.group(1).strip() if m else ""
    if cur and cur not in ("...", "…") and not (cur.startswith("<") and cur.endswith(">")):
        return                                       # уже заполнено человеком или агентом: не трогаем
    line = f"- {name}: {value}"
    t = t.replace(m.group(0), line) if m else t.rstrip("\n") + "\n" + line + "\n"
    st.write_text(t, encoding="utf-8")


# ---------- commands ----------
def candidates(a):
    ws = Ws(a.page, a.motion, a.pipeline)
    ws.cands.mkdir(parents=True, exist_ok=True)
    voc = vocab(ws)
    packs = load_packs(ws, voc)
    used = [m for k in sorted(packs) for m in packs[k]["moves"]]
    words = load_words(ws, used)
    tokens, source, notes = brand_tokens(ws)
    for n in notes:
        warn(n)
    write_brand(ws, tokens, source)
    write_words(ws, words)
    variants, videos = [], {}
    with serve(ws.motion) as base, browser() as b:
        for key in sorted(packs):
            rows, clips = [], []
            for comp in packs[key]["moves"]:
                st = Stage(b, base, ws.slug, comp)
                rows.append((comp, [st.frame(t) for t in FRAMES_SHEET_OF.get(comp, FRAMES_SHEET)]))
                clips.append(clip_frames(st))
                st.close()
            variants.append(pack_sheet(ws, key, packs[key], rows, voc, tokens, ws.cands / f"{key}.png"))
            videos[key] = pack_video(clips, tokens, ws.cands / f"{key}.mp4")
    (ws.cands / "packs.used.json").write_text(json.dumps({"packs": packs, "tokens": tokens, "tokensFrom": source,
                                                          "words": words}, ensure_ascii=False, indent=1),
                                              encoding="utf-8")
    tool = ws.tool("compare_sheet.py")
    out = ws.page / "01-candidates.png"
    if not tool:
        die("нет design-pipeline/tools/compare_sheet.py")
    cmd = [sys.executable, "-I", str(tool), "--engine", "chromium", *[x for v in variants for x in ("--variant", str(v))],
           "--labels", ",".join(sorted(packs)), "--out", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        die(f"compare_sheet.py: {(r.stdout + r.stderr)[-400:]}")
    set_field(ws.page, "Эталон", "нет")
    rel = lambda p: p.relative_to(ws.root).as_posix()
    print(json.dumps({"sheet": rel(out), "packs": {k: {"name": packs[k]["name"], "moves": packs[k]["moves"],
                                                       "sheet": rel(ws.cands / f"{k}.png"), "video": rel(videos[k]),
                                                       "videoKB": round(videos[k].stat().st_size / 1024)}
                                                   for k in sorted(packs)},
                      "tokensFrom": source}, ensure_ascii=False, indent=1))


def section_markup(ws, comp):
    html = (ws.motion / "demo" / "index.html").read_text(encoding="utf-8")
    if comp == "director":
        m = re.search(r'<section class="scene".*?</section>', html, re.S)
    else:
        m = re.search(rf'<section class="demo" id="{SECTION[comp]}">.*?</header>\s*(.*?)\s*</section>', html, re.S)
    return (m.group(1) if m and comp != "director" else m.group(0) if m else "").strip()


def dur_text(m):
    d = m.get("dur_ms")
    return f"{d[0]}–{d[1]} мс" if isinstance(d, list) and d[0] != d[1] else f"{d[0]} мс" if isinstance(d, list) else \
        "ведёт прокрутка"


def cell(s):
    return str(s).replace("|", "/").replace("\n", " ").strip()


def pick(a):
    ws = Ws(a.page, a.motion, a.pipeline)
    used_f = ws.cands / "packs.used.json"
    if not used_f.exists():
        die("сначала moves.py candidates: нет 01-cands/packs.used.json")
    used = json.loads(used_f.read_text(encoding="utf-8"))
    packs, tokens, words = used["packs"], used["tokens"], used["words"]
    key = a.pack.strip().upper()
    if key not in packs:
        die(f"нет набора {key}: есть {', '.join(sorted(packs))}")
    voc = vocab(ws)
    chosen = packs[key]
    frames = ws.page / "01-frames"
    frames.mkdir(exist_ok=True)
    write_brand(ws, tokens, used.get("tokensFrom", "01-cands"))
    write_words(ws, words)
    n = 0
    with serve(ws.motion) as base, browser() as b:
        for comp in chosen["moves"]:
            st = Stage(b, base, ws.slug, comp)
            for t in FRAMES_PICK:
                st.frame(t, frames / f"{comp}-t{t:.2f}.png")
                n += 1
            st.close()
    rows = []
    for k in sorted(packs):
        for comp in packs[k]["moves"]:
            if any(r[0] == comp for r in rows):
                continue
            m = voc[comp]
            decision = "берём" if comp in chosen["moves"] else f"нет — владелец выбрал {key}"
            wow = f"{m['name']}: {m['md_when']}" if m.get("md_when") else m["name"]
            rows.append((comp, wow, m.get("md_how", ""), dur_text(m), m.get("phone_risk", ""),
                         ", ".join(m.get("sources", [])[:3]), decision, k))
    md = [f"# Разбор шага 1: набор {key} «{chosen['name']}»", "",
          "Эталон: нет. Кандидаты — наборы готовых приёмов `motion.js` в токенах и словах владельца "
          f"(`01-cands/A–C.png` и `.mp4`, лист `01-candidates.png`). Владелец выбрал {key}.", "",
          "## Правило-метафора", "", chosen["rule"], "", "## Почему этот набор", "", chosen.get("why") or chosen["rule"],
          "", "## Что даёт вау → на чём сделано → берём/нет", "",
          "| Что даёт вау | Набор | На чём сделано | Темп | Риск на телефоне | Источники разбора | Решение |",
          "|---|---|---|---|---|---|---|"]
    md += [f"| {cell(name)} | {k} | {cell(how)} | {cell(tempo)} | {cell(risk)} | {cell(src)} | {cell(dec)} |"
           for comp, name, how, tempo, risk, src, dec, k in rows]
    md += ["", "## Кадры", "", f"`01-frames/`: {n} кадров на 390×844, по {len(FRAMES_PICK)} точек t на приём "
           f"({', '.join(f'{t:g}' for t in FRAMES_PICK)}).", ""]
    (ws.page / "01-teardown.md").write_text("\n".join(md), encoding="utf-8")
    pack = {"pack": key, "name": chosen["name"], "rule": chosen["rule"], "why": chosen.get("why", ""),
            "brand": {"css": f"design-pipeline/motion/brands/{ws.slug}.css", "tokens": tokens},
            "words": words,
            "moves": [{"component": c, "name": voc[c]["name"], "main": c in MAIN, "dur_ms": voc[c].get("dur_ms"),
                       "opts": voc[c].get("opts", {}), "markup": section_markup(ws, c),
                       "words": {k: words.get(k, WORD_KEYS[k]) for k in WORDS_OF.get(c, [])}}
                      for c in chosen["moves"]]}
    (ws.page / "01-pack.json").write_text(json.dumps(pack, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"pack": key, "frames": n, "teardown": "01-teardown.md", "packJson": "01-pack.json"},
                     ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description="Шаг 1: наборы приёмов движения в цветах и словах владельца.")
    sp = ap.add_subparsers(dest="cmd", required=True)
    for name in ("candidates", "pick"):
        s = sp.add_parser(name)
        s.add_argument("--page", required=True, help="design/<страница>")
        s.add_argument("--motion", help="библиотека движения (по умолчанию design-pipeline/motion)")
        s.add_argument("--pipeline", help="копия design-pipeline (по умолчанию <проект>/design-pipeline)")
        if name == "pick":
            s.add_argument("--pack", required=True, help="A, B или C — что выбрал владелец")
    a = ap.parse_args()
    {"candidates": candidates, "pick": pick}[a.cmd](a)


if __name__ == "__main__":
    main()
