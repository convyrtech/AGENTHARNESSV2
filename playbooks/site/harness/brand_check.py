"""Только цвета бренда и CSS-слоп — проверка кодом, до судьи (research/20 §7).

Usage: brand_check.py <site_dir> <page_dir> [--materials <dir>] [--json <file>]. Exit 1 on any FAIL, 0 otherwise
(в том числе когда цветов бренда не найдено или браузер не открылся: тогда только CSS-правила).

1. Цвета. Токены бренда — все HEX из таблиц `<page>/02-brand.md` (строки «Запрещено» не в счёт) и из
   `materials/brand.json` (colors, palette, css_variables; его пишет brand_probe.py). Playwright открывает каждую
   страницу сайта, проходит видимые элементы и берёт цвет текста (у кого есть свой текст), фона, рамок и цвета
   градиентов; полупрозрачное смешивается с фоном под ним. Каждый цвет — ΔE2000 до ближайшего токена или смеси двух
   токенов (оттенки mid/line — тоже бренд). ΔE > 6 на заметной площади → FAIL с селектором. <img>, <svg>, <video>,
   <canvas> и всё внутри них пропускаются: это картинки и логотип владельца.
2. CSS-слоп — правила OpenDesign lint-artifact, регулярками по CSS страницы: purple-gradient, ai-default-indigo,
   emoji-icon, raw-hex (HEX вне :root, когда у страницы есть свои переменные), all-caps-no-tracking,
   left-accent-card.

Пороги — по dembrandt `lib/drift.ts` (MIT): colorSame 2.3 — тот же цвет; у нас провал с 6 (между «тот же» и
colorShift 15: заметный глазом чужой оттенок). Список правил — OpenDesign `apps/daemon/src/lint-artifact.ts`
(Apache-2.0). Код не копировался, всё написано заново на Python.
"""
import argparse, colorsys, json, math, os, re, sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

DE_FAIL = 6.0
MIN_AREA = 1500          # px² одного чужого цвета на странице: меньше — точка, не «чужой цвет»
MIN_TEXT_AREA = 200      # px² текста чужого цвета
HEX = re.compile(r"#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b")
# Tailwind indigo/violet по умолчанию: «цвет нейросети», если бренд его не называл
AI_INDIGO = {"#6366f1", "#4f46e5", "#4338ca", "#818cf8", "#7c3aed", "#8b5cf6", "#a855f7", "#6d28d9", "#9333ea"}
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿⭐⭕]")


# ---------- цвета ----------
def norm_hex(h):
    h = h.lower()
    return "#" + "".join(c * 2 for c in h[1:]) if len(h) == 4 else h


def rgb_of(h):
    h = norm_hex(h)
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def hex_of(rgb):
    return "#" + "".join(f"{max(0, min(255, round(v))):02x}" for v in rgb)


def lab(rgb):
    c = [v / 255 for v in rgb]
    c = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    x = (0.4124564 * c[0] + 0.3575761 * c[1] + 0.1804375 * c[2]) / 0.95047
    y = 0.2126729 * c[0] + 0.7151522 * c[1] + 0.0721750 * c[2]
    z = (0.0193339 * c[0] + 0.1191920 * c[1] + 0.9503041 * c[2]) / 1.08883
    f = [v ** (1 / 3) if v > (6 / 29) ** 3 else v / (3 * (6 / 29) ** 2) + 4 / 29 for v in (x, y, z)]
    return 116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])


