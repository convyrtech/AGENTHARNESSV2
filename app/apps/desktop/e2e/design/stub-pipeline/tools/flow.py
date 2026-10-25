"""Stub of design-pipeline/tools/flow.py for harness checks without the private pipeline.

  flow.py --page <dir> --init   create <dir>/STATUS.md with the passport fields run.py fills
  flow.py --page <dir> --json   step 0 is open: {"exit": 1, "next": {"gate": "0", …}}
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
res = {"page": str(page), "done": [], "exit": 1 if missing else 0,
       "next": {"gate": "0", "title": "Паспорт страницы", "do": "заполнить STATUS.md",
                "problems": [f"в STATUS.md не заполнено «- {f}: ...»" for f in missing]}}
if a.json:
    print(json.dumps(res, ensure_ascii=False))
else:
    print("\n".join(res["next"]["problems"]) or "всё пройдено")
sys.exit(res["exit"])
