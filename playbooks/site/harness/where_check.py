"""Находка судьи считается, только если код нашёл её место на странице (research/28 §4.4).

У каждой находки в колонке «Где» — селектор (`main > h2`, `.hero .cta`) или регион («390, y=1200»). Код открывает
собранную страницу (site/<page>/index.html) на ширинах 390 и 1440: селектор должен найтись хотя бы на одной, регион —
лежать внутри страницы на своей ширине. Находку, чьё место не нашлось, судья не засчитывает: строка уходит из таблицы
в раздел «## Не подтверждено кодом» и вердикт не держит (так умирает класс «бледный текст на кадре середины анимации»
и выдуманные дефекты). Принцип тот же, что у цитаты во втором мнении «Кода» (second-opinion.ts).

Если страницы нет или браузер не открылся — проверять нечем: все находки остаются, как раньше.
"""
import os
import re
from pathlib import Path

WIDTHS = (390, 1440)
REGION = re.compile(r"\b(\d{3,4})\s*[,;]?\s*(?:px)?\s*[,;]?\s*y\s*=\s*(\d+)", re.I)
TICKS = re.compile(r"`([^`]+)`")
# селектор без кавычек: #id, .class, tag > tag, одиночный тег из списка flow.py
BARE = re.compile(r"(?:[#.][A-Za-z_][\w-]*(?:[\s>+~]*[#.]?[A-Za-z_][\w-]*)*|\b[a-z][\w-]*\s*>\s*[a-z#.][\w#.\s>-]*|"
                  r"\b(?:header|main|footer|nav|section|button|h[1-6]|img|form|figure|ul|li|svg|canvas)\b)")


def targets(where):
    """Что проверить в ячейке «Где»: [("css", селектор)] и [("region", ширина, y)]."""
    out = [("region", int(w), int(y)) for w, y in REGION.findall(where or "")]
    sels = [s.strip() for s in TICKS.findall(where or "") if s.strip()]
    if not sels:
        rest = REGION.sub(" ", where or "")
        sels = [m.group(0).strip() for m in BARE.finditer(rest)]
    out += [("css", s) for s in sels]
    return out


def check(site_html, wheres):
    """Для каждой ячейки «Где» — найдено ли её место на странице. None — проверять нечем (нет страницы, браузера)."""
    site_html = Path(site_html)
    if not site_html.exists():
        return None
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return None
    wanted = [targets(w) for w in wheres]
    found = [False] * len(wheres)
    channel = os.environ.get("DP_BROWSER_CHANNEL")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**({"channel": channel} if channel else {}))
            try:
                for width in WIDTHS:
                    page = browser.new_page(viewport={"width": width, "height": 844 if width < 768 else 900})
                    page.goto(site_html.as_uri(), wait_until="load")
                    height = page.evaluate("() => document.documentElement.scrollHeight")
                    for i, ts in enumerate(wanted):
                        if found[i]:
                            continue
                        for t in ts:
                            if t[0] == "region":
                                if t[1] == width and t[2] < height:
                                    found[i] = True
                            else:
                                try:
                                    if page.query_selector(t[1]):
                                        found[i] = True
                                except Exception:          # не селектор CSS: «кнопка в шапке» — не найдено
                                    pass
                            if found[i]:
                                break
                    page.close()
            finally:
                browser.close()
    except Exception:
        return None
    return found


def split_unconfirmed(answer, rows, ok):
    """Ответ судьи без строк таблицы, чьё место не нашлось, и с разделом «## Не подтверждено кодом» в конце.
    rows — [(текст строки без «Статуса», «Где»)] из flow.judge_lines; ok — check() для их «Где»."""
    bad = [(r, w) for (r, w), good in zip(rows, ok) if not good]
    if not bad:
        return answer, []
    keys = [re.sub(r"\s+", " ", r).strip() for r, _ in bad]
    kept, gone = [], []
    for line in answer.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")] if line.lstrip().startswith("|") else None
        if cells:
            flat = re.sub(r"\s+", " ", " ".join(cells)).strip()
            hit = next((k for k in keys if k and k in flat), None)
            if hit:
                keys.remove(hit)
                gone.append(line)
                continue
        kept.append(line)
    if not gone:
        return answer, []
    note = ["", "## Не подтверждено кодом",
            "Место этих находок не нашлось на странице (селектор или регион из «Где»); в вердикт они не входят."]
    note += [f"- {r.strip()} — «Где»: {w.strip() or 'пусто'}" for r, w in bad]
    return "\n".join(kept).rstrip("\n") + "\n" + "\n".join(note) + "\n", bad
