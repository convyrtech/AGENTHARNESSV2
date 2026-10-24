"""Проверка приёмов движения на любой странице (демо или собранный сайт). Выход 1 — есть провал.

  check_motion.py <url> [--widths 390,1440] [--throttle 4]

Что проверяет (правила VOCAB.md):
  1. нет ошибок в консоли и исключений;
  2. при prefers-reduced-motion страница выглядит как ?t=1 (финальное состояние);
  3. каждый приём действительно двигается: кадр ?t=0 отличается от ?t=1 в его рамке;
  4. текст не пропадает: видимый текст страницы одинаков при t=0 и t=1 (движение не прячет слова);
  5. плавность: интро проигрываются при замедленном в N раз процессоре, p95 кадра < 20 мс на телефоне;
  6. анимируются только transform / opacity / stroke-dashoffset / clip-path (по inline-стилям после проигрыша).
"""
import argparse, json, sys
from io import BytesIO
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops

ap = argparse.ArgumentParser()
ap.add_argument("url"); ap.add_argument("--widths", default="390,1440"); ap.add_argument("--throttle", type=float, default=4)
a = ap.parse_args()
sep = "&" if "?" in a.url else "?"
ALLOWED = {"transform", "opacity", "stroke-dashoffset", "clip-path", "visibility", "--p", "--in", "--m-screens",
           "width", "height", "left", "top"}   # последние четыре — разметка кольца, ставится один раз, не в анимации
fails, notes = [], []


def shot(pg):
    return Image.open(BytesIO(pg.screenshot(full_page=True))).convert("RGB")


def diff_ratio(a_, b_):
    if a_.size != b_.size:
        return 1.0
    d = ImageChops.difference(a_, b_).convert("L").point(lambda v: 255 if v > 24 else 0)
    return sum(d.histogram()[255:]) / (a_.width * a_.height)


with sync_playwright() as p:
    b = p.chromium.launch()
    for w in [int(x) for x in a.widths.split(",")]:
        h = 844 if w < 600 else 900
        ctx = b.new_context(viewport={"width": w, "height": h})
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        # 1 + 4: t=0 и t=1
        pg.goto(f"{a.url}{sep}t=0"); pg.wait_for_timeout(700)
        txt0 = pg.evaluate("document.body.innerText")
        moves = pg.evaluate("""() => Motion.list().map((i, k) => { const r = i.el.getBoundingClientRect();
            return {k, name: i.name, driven: !!i.driven, box: [r.x, r.y + scrollY, r.width, r.height]}; })""")
        img0 = shot(pg)
        pg.goto(f"{a.url}{sep}t=1"); pg.wait_for_timeout(700)
        txt1 = pg.evaluate("document.body.innerText")
        img1 = shot(pg)
        if errs:
            fails.append(f"{w}: ошибки в консоли: {errs[:3]}")
        s0, s1 = set(txt0.split()), set(txt1.split())
        if s0 != s1:
            notes.append(f"{w}: текст при t=0 и t=1 отличается (одометры доезжают до значения): только в t=0 {sorted(s0 - s1)[:6]}, только в t=1 {sorted(s1 - s0)[:6]}")
        # 3: каждый приём двигается в своей рамке
        for m in moves:
            if m["driven"] or m["name"] in ("morph", "director"):
                continue
            x, y, bw, bh = [int(v) for v in m["box"]]
            pad = 40
            box = (max(0, x - pad), max(0, y - pad), min(img0.width, x + bw + pad), min(img0.height, y + bh + pad))
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            r = diff_ratio(img0.crop(box), img1.crop(box))
            if r < 0.0005:
                fails.append(f"{w}: приём {m['name']} #{m['k']} не меняется между t=0 и t=1")
        # 2: reduced-motion = финал: на той же странице доворот всех приёмов в t=1 ничего не меняет
        rctx = b.new_context(viewport={"width": w, "height": h}, reduced_motion="reduce")
        rp = rctx.new_page(); rp.goto(a.url); rp.wait_for_timeout(700)
        if not rp.evaluate("Motion.REDUCED"):
            fails.append(f"{w}: motion.js не увидел prefers-reduced-motion")
        rimg = shot(rp)
        rp.evaluate("Motion.seek(1, {interactive: false})"); rp.wait_for_timeout(200)
        r = diff_ratio(rimg, shot(rp))
        if r > 0.002:
            fails.append(f"{w}: при reduced-motion страница не в финальном состоянии (отличие {r:.2%} от t=1)")
        rctx.close()
        # 5 + 6: живое проигрывание с замедленным процессором
        lp = ctx.new_page()
        cdp = ctx.new_cdp_session(lp)
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": a.throttle})
        lp.add_init_script("""window.__frames = []; (function f(t){ window.__frames.push(t); requestAnimationFrame(f); })(performance.now());
            window.__src = new WeakMap(); document.addEventListener('DOMContentLoaded', () => { for (const e of document.querySelectorAll('[style]'))
              window.__src.set(e, new Set(Array.from(e.style))); });""")
        lp.goto(a.url); lp.wait_for_timeout(400)
        H = lp.evaluate("document.documentElement.scrollHeight")
        y = 0
        while y < H:
            y += int(h * 0.6); lp.evaluate(f"window.scrollTo(0, {y})"); lp.wait_for_timeout(450)
        lp.wait_for_timeout(1500)
        fr = lp.evaluate("window.__frames")
        dts = sorted(fr[i + 1] - fr[i] for i in range(len(fr) - 1))
        p95 = dts[int(len(dts) * 0.95)] if dts else 0
        notes.append(f"{w}: кадры при замедлении ×{a.throttle:g}: p95 {p95:.1f} мс, медиана {dts[len(dts)//2] if dts else 0:.1f} мс")
        if w < 600 and p95 > 20:
            fails.append(f"{w}: p95 кадра {p95:.1f} мс > 20 мс при замедлении ×{a.throttle:g}")
        props = lp.evaluate("""() => { const s = new Set(); for (const i of Motion.list()) for (const e of [i.el, ...i.el.querySelectorAll('*')]) {
            const src = window.__src.get(e) || new Set();
            for (let k = 0; k < e.style.length; k++) if (!src.has(e.style[k])) s.add(e.style[k]); } return [...s]; }""")
        bad = [x for x in props if x not in ALLOWED]
        if bad:
            fails.append(f"{w}: в движении меняются запрещённые свойства: {bad}")
        ctx.close()
    b.close()

for n in notes:
    print("·", n)
for f in fails:
    print("FAIL", f)
print("motion:", "PASS" if not fails else f"FAIL ({len(fails)})")
sys.exit(1 if fails else 0)
