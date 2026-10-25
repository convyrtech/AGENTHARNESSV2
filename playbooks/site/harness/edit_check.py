"""Быстрая проверка правки владельца на готовой странице (research/20 §2): снимок «до/после» и сравнение вне
выбранных мест. Полный гейт и судья ради одной правки не нужны: достаточно убедиться, что остальная страница
осталась прежней, и показать владельцу «было / стало».

  edit_check.py shoot   --html <site>/<page>/index.html --out before-390.png --width 390 [--targets t.json]
                        [--boxes-out boxes.json]
  edit_check.py compare --before a.png --after b.png --boxes boxes.json --boxes-after boxes2.json --out diff.json
                        [--sheet sheet.png]

shoot: Chromium (DP_BROWSER_CHANNEL=msedge — установленный Edge), движение заморожено `?t=1` (motion.js), снимок всей
страницы; для каждой цели {selector, nth} пишет прямоугольник элемента и его блока (ближайшая section, header,
footer, article, aside, nav или прямой потомок body/main) в координатах страницы.
compare: внутри блока правка может перестроить колонки, поэтому он исключается целиком. Выше блока — пиксели в OKLab
HyAB, как pixelmatch. Ниже блока страница съезжает на дробную долю пикселя, и сглаживание текста меняется везде, поэтому
там сравниваются отпечатки остальных блоков: HTML и вычисленные стили всех потомков. Итог — доля изменившихся пикселей
выше правки и список блоков, которые изменились, хотя их не выбирали.

Цветовая разница — порт pixelmatch 7 (index.js: LIN, LMS-матрица, toe-коррекция Lr, oklabHyabDelta) на numpy.
pixelmatch: ISC License, Copyright (c) 2025, Mapbox.
  Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
  granted, provided that the above copyright notice and this permission notice appear in all copies.
  THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
  INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
  AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
  PERFORMANCE OF THIS SOFTWARE.
"""
import argparse
import json
import os
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

PAD = 12              # запас вокруг выбранного места: тень, обводка, фокус
THRESHOLD = 0.1       # порог pixelmatch по умолчанию: HyAB-расстояние в OKLab, 1 — чёрный против белого
OK_RATIO = 0.002      # вне правки может измениться не больше 0,2% пикселей (сглаживание шрифтов, субпиксели)


