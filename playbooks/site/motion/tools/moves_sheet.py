"""Лист приёмов для владельца: каждый приём в 5 моментах, в цветах его бренда, плюс короткое видео на приём.
Владелец выбирает 2–3 приёма по листу, а не по описанию.

Использование: moves_sheet.py --base http://127.0.0.1:8311/demo/index.html --brand prsloy --out <dir>
               [--moves ring,rail,...] [--width 1440] [--video]
Нужен запущенный статический сервер над playbooks/site/motion (python3 -m http.server)."""
import argparse, json, os, subprocess, tempfile
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFont

MOVES = [("ring", "Кольцо с головкой"), ("rail", "Рельс шагов"), ("odometer", "Число с торможением"),
         ("stamp", "Печать-штамп"), ("slot", "Выезд из-под кромки"), ("trail", "Тропа с точкой"),
         ("morph", "Одна фигура — все состояния"), ("cascade", "Каскад точек"), ("lineword", "Линия-строка"),
         ("shutter", "Предмет-шторка"), ("director", "Режиссёр-t")]
TS = [0.0, 0.25, 0.5, 0.75, 1.0]

ap = argparse.ArgumentParser()
ap.add_argument("--base", required=True); ap.add_argument("--brand", default="prsloy"); ap.add_argument("--out", required=True)
ap.add_argument("--moves", default=""); ap.add_argument("--width", type=int, default=1440); ap.add_argument("--video", action="store_true")
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
want = [m for m in MOVES if not a.moves or m[0] in a.moves.split(",")]
H = 900 if a.width > 600 else 844


def stage_box(pg, move):
    sel = ".scene .m-stage" if move == "director" else f"#{move} .stage"
    return pg.evaluate("""(s) => { const r = document.querySelector(s).getBoundingClientRect();
        return {x: r.x, y: r.y, width: r.width, height: Math.min(r.height, innerHeight)}; }""", sel)


def font(sz):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()


rows, meta = [], []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": a.width, "height": H}, device_scale_factor=1)
    for mid, title in want:
        frames = []
        pg.goto(f"{a.base}?brand={a.brand}&move={mid}&t=0"); pg.wait_for_timeout(500)
        box = stage_box(pg, mid)
        for t in TS:
            pg.evaluate("(t) => Motion.seek(t)", t); pg.wait_for_timeout(60)
            fp = os.path.join(a.out, f"{mid}-{t:.2f}.png")
            pg.screenshot(path=fp, clip=box)
            frames.append(fp)
        dur = pg.evaluate("""(m) => { const l = Motion.list(); const i = l.find(x => !x.driven && x.name !== 'director' && x.el.closest(m === 'director' ? '.scene' : '#' + m)) || l.find(x => x.name === 'director');
            return i ? (i.dur || 2400) : 1000; }""", mid)
        meta.append({"move": mid, "title": title, "dur_ms": dur, "frames": [os.path.basename(f) for f in frames]})
        if a.video:
            n = max(12, int(dur / 1000 * 30)) + 15          # кадры движения + полсекунды финала
            with tempfile.TemporaryDirectory() as td:
                for i in range(n):
                    t = min(1.0, i / max(1, n - 16))
                    pg.evaluate("(t) => Motion.seek(t)", t)
                    pg.screenshot(path=os.path.join(td, f"f{i:04d}.png"), clip=box)
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "30", "-i", os.path.join(td, "f%04d.png"),
                                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                                "-movflags", "+faststart", os.path.join(a.out, f"{mid}.mp4")], check=True)
        rows.append((mid, title, frames))
    b.close()

# сводный лист: строка на приём, 5 кадров, подпись слева
th = 150
label_w = 340
imgs = [[Image.open(f) for f in fr] for _, _, fr in rows]
cell_w = max(int(im.width * th / im.height) for row in imgs for im in row)
W = label_w + cell_w * len(TS) + 20
sheet = Image.new("RGB", (W, (th + 24) * len(rows) + 40), "white")
d = ImageDraw.Draw(sheet)
f1, f2 = font(20), font(14)
for j, t in enumerate(TS):
    d.text((label_w + j * cell_w + 6, 10), f"t = {t:g}", fill=(90, 90, 90), font=f2)
for i, ((mid, title, _), row) in enumerate(zip(rows, imgs)):
    y = 34 + i * (th + 24)
    d.text((14, y + th // 2 - 22), title, fill=(20, 20, 20), font=f1)
    d.text((14, y + th // 2 + 4), mid, fill=(120, 120, 120), font=f2)
    for j, im in enumerate(row):
        im2 = im.resize((int(im.width * th / im.height), th))
        sheet.paste(im2, (label_w + j * cell_w, y))
out = os.path.join(a.out, f"moves-{a.brand}-{a.width}.png")
sheet.save(out)
json.dump(meta, open(os.path.join(a.out, "moves.json"), "w"), ensure_ascii=False, indent=1)
print(out)
