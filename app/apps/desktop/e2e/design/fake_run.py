"""Fake playbooks/site/harness/run.py for the «Дизайн» e2e: replays recorded.jsonl (a real run.py log) turn by turn.

  init <ws> --page <p> --pipeline <dir>   workspace skeleton + the pictures the recording showed
  say <ws> "<text>" [--files …] [--retry] next recorded turn; after --retry, the finished page (synthetic turn)
  "долго" as the text: one stage, then waits to be cancelled
"""
import argparse, json, os, shutil, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = Path(__file__).with_name("recorded.jsonl")
FIXTURES = Path(__file__).with_name("fixtures")


def emit(ev):
    print(json.dumps(ev, ensure_ascii=False), flush=True)
    time.sleep(0.12)


def state_dir(ws):
    """Same rule as run.py: HARNESS_STATE_DIR, else a legacy <ws>/harness, else a sibling folder."""
    if os.environ.get("HARNESS_STATE_DIR"):
        return Path(os.environ["HARNESS_STATE_DIR"])
    if (ws / "harness" / "state.json").exists():
        return ws / "harness"
    return ws.parent / f".{ws.name}.harness"


def init(a):
    ws = Path(a.ws)
    if not (Path(a.pipeline or "") / "tools" / "flow.py").exists():   # like run.py: no copy, no workspace
        sys.exit("run.py init: нужна копия design-pipeline")
    for d in ("harness", "materials", "owner", f"design/{a.page}", "site"):
        (ws / d).mkdir(parents=True, exist_ok=True)
    src = FIXTURES / "design"
    if src.exists():
        shutil.copytree(src, ws / "design", dirs_exist_ok=True)
    h = state_dir(ws.resolve())
    h.mkdir(parents=True, exist_ok=True)
    (h / "state.json").write_text(json.dumps({"page": a.page, "turn": 0, "pipeline": str(Path(a.pipeline).resolve()),
                                              "models": os.environ.get("HARNESS_MODELS")},
                                             ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"ws": str(ws.resolve()), "page": a.page}, ensure_ascii=False))


def say(a):
    ws = Path(a.ws).resolve()
    st_f = state_dir(ws) / "state.json"
    st = json.loads(st_f.read_text(encoding="utf-8"))
    for f in a.files or []:
        shutil.copyfile(f, ws / "materials" / Path(f).name)
    if a.text == "долго":
        emit({"ev": "stage", "gate": "5", "title": "Страница", "model": "a6p/kimi-k3.1-pro", "attempt": 1})
        time.sleep(600)
        return
    if a.retry:
        page = ws / "site" / st["page"]
        page.mkdir(parents=True, exist_ok=True)
        (page / "index.html").write_text(
            "<!doctype html><html lang=ru><meta charset=utf-8><title>Зерно</title>"
            "<body style='margin:0;font:18px/1.5 Georgia,serif;background:#f4ede1;color:#2b211b'>"
            "<main style='padding:64px 48px'><p style='letter-spacing:.2em;color:#b4532a'>КОФЕЙНЯ</p>"
            "<h1 style='font-size:64px;margin:.2em 0'>Зерно</h1><p>Обжариваем сами, каждое утро.</p></main>",
            encoding="utf-8")
        for ev in ({"ev": "stage", "gate": "5", "title": "Страница", "model": "a6p/kimi-k3.1-pro", "attempt": 1},
                   {"ev": "tool", "name": "write", "brief": f"site/{st['page']}/index.html"},
                   {"ev": "tool", "name": "bash", "brief": "python3 -I design-pipeline/tools/gate.py --url …"},
                   {"ev": "stage", "gate": "8", "title": "Сдача", "model": "a6p/deepseek-v4.1-flash-1017", "attempt": 1},
                   {"ev": "done", "text": "все шаги пройдены"}):
            emit(ev)
        return
    st["turn"] = st.get("turn", 0) + 1
    st_f.write_text(json.dumps(st), encoding="utf-8")
    for line in DATA.read_text(encoding="utf-8").splitlines():
        rec = json.loads(line)
        if rec["turn"] == st["turn"]:
            emit(json.loads(json.dumps(rec["event"], ensure_ascii=False).replace("{WS}", ws.as_posix())))


ap = argparse.ArgumentParser()
sp = ap.add_subparsers(dest="cmd", required=True)
i = sp.add_parser("init"); i.add_argument("ws"); i.add_argument("--page", required=True)
i.add_argument("--materials"); i.add_argument("--pipeline")
s = sp.add_parser("say"); s.add_argument("ws"); s.add_argument("text", nargs="?", default="")
s.add_argument("--files", nargs="*"); s.add_argument("--retry", action="store_true")
a = ap.parse_args()
{"init": init, "say": say}[a.cmd](a)
sys.exit(0)