def oklab(img):
    """RGB uint8 (h, w, 3) → (Lr, l, m, s): кубические корни LMS и toe-скорректированная светлота, как в pixelmatch."""
    import numpy as np
    c = img.astype(np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    l_ = np.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    m_ = np.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    s_ = np.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    k1, k2 = 0.206, 0.03
    k3 = (1 + k1) / (1 + k2)
    big_l = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    x = k3 * big_l - k1
    lr = 0.5 * (x + np.sqrt(x * x + 4 * k2 * k3 * big_l))
    return lr, l_, m_, s_


def differs(a, b, threshold=THRESHOLD):
    """Булева маска пикселей, у которых HyAB-расстояние больше порога (oklabHyabDelta из pixelmatch)."""
    import numpy as np
    lr1, l1, m1, s1 = oklab(a)
    lr2, l2, m2, s2 = oklab(b)
    dl, dm, ds = l1 - l2, m1 - m2, s1 - s2
    da = 1.9779984951 * dl - 2.4285922050 * dm + 0.4505937099 * ds
    db = 0.0259040371 * dl + 0.7827717662 * dm - 0.8086757660 * ds
    rest = threshold - np.abs(lr1 - lr2)
    return (rest < 0) | (da * da + db * db > rest * rest)


def load(path):
    import numpy as np
    from PIL import Image
    return np.asarray(Image.open(path).convert("RGB"))


def span(boxes):
    bl = [b.get("block") or b for b in boxes]
    return (int(min(b["y"] for b in bl)), int(max(b["y"] + b["h"] for b in bl))) if bl else None


def unpack(x):
    return (x.get("targets", []), x.get("blocks", [])) if isinstance(x, dict) else (x or [], [])


def touched(target_boxes, blocks):
    """Индексы блоков, в которые попадает хоть одна цель (по прямоугольнику блока цели)."""
    out = set()
    for t in target_boxes:
        tb = t.get("block") or t
        cy = tb["y"] + tb["h"] / 2
        for b in blocks:
            if b["y"] - 1 <= cy <= b["y"] + b["h"] + 1:
                out.add(b["i"])
    return out


def compare(before, after, boxes, boxes_after=None, threshold=THRESHOLD):
    """Изменения вне блоков правки: пиксели выше блока (сдвига там нет) и отпечатки остальных блоков страницы."""
    import numpy as np
    boxes, blocks_b = unpack(boxes)
    boxes_after, blocks_a = unpack(boxes_after)
    h1, w1 = before.shape[:2]
    h2, w2 = after.shape[:2]
    w = min(w1, w2)
    sb, sa = span(boxes or []), span(boxes_after or [])
    if not sb:
        top, bottom, shift = h1, h1, h2 - h1
    else:
        top = max(0, min(sb[0], sa[0] if sa else sb[0]) - PAD)
        bottom = min(h1, sb[1] + PAD)
        shift = (sa[1] - sb[1]) if sa else (h2 - h1)
    changed = total = 0
    regions = []
    if top > 0:
        n = min(top, h2)
        regions.append((before[:n, :w], after[:n, :w], 0))

    def below(s):
        lo, hi = bottom, h1
        lo2, hi2 = lo + s, hi + s
        if lo2 < 0:
            lo, lo2 = lo - lo2, 0
        if hi2 > h2:
            hi, hi2 = hi - (hi2 - h2), h2
        return (before[lo:hi, :w], after[lo2:hi2, :w], lo) if hi > lo else None

    if bottom < h1 and not (blocks_b and blocks_a):
        # отпечатков блоков нет (старый формат): пиксели ниже со сдвигом ±1 от округления, берём лучший
        best = None
        for s in sorted({shift, h2 - h1, shift - 1, shift + 1}):
            r = below(s)
            if r is not None:
                n = int(differs(r[0][::8], r[1][::8], threshold).sum())
                if best is None or n < best[0]:
                    best = (n, s, r)
        if best:
            shift = best[1]
            regions.append(best[2])
    rows = []
    for a, b, y0 in regions:
        d = differs(a, b, threshold)
        changed += int(d.sum())
        total += d.size
        ys = np.nonzero(d.any(axis=1))[0]
        if ys.size:
            rows.append([int(y0 + ys[0]), int(y0 + ys[-1])])
    ratio = changed / total if total else 0.0
    moved = []                                    # блоки вне правки, у которых изменились HTML или стили
    if blocks_b and blocks_a:
        skip_b, skip_a = touched(boxes, blocks_b), touched(boxes_after, blocks_a)
        rest_b = [b for b in blocks_b if b["i"] not in skip_b]
        rest_a = [b for b in blocks_a if b["i"] not in skip_a]
        if len(rest_b) != len(rest_a):
            moved.append({"why": f"блоков вне правки было {len(rest_b)}, стало {len(rest_a)}"})
        for x, y in zip(rest_b, rest_a):
            if (x["html"], x["style"]) != (y["html"], y["style"]):
                moved.append({"block": x["i"], "tag": x["tag"], "id": x["id"], "y": int(x["y"]),
                              "why": "html" if x["html"] != y["html"] else "стили"})
    return {"ratio": round(ratio, 5), "changed": changed, "compared": total, "shift": int(shift),
            "band": [top, bottom], "rows": rows, "blocks_changed": moved,
            "ok": ratio <= OK_RATIO and not moved}


def sheet(before_png, after_png, out, max_h=1600):
    """Одна картинка для владельца: «Было» слева, «Стало» справа."""
    from PIL import Image, ImageDraw
    a, b = Image.open(before_png).convert("RGB"), Image.open(after_png).convert("RGB")
    k = min(1.0, max_h / max(a.height, b.height))
    a = a.resize((max(1, int(a.width * k)), max(1, int(a.height * k))))
    b = b.resize((max(1, int(b.width * k)), max(1, int(b.height * k))))
    gap, head = 24, 44
    im = Image.new("RGB", (a.width + b.width + gap * 3, max(a.height, b.height) + head + gap), "#f2efe8")
    d = ImageDraw.Draw(im)
    for x, label in ((gap, "Было"), (gap * 2 + a.width, "Стало")):
        d.text((x, 14), label, fill="#2b2622")
    im.paste(a, (gap, head))
    im.paste(b, (gap * 2 + a.width, head))
    im.save(out)


# блоки страницы: section/header/footer/article/aside/nav верхнего уровня или прямые потомки body/main; у каждого —
# прямоугольник и отпечаток FNV-1a от outerHTML и вычисленных стилей всех потомков (то, что видит глаз)
BLOCKS_JS = """() => {
  const fnv = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const PROPS = ["display", "position", "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
    "color", "background-color", "background-image", "border-top", "border-bottom", "border-radius", "margin-top",
    "margin-bottom", "padding-top", "padding-bottom", "width", "opacity", "transform", "text-transform", "gap"];
  const roots = []; const host = document.querySelector("main") || document.body;
  for (const el of host.children) if (!["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(el.tagName)) roots.push(el);
  if (host !== document.body) for (const el of document.body.children)
    if (el !== host && !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(el.tagName)) roots.push(el);
  return roots.map((el, i) => { const r = el.getBoundingClientRect();
    const styles = [el, ...el.querySelectorAll("*")].map((e) => { const cs = getComputedStyle(e);
      return PROPS.map((p) => cs.getPropertyValue(p)).join("|"); }).join("\\n");
    return {i, tag: el.tagName.toLowerCase(), id: el.id || null, x: r.left + scrollX, y: r.top + scrollY,
            w: r.width, h: r.height, html: fnv(el.outerHTML), style: fnv(styles)}; });
}"""


def shoot(html, out, width, targets=None, boxes_out=None):
    from playwright.sync_api import sync_playwright
    ch = os.environ.get("DP_BROWSER_CHANNEL")
    url = Path(html).resolve().as_uri() + "?t=1"
    boxes = []
    with sync_playwright() as p:
        b = p.chromium.launch(**({"channel": ch} if ch else {}))
        page = b.new_page(viewport={"width": int(width), "height": 900}, device_scale_factor=1)
        page.goto(url, wait_until="load")
        page.evaluate("document.fonts && document.fonts.ready")
        # окно во всю страницу: появление при прокрутке зависит от того, что попало в первый экран, и после сдвига
        # правкой низ страницы иначе снимается в другом состоянии
        full = int(page.evaluate("document.documentElement.scrollHeight"))
        page.set_viewport_size({"width": int(width), "height": max(900, min(full, 16000))})
        page.wait_for_timeout(500)
        blocks = page.evaluate(BLOCKS_JS)
        for t in targets or []:
            r = page.evaluate(
                """([sel, nth]) => { const els = document.querySelectorAll(sel); const el = els[Math.max(0, nth - 1)];
                   if (!el) return null;
                   const box = (e) => { const r = e.getBoundingClientRect();
                     return {x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height}; };
                   let blk = el.closest("section, header, footer, article, aside, nav");
                   if (!blk) { blk = el; while (blk.parentElement && !["BODY", "MAIN"].includes(blk.parentElement.tagName))
                     blk = blk.parentElement; }
                   return {...box(el), block: box(blk)}; }""",
                [t["selector"], int(t.get("nth") or 1)])
            if r:
                boxes.append({**r, "selector": t["selector"]})
        page.screenshot(path=str(out), full_page=True)
        b.close()
    if boxes_out:
        Path(boxes_out).write_text(json.dumps({"targets": boxes, "blocks": blocks}, ensure_ascii=False),
                                   encoding="utf-8")
    return boxes


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("shoot")
    s.add_argument("--html", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--width", type=int, default=1440)
    s.add_argument("--targets")
    s.add_argument("--boxes-out")
    c = sp.add_parser("compare")
    c.add_argument("--before", required=True)
    c.add_argument("--after", required=True)
    c.add_argument("--boxes")
    c.add_argument("--boxes-after")
    c.add_argument("--out", required=True)
    c.add_argument("--sheet")
    a = ap.parse_args()
    if a.cmd == "shoot":
        targets = json.loads(Path(a.targets).read_text(encoding="utf-8")) if a.targets else []
        boxes = shoot(a.html, a.out, a.width, targets, a.boxes_out)
        print(json.dumps({"out": a.out, "boxes": len(boxes)}, ensure_ascii=False))
        return 0
    boxes = json.loads(Path(a.boxes).read_text(encoding="utf-8")) if a.boxes else []
    after = json.loads(Path(a.boxes_after).read_text(encoding="utf-8")) if a.boxes_after else []
    res = compare(load(a.before), load(a.after), boxes, after)
    if a.sheet:
        sheet(a.before, a.after, a.sheet)
        res["sheet"] = a.sheet
    Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
