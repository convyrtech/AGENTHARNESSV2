"""Fake playbooks/site/harness/run.py replaying the real 8-turn run (fixtures/ab-run-2026-10-25).

  init <ws> --page <p> --pipeline <dir>   workspace skeleton (as fake_run.py)
  say <ws> "<text>" [--files …]           the next recorded turn, events/NN.jsonl

Settings come from replay.json next to this file (main passes run.py an allowlisted env):
  speed     each gap between events is slept for gap / speed seconds (default 120); every event's
            `t` moves onto a clock that starts now at the recording's pace, so the app sees the
            real durations
  turnEnd   N: a turn stops after N events and waits to be cancelled (a turn in progress)
  silence   true: the events of a stopped turn are 4 minutes old (a long silence)
Pictures the messages point to are replaced by fixtures/design/landing/01-candidates.png.
"""
import argparse, json, os, shutil, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "fixtures" / "ab-run-2026-10-25"
PLACEHOLDER = HERE / "fixtures" / "design" / "landing" / "01-candidates.png"
RECORDED_WS = "/home/user/ab/run/сайт"
CONFIG = json.loads((HERE / "replay.json").read_text(encoding="utf-8")) if (HERE / "replay.json").exists() else {}
SPEED = float(CONFIG.get("speed", 120))


def state_dir(ws):
    if os.environ.get("HARNESS_STATE_DIR"):
        return Path(os.environ["HARNESS_STATE_DIR"])
    if (ws / "harness" / "state.json").exists():
        return ws / "harness"
    return ws.parent / f".{ws.name}.harness"


def init(a):
    ws = Path(a.ws)
    if not (Path(a.pipeline or "") / "tools" / "flow.py").exists():
        sys.exit("run.py init: нужна копия design-pipeline")
    for d in ("harness", "materials", "owner", f"design/{a.page}", "site"):
        (ws / d).mkdir(parents=True, exist_ok=True)
    h = state_dir(ws.resolve())
    h.mkdir(parents=True, exist_ok=True)
    (h / "state.json").write_text(json.dumps({"page": a.page, "turn": 0}), encoding="utf-8")
    print(json.dumps({"ws": str(ws.resolve()), "page": a.page}, ensure_ascii=False))


def relocate(ev, ws):
    """The recording's paths point into its own workspace: move them here, with stand-in pictures."""
    text = json.dumps(ev, ensure_ascii=False).replace(RECORDED_WS, ws.as_posix())
    ev = json.loads(text)
    for f in ev.get("files") or []:
        p = Path(f)
        if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp") and not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PLACEHOLDER, p)
    return ev


def say(a):
    ws = Path(a.ws).resolve()
    st_f = state_dir(ws) / "state.json"
    st = json.loads(st_f.read_text(encoding="utf-8"))
    for f in a.files or []:
        shutil.copyfile(f, ws / "materials" / Path(f).name)
    st["turn"] = st.get("turn", 0) + 1
    st_f.write_text(json.dumps(st), encoding="utf-8")
    events = [json.loads(line) for line in
              (RUN / "events" / f"{st['turn']:02d}.jsonl").read_text(encoding="utf-8").splitlines()]
    stop_after = int(CONFIG.get("turnEnd", 0) or 0)
    silence = 240 if CONFIG.get("silence") and stop_after else 0
    t0 = events[0]["t"]
    start = time.time() - silence
    prev = t0
    for n, ev in enumerate(events, 1):
        time.sleep(max(0.0, min(ev["t"] - prev, 600)) / SPEED)
        prev = ev["t"]
        ev = relocate(ev, ws)
        ev["t"] = start + (ev["t"] - t0)
        print(json.dumps(ev, ensure_ascii=False), flush=True)
        if stop_after and n >= stop_after:
            time.sleep(3600)
            return


ap = argparse.ArgumentParser()
sp = ap.add_subparsers(dest="cmd", required=True)
i = sp.add_parser("init"); i.add_argument("ws"); i.add_argument("--page", required=True)
i.add_argument("--materials"); i.add_argument("--pipeline")
s = sp.add_parser("say"); s.add_argument("ws"); s.add_argument("text", nargs="?", default="")
s.add_argument("--files", nargs="*"); s.add_argument("--retry", action="store_true")
a = ap.parse_args()
{"init": init, "say": say}[a.cmd](a)
sys.exit(0)
