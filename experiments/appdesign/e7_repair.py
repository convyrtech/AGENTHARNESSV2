"""Repair two E7 steps that returned no HTML: on supplier 1036 output is capped at 32768 tokens incl. hidden thinking, and Opus with
reasoning_effort=high sometimes thinks past it. Re-run d1 hybrid and c1 rev2 with reasoning_effort=medium; require an html block."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import e6, e7
from e7 import task, small, img, html_of, render, TECH, OUT
MED = ("claude-opus-5-5", {"reasoning_effort": "medium"})
def ask_html(parts, tag):
    for _ in range(3):
        t = e6.ask(MED, parts, tag)
        if "```html" in t or "<!DOCTYPE" in t.upper(): return t
    return ""
k = json.load(open(os.path.join(OUT, "key-do-not-open.json")))
# d1 hybrid
hs = [open(os.path.join(OUT, f"d1-v{i}.html")).read() for i in (1, 2)]
parts = task() + [{"type": "text", "text": "Вариант 1 (код):\n```html\n" + hs[0] + "\n```"}, small(os.path.join(OUT, "d1-v1-full.jpg")),
                  {"type": "text", "text": "Вариант 2 (код):\n```html\n" + hs[1] + "\n```"}, small(os.path.join(OUT, "d1-v2-full.jpg")),
                  {"type": "text", "text": "Сравни два варианта как арт-директор: коротко (до 6 пунктов) — что берёшь из каждого и что исправляешь, затем сверстай ГИБРИД. " + TECH}]
raw = ask_html(parts, "e7-d1-hybrid-repair"); open(os.path.join(OUT, "d1-hybrid-notes.md"), "w").write(raw.split("```html")[0][:4000])
print("d1", render(html_of(raw), os.path.join(OUT, "d1-final")))
# c1 rev2
info = next(i for i in k["infos"] if i["variant"] == "c" and i["sample"] == 1)
extra = [{"type": "text", "text": "Утверждённый макет (сверстай близко к нему; тексты и факты — только из запроса владельца, фото — из assets/):"}, img(os.path.join(OUT, info["mock"]))]
base = os.path.join(OUT, "c1-r1"); html = open(base + ".html").read(); crit = open(os.path.join(OUT, "c1-crit2.md")).read()
raw = ask_html(task() + extra + [{"type": "text", "text": "Текущий код:\n```html\n" + html + "\n```"}, {"type": "text", "text": "Первый экран сейчас:"}, img(base + "-top.png"),
                                 {"type": "text", "text": "Вся страница сейчас:"}, small(base + "-full.jpg"), {"type": "text", "text": "Замечания арт-директора:\n" + crit + "\n\nИсправь. " + TECH}], "e7-c1-rev2-repair")
print("c1", render(html_of(raw), os.path.join(OUT, "c1-final")))
k["note"] = "d1 hybrid and c1 rev2 re-run with reasoning_effort=medium: the original calls hit the 32768-token output cap of supplier 1036 while thinking and returned no HTML"
json.dump(k, open(os.path.join(OUT, "key-do-not-open.json"), "w"), ensure_ascii=False, indent=1)
for tag, L in k["key"].items(): e7.sheet(tag, L)
print("sheets rebuilt", k["key"])
