"""Проверка эталонов перед прогоном: застывшие цитаты ещё лежат на своих страницах, живые эталоны открываются.

  python3 check_refs.py [--out /tmp/refs-check]      выход 1, если какой-то эталон надо пересмотреть
"""
import argparse, json, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live, score  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=tempfile.mkdtemp(prefix="refs-check-"))
a = ap.parse_args()
qs = json.loads((Path(__file__).resolve().parent / "questions.json").read_text(encoding="utf-8"))["questions"]
rows, bad = [], []
for q in qs:
    if q.get("live"):
        try:
            print(q["id"], "живой:", live.resolve(q["live"])["answer"])
        except Exception as e:
            bad.append(q["id"])
            print(q["id"], "живой эталон не открылся:", e)
    elif q.get("quote") and not q["quote"].startswith("404"):
        rows.append({"id": q["id"], "answer": q["answer"], "sources": [{"url": q["source"], "quote": q["quote"]}]})
s, res = score.score(rows, qs, Path(a.out))
for r in res:
    src = r["sources"][0]
    if not src.get("quote_found"):
        bad.append(r["id"])
        print(r["id"], f"цитаты эталона нет на странице (HTTP {src.get('status')}): {src['url']}")
print("перепроверить руками:", ", ".join(q["id"] for q in qs if q.get("recheck")) or "—")
print("эталоны в порядке" if not bad else "пересмотреть: " + ", ".join(bad))
sys.exit(1 if bad else 0)