def de2000(l1, l2):
    """CIEDE2000 (Sharma, Wu, Dalal 2005)."""
    L1, a1, b1 = l1
    L2, a2, b2 = l2
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)
    cm = (c1 + c2) / 2
    g = 0.5 * (1 - math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dl, dc = L2 - L1, c2p - c1p
    if c1p * c2p == 0:
        dh = 0
    elif abs(h2p - h1p) <= 180:
        dh = h2p - h1p
    else:
        dh = h2p - h1p - 360 if h2p > h1p else h2p - h1p + 360
    dH = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(dh / 2))
    lm, cmp_ = (L1 + L2) / 2, (c1p + c2p) / 2
    if c1p * c2p == 0:
        hm = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hm = (h1p + h2p) / 2
    else:
        hm = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    t = (1 - 0.17 * math.cos(math.radians(hm - 30)) + 0.24 * math.cos(math.radians(2 * hm))
         + 0.32 * math.cos(math.radians(3 * hm + 6)) - 0.20 * math.cos(math.radians(4 * hm - 63)))
    sl = 1 + 0.015 * (lm - 50) ** 2 / math.sqrt(20 + (lm - 50) ** 2)
    sc, sh = 1 + 0.045 * cmp_, 1 + 0.015 * cmp_ * t
    rt = (-2 * math.sqrt(cmp_ ** 7 / (cmp_ ** 7 + 25 ** 7))
          * math.sin(math.radians(60 * math.exp(-(((hm - 275) / 25) ** 2)))))
    return math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh))


def brand_tokens(page_dir, materials=None):
    """HEX бренда: таблицы 02-brand.md (без «Запрещено») и materials/brand.json."""
    found = []
    md = Path(page_dir) / "02-brand.md"
    if md.exists():
        section = ""
        for ln in md.read_text(encoding="utf-8").splitlines():
            if ln.startswith("#"):
                section = ln.lower()
                continue
            if "запрещ" in section or "запрещ" in ln.lower():
                continue
            if ln.lstrip().startswith("|"):
                found += HEX.findall(ln)
    bj = Path(materials) / "brand.json" if materials else None
    if bj and bj.exists():
        try:
            data = json.loads(bj.read_text(encoding="utf-8"))
        except ValueError:
            data = {}
        found += [v for v in (data.get("colors") or {}).values() if isinstance(v, str)]
        for p in data.get("palette") or []:
            found.append(p.get("hex", "") if isinstance(p, dict) else str(p))
        found += [v for v in (data.get("css_variables") or {}).values() if isinstance(v, str)]
    out = []
    for h in found:
        m = HEX.fullmatch(h.strip())
        if m and norm_hex(h.strip()) not in out:
            out.append(norm_hex(h.strip()))
    return out


def nearest(rgb, tokens):
    """(ΔE до ближайшего токена или смеси двух токенов в sRGB с шагом 5%, ближайший токен — его и назвать агенту)."""
    target = lab(rgb)
    rgbs = [(t, rgb_of(t)) for t in tokens]
    d, tok = min((de2000(target, lab(r)), t) for t, r in rgbs)
    if d <= DE_FAIL:
        return d, tok
    for i, (_, ra) in enumerate(rgbs):
        for _, rb in rgbs[i + 1:]:
            for k in range(1, 20):
                w = k / 20
                d = min(d, de2000(target, lab(tuple(ra[j] * w + rb[j] * (1 - w) for j in range(3)))))
    return d, tok


COLLECT = r"""() => {
  const SKIP = new Set(["IMG", "SVG", "VIDEO", "CANVAS", "PICTURE", "IFRAME", "svg"]);
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ""); if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const under = (el) => { // opaque colour behind an element: nearest ancestor background, else white
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor); if (c && c[3] >= 0.99) return c; }
    return [255, 255, 255, 1]; };
  const over = (c, bg) => [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3]));
  const sel = (el) => { const parts = []; for (let n = el; n && n !== document.body && parts.length < 3; n = n.parentElement) {
      let s = n.tagName.toLowerCase(); if (n.id) s += "#" + n.id;
      else if (n.classList.length) s += "." + [...n.classList].slice(0, 2).join(".");
      parts.unshift(s); } return parts.join(" > "); };
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (SKIP.has(el.tagName) || el.closest("svg, picture, video, canvas, iframe")) continue;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0 || r.width * r.height < 1) continue;
    const area = r.width * r.height; const s = sel(el);
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText) { const c = parse(cs.color); if (c && c[3] > 0.05) out.push({ kind: "text", rgb: over(c, under(el)), area, sel: s }); }
    const bg = parse(cs.backgroundColor);
    if (bg && bg[3] > 0.05) out.push({ kind: "background", rgb: over(bg, under(el)), area, sel: s });
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const w = parseFloat(cs["border" + side + "Width"]);
      if (!w || cs["border" + side + "Style"] === "none") continue;
      const c = parse(cs["border" + side + "Color"]); if (!c || c[3] <= 0.05) continue;
      const len = side === "Top" || side === "Bottom" ? r.width : r.height;
      out.push({ kind: "border", rgb: over(c, under(el)), area: len * w, sel: s }); }
    const img = cs.backgroundImage || "";
    if (img.includes("gradient")) for (const m of img.matchAll(/rgba?\([^)]+\)/g)) {
      const c = parse(m[0]); if (c && c[3] > 0.05) out.push({ kind: "gradient", rgb: over(c, under(el)), area, sel: s }); }
  }
  return out;
}"""

