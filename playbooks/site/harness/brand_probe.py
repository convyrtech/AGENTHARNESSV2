"""Бренд по адресу сайта владельца: цвета, шрифты и скругления с живой страницы, без модели (research/20 §3).

Открывает страницу в том же браузере, что и остальные инструменты (Edge на Windows: DP_BROWSER_CHANNEL), и читает
вычисленные стили. Каждое значение — замер, а не догадка: у цвета есть вес (площадь фона или количество текста), у
шрифта — элемент, где он стоит. Идея по мотивам dembrandt (MIT) и brand-capture OpenDesign (Apache-2.0); код свой.

  brand_probe.py --url https://example.ru --out materials/brand.json [--shot materials/brand-site.png]

Выход 0 — brand.json записан; 2 — страница не открылась (JSON {"error": …} в stdout, файл не пишется).
"""
import argparse, colorsys, json, os, sys, time
from pathlib import Path
for _s in (sys.stdout, sys.stderr):  # Windows: под -I PYTHONUTF8 не действует, а вывод в трубу идёт в cp1252
    _s.reconfigure(encoding="utf-8", errors="replace")

COLLECT = r"""() => {
  const hex = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c || "");
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) return null;
    return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  };
  const bg = {}, text = {}, action = {};
  const add = (map, c, w) => { if (c) map[c] = (map[c] || 0) + w; };
  const radii = {};
  const els = Array.from(document.querySelectorAll("body, body *")).slice(0, 4000);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
    add(bg, hex(s.backgroundColor), Math.min(r.width * r.height, 1440 * 900));
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    if (own) add(text, hex(s.color), own.length);
    if (el.matches("a, button, [role=button], input[type=submit], .btn, .button")) {
      add(action, hex(s.backgroundColor), 3);
      add(action, hex(s.color), 1);
      add(action, hex(s.borderTopColor), 1);
      // a link that looks like a button (own background) shows the brand's corners, whatever its class
      const r = s.borderTopLeftRadius;
      if (hex(s.backgroundColor) && r && r !== "0px") radii[r] = (radii[r] || 0) + 2;
    }
  }
  const font = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { family: s.fontFamily.split(",")[0].replace(/["']/g, "").trim(), stack: s.fontFamily,
             size: s.fontSize, weight: s.fontWeight, selector: sel };
  };
  for (const el of document.querySelectorAll("button, input, [role=button], .card")) {
    const r = getComputedStyle(el).borderTopLeftRadius;
    if (r && r !== "0px") radii[r] = (radii[r] || 0) + 1;
  }
  const vars = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const rule of Array.from(rules || [])) {
      if (rule.selectorText !== ":root" || !rule.style) continue;
      for (const name of Array.from(rule.style)) {
        if (name.startsWith("--")) vars[name] = rule.style.getPropertyValue(name).trim();
      }
    }
  }
  const faces = [];
  try { document.fonts.forEach((f) => faces.push({ family: f.family.replace(/["']/g, ""), weight: f.weight, status: f.status })); } catch (e) {}
  return { bg, text, action, fonts: { body: font("body"), heading: font("h1") || font("h2"), button: font("button, .btn, a.button") },
           radii, vars, faces, title: document.title };
}"""


def sat(hexc):
    r, g, b = (int(hexc[i:i + 2], 16) / 255 for i in (1, 3, 5))
    _, l, s = colorsys.rgb_to_hls(r, g, b)
    return s * (1 - abs(2 * l - 1))


def near(a, b, tol=18):
    return all(abs(int(a[i:i + 2], 16) - int(b[i:i + 2], 16)) <= tol for i in (1, 3, 5))


def merge(weights):
    """Почти одинаковые оттенки (сглаживание, полупрозрачность) — один цвет с суммой весов."""
    out = []
    for c, w in sorted(weights.items(), key=lambda kv: -kv[1]):
        for o in out:
            if near(o[0], c):
                o[1] += w
                break
        else:
            out.append([c, w])
    return out


def summarize(raw, url):
    bg, text, action = merge(raw["bg"]), merge(raw["text"]), merge(raw["action"])
    background = bg[0][0] if bg else None
    ink = next((c for c, _ in text if not background or not near(c, background, 40)), None)
    # акцент: самый частый насыщенный цвет у ссылок и кнопок, иначе — самый насыщенный заметный фон
    accent = next((c for c, _ in action if sat(c) > 0.25 and c not in (background, ink)), None)
    if not accent:
        accent = next((c for c, _ in sorted(bg[1:6], key=lambda x: -sat(x[0])) if sat(c) > 0.25), None)
    total = sum(w for _, w in bg) or 1
    palette = [{"hex": c, "weight": round(w / total, 4), "from": "background"} for c, w in bg[:8]]
    palette += [{"hex": c, "weight": 0, "from": "text"} for c, _ in text[:4] if all(not near(c, p["hex"]) for p in palette)]
    radius = max(raw["radii"].items(), key=lambda kv: kv[1])[0] if raw["radii"] else None
    return {"url": url, "title": raw.get("title", ""), "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "colors": {"background": background, "text": ink, "accent": accent}, "palette": palette,
            "fonts": raw["fonts"], "font_faces": raw["faces"][:20], "radius": radius,
            "css_variables": dict(list(raw["vars"].items())[:80]), "method": "computed styles of the live page"}


def probe(url, shot=None, timeout=30_000):
    from playwright.sync_api import sync_playwright
    ch = os.environ.get("DP_BROWSER_CHANNEL")
    with sync_playwright() as p:
        b = p.chromium.launch(**({"channel": ch} if ch else {}))
        try:
            pg = b.new_page(viewport={"width": 1440, "height": 900})
            pg.goto(url, wait_until="domcontentloaded", timeout=timeout)
            try:
                pg.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass                                   # живые сайты часто не затихают: стили уже есть
            pg.evaluate("() => document.fonts.ready")
            raw = pg.evaluate(COLLECT)
            if shot:
                Path(shot).parent.mkdir(parents=True, exist_ok=True)
                pg.screenshot(path=str(shot))
            return summarize(raw, pg.url)
        finally:
            b.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--shot")
    ap.add_argument("--timeout", type=int, default=30)
    a = ap.parse_args(argv)
    if not a.url.startswith(("http://", "https://")):
        a.url = "https://" + a.url
    try:
        data = probe(a.url, a.shot, a.timeout * 1000)
    except Exception as e:                            # нет сети, антибот, неверный адрес: шаги берут скриншоты
        print(json.dumps({"error": str(e).splitlines()[0][:300]}, ensure_ascii=False))
        return 2
    if a.shot:
        data["screenshot"] = Path(a.shot).name
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"ok": True, "colors": data["colors"], "font": (data["fonts"].get("body") or {}).get("family")},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
