"""Stub of design-pipeline/tools/flow.py for harness checks without the private pipeline.

  flow.py --page <dir> --init   create <dir>/STATUS.md with the passport fields run.py fills
  flow.py --page <dir> --json   the first open step: 0 passport, 1 movement choice (sheet, videos, «ВЫБОР 1»),
                                2 the page (site/<page>/index.html); exit 0 when all three pass
"""
import argparse, json, sys
from pathlib import Path

for s in (sys.stdout, sys.stderr):
    s.reconfigure(encoding="utf-8", errors="replace")
ap = argparse.ArgumentParser()
ap.add_argument("--page", required=True)
ap.add_argument("--init", action="store_true")
ap.add_argument("--json", action="store_true")
a = ap.parse_args()
page = Path(a.page)
FIELDS = ["Владелец", "Текст владельца", "Канал владельца", "Решения", "Расшифровки голоса", "Исходники",
          "Материалы владельца"]
if a.init:
    page.mkdir(parents=True, exist_ok=True)
    (page / "STATUS.md").write_text("# STATUS\n\n" + "".join(f"- {f}: ...\n" for f in FIELDS), encoding="utf-8")
    print(f"страница заведена: {page}")
    sys.exit(0)
status = (page / "STATUS.md").read_text(encoding="utf-8")
missing = [f for f in FIELDS if f"- {f}: ..." in status]
site = page.parent.parent / "site" / page.name / "index.html"
steps = [
    ("0", "Паспорт страницы", "заполнить STATUS.md", [f"в STATUS.md не заполнено «- {f}: ...»" for f in missing]),
    ("1", "Кандидаты движения", "лист и три видео наборов приёмов, выбор владельца",
     ([] if (page / "01-candidates.png").exists() else ["нет 01-candidates.png"]) +
     ([] if any(ln.startswith("- ВЫБОР 1:") for ln in status.splitlines()) else ["нет строки «ВЫБОР 1» словами владельца"]) +
     ([] if (page / "01-pack.json").exists() else ["нет 01-pack.json (moves.py pick)"])),
    ("2", "Страница", "собрать site/<page>/index.html", [] if site.exists() else [f"нет {site.name}"]),
]
done = [g for g, _, _, pr in steps if not pr]
open_ = next(((g, t, d, pr) for g, t, d, pr in steps if pr), None)
res = {"page": str(page), "done": done, "exit": 1 if open_ else 0}
if open_:
    res["next"] = {"gate": open_[0], "title": open_[1], "do": open_[2], "problems": open_[3]}
if a.json:
    print(json.dumps(res, ensure_ascii=False))
else:
    print("\n".join(res["next"]["problems"]) if open_ else "всё пройдено")
sys.exit(res["exit"])