KIND_RU = {"text": "текст", "background": "фон", "border": "рамка", "gradient": "градиент"}


def judge_colors(samples, tokens):
    """Сэмплы со страницы → находки: чужой цвет, его площадь, ближайший токен, первый селектор."""
    by = {}
    for s in samples:
        h = hex_of(s["rgb"])
        e = by.setdefault((h, s["kind"]), {"hex": h, "kind": s["kind"], "area": 0.0, "sel": s["sel"]})
        e["area"] += s["area"]
    cache, out = {}, []
    for e in by.values():
        if e["hex"] not in cache:
            cache[e["hex"]] = nearest(rgb_of(e["hex"]), tokens)
        d, tok = cache[e["hex"]]
        need = MIN_TEXT_AREA if e["kind"] == "text" else MIN_AREA
        if d > DE_FAIL and e["area"] >= need:
            out.append({**e, "de": round(d, 1), "nearest": tok})
    return sorted(out, key=lambda x: -x["area"])


def collect(pages):
    from playwright.sync_api import sync_playwright
    ch = os.environ.get("DP_BROWSER_CHANNEL")
    samples = []
    with sync_playwright() as p:
        b = p.chromium.launch(**({"channel": ch} if ch else {}))
        try:
            pg = b.new_page(viewport={"width": 1440, "height": 900})
            for html in pages:
                pg.goto(html.resolve().as_uri(), wait_until="load")
                pg.wait_for_timeout(300)
                for s in pg.evaluate(COLLECT):
                    s["page"] = html.name
                    samples.append(s)
        finally:
            b.close()
    return samples


# ---------- CSS-слоп ----------
ROOT_BLOCK = re.compile(r":root\s*\{[^}]*\}", re.S)
RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")


def css_of(site):
    """(файл, CSS) — .css файлы, <style> и style="" из HTML."""
    out = []
    for f in sorted(Path(site).rglob("*")):
        if f.suffix.lower() == ".css":
            out.append((f, f.read_text(encoding="utf-8", errors="ignore")))
        elif f.suffix.lower() in (".html", ".htm"):
            t = f.read_text(encoding="utf-8", errors="ignore")
            css = "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", t, re.S | re.I))
            inline = "\n".join(f"[inline]{{{m}}}" for m in re.findall(r"""\bstyle\s*=\s*["']([^"']*)["']""", t, re.I))
            out.append((f, css + "\n" + inline))
    return out


def is_purple(h):
    r, g, b = (v / 255 for v in rgb_of(h))
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    return 0.68 <= hue <= 0.86 and sat >= 0.3 and 0.15 <= light <= 0.85


def css_slop(site, tokens=()):
    tokens = set(tokens)
    found = []
    files = css_of(site)
    has_vars = any(re.search(r"--[\w-]+\s*:\s*#", m.group(0)) for _, css in files for m in ROOT_BLOCK.finditer(css))
    for f, css in files:
        name = f.relative_to(site).as_posix()
        rest = ROOT_BLOCK.sub(" ", css)
        for grad in re.findall(r"(?:linear|radial|conic)-gradient\(((?:[^()]|\([^()]*\))*)\)", rest):
            if re.search(r"\b(purple|violet|indigo|magenta)\b", grad, re.I) or any(
                    is_purple(h) and norm_hex(h) not in tokens for h in HEX.findall(grad)):
                found.append(("purple-gradient", f"{name}: фиолетовый градиент — шаблон нейросети, не бренд"))
                break
        for h in sorted({norm_hex(h) for h in HEX.findall(css)} & AI_INDIGO - tokens):
            found.append(("ai-default-indigo", f"{name}: {h} — индиго Tailwind по умолчанию, в бренде его нет"))
        if has_vars:
            raw = []
            for sel, body in RULE.findall(rest):
                if sel.strip().startswith("@font-face"):
                    continue
                for prop, val in re.findall(r"([\w-]+)\s*:\s*([^;]+)", body):
                    if not prop.startswith("--") and HEX.search(val):
                        raw.append(f"{sel.strip()[:40]} → {prop}: {val.strip()[:48]}")
            if raw:
                found.append(("raw-hex", f"{name}: цвет числом мимо переменных бренда ({len(raw)}), например "
                                         + "; ".join(raw[:3]) + " — бери var(--…) из :root"))
        for sel, body in RULE.findall(rest):
            if re.search(r"text-transform\s*:\s*uppercase", body, re.I) and not re.search(r"letter-spacing", body, re.I):
                found.append(("all-caps-no-tracking", f"{name}: «{sel.strip()[:50]}» — заглавные без разрядки "
                                                      "(добавь letter-spacing)"))
            m = re.search(r"border-left(?:-width)?\s*:\s*(\d+(?:\.\d+)?)px", body, re.I)
            if m and float(m.group(1)) >= 3 and re.search(r"border-radius", body, re.I):
                found.append(("left-accent-card", f"{name}: «{sel.strip()[:50]}» — карточка с цветной полосой слева "
                                                  "и скруглением, шаблонный приём"))
    for f in sorted(Path(site).rglob("*.htm*")):
        t = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", f.read_text(encoding="utf-8", errors="ignore"), flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", t)
        hits = sorted(set(EMOJI.findall(text)))
        if hits:
            found.append(("emoji-icon", f"{f.relative_to(site).as_posix()}: эмодзи вместо значков ({' '.join(hits[:5])}) "
                                        "— значок рисуется SVG/CSS"))
    seen, out = set(), []
    for rule, msg in found:
        if msg not in seen:
            seen.add(msg)
            out.append({"rule": rule, "text": msg})
    return out


def site_pages(site, limit=5):
    pages = sorted(Path(site).rglob("index.html")) or sorted(Path(site).rglob("*.html"))
    return pages[:limit]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("site")
    ap.add_argument("page")
    ap.add_argument("--materials")
    ap.add_argument("--json")
    a = ap.parse_args()
    site, page = Path(a.site), Path(a.page)
    materials = Path(a.materials) if a.materials else site.parent / "materials"
    tokens = brand_tokens(page, materials)
    fails, colors, note = [], [], ""
    if len(tokens) >= 2 and site_pages(site):
        try:
            colors = judge_colors(collect(site_pages(site)), tokens)
        except Exception as e:  # браузер не открылся: цвета не проверены, это не провал страницы
            note = f"цвета не проверены: {type(e).__name__}: {str(e)[:120]}"
    elif len(tokens) < 2:
        note = "цвета не проверены: в 02-brand.md и materials/brand.json нет цветов бренда"
    for c in colors[:5]:
        fails.append(f"чужой цвет {c['hex']} ({KIND_RU[c['kind']]}, {round(c['area'])} px², ΔE {c['de']} до "
                     f"ближайшего цвета бренда {c['nearest']}): {c['sel']} — возьми цвет бренда")
    slop = css_slop(site, tokens)
    fails += [s["text"] for s in slop]
    if a.json:
        Path(a.json).write_text(json.dumps({"tokens": tokens, "colors": colors, "slop": slop, "note": note},
                                           ensure_ascii=False, indent=1), encoding="utf-8")
    for x in fails:
        print("FAIL", x)
    if note:
        print("brand_check:", note)
    print("brand_check:", "PASS" if not fails else f"FAIL ({len(fails)})")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
