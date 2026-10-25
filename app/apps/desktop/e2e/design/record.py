"""Record a real run.py event log for the «Дизайн» e2e replay.

Runs the real harness (playbooks/site/harness/run.py → flow.py, second_opinion.py, a6proxy.py) with the stub pi CLI
(stub_pi.py) and a fake OpenAI-compatible gateway that passes every second-opinion check. Writes recorded.jsonl:
one line per event, {"turn": n, "say": owner text, "files": [...], "event": {...}}; workspace paths become "{WS}".
Pictures the harness showed are copied next to it (fixtures/).

  python3 record.py --python <venv python with pillow/numpy/playwright> --pipeline <design-pipeline clone>
"""
import argparse, http.server, json, os, shutil, subprocess, sys, tempfile, threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
HARNESS = REPO / "playbooks" / "site" / "harness"

ap = argparse.ArgumentParser()
ap.add_argument("--python", default=sys.executable)
ap.add_argument("--pipeline", required=True)
a = ap.parse_args()

CHECKS = ["lang", "casual", "one_question", "no_empty", "no_broken", "no_dupes", "no_screens", "consistent", "no_stubs"]


class Gateway(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        text = "\n".join(f"{k} | да | не применимо" for k in CHECKS)
        body = json.dumps({"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                           "usage": {"prompt_tokens": 900, "completion_tokens": 60}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


FLOW = ["bash", {"command": "python3 -I design-pipeline/tools/flow.py --page design/landing"}]
READ = ["read", {"path": "design/landing/STATUS.md"}]
MOODS = ("ВЛАДЕЛЬЦУ:\nСобрал три настроения из вашего логотипа: design/landing/00-moods.png\n"
         "A. Тёплое утро: кремовый фон, ржавый акцент\nB. Ночной обжар: тёмный фон, медь\n"
         "C. Чистый лист: белый фон, один акцент\nРекомендую A: ближе всего к цветам логотипа. Какое берём?")
SCRIPT = [
    {"turns": [{"tools": [FLOW, READ]},
               {"text": "ВЛАДЕЛЬЦУ:\nДва вопроса, чтобы начать.\n1. Для кого страница?\nА. Для гостей кофейни\n"
                        "Б. Для оптовых покупателей\n2. Что главное на первом экране?\nА. Меню и цены\nБ. Адрес и часы\n"
                        "Рекомендую 1А 2А. И пришлите, что есть: логотип, скрины, ссылку на сайт."}]},
    {"write": {"design/landing/00-moods.png": "png"},
     "turns": [{"tools": [FLOW, ["read", {"path": "materials/logo.png"}],
                          ["bash", {"command": "python3 -I design-pipeline/tools/palette.py materials/logo.png"}]]},
               {"tools": [["write", {"path": "design/landing/00-moods.md", "content": "…"}],
                          ["bash", {"command": "python3 -I design-pipeline/tools/compare_sheet.py --out design/landing/00-moods.png"}]]},
               {"text": MOODS}]},
    # turn 3: every stage claims «done» without doing it: flow.py keeps the gate, the harness climbs the ladder
    *[{"turns": [{"tools": [FLOW, ["edit", {"path": "design/landing/STATUS.md", "oldText": "a", "newText": "b"}]]},
                 {"text": "ЭТАП ГОТОВ"}]} for _ in range(8)],
]
TURNS = [("сделай лендинг для кофейни «Зерно»", []), ("1А 2А", ["logo.png"]), ("как рекомендуешь", []),
         ("дальше", [])]


def main():
    tmp = Path(tempfile.mkdtemp(prefix="design-record-"))
    ws, agent, mats = tmp / "ws", tmp / "pi-agent", tmp / "mats"
    agent.mkdir()
    mats.mkdir()
    (agent / "stub-script.json").write_text(json.dumps(SCRIPT, ensure_ascii=False), encoding="utf-8")
    sys.path.insert(0, str(HERE))
    import stub_pi
    stub_pi.png(mats / "logo.png", 200, 200, (60, 40, 30))

    gw = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    threading.Thread(target=gw.serve_forever, daemon=True).start()
    (tmp / "key").write_text("sk-record")
    proxy = subprocess.Popen([a.python, "-I", str(HARNESS / "a6proxy.py"), "--port", "0", "--key-file", str(tmp / "key"),
                              "--upstream", f"http://127.0.0.1:{gw.server_address[1]}/v1", "--log", str(tmp / "p.jsonl")],
                             stdout=subprocess.PIPE, text=True)
    port = proxy.stdout.readline().split("127.0.0.1:")[1].split()[0]
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH")}
    env["PATH"] = str(Path(a.python).parent) + os.pathsep + env.get("PATH", "")
    env.update(PI_BIN=json.dumps([a.python, str(HERE / "stub_pi.py")]), PI_CODING_AGENT_DIR=str(agent),
               HARNESS_PROXY=f"http://127.0.0.1:{port}", DP_CHROMIUM_ONLY="1", PYTHONUTF8="1")
    try:
        r = subprocess.run([a.python, str(HARNESS / "run.py"), "init", str(ws), "--page", "landing", "--pipeline",
                            a.pipeline], env=env, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        out, fixtures = [], HERE / "fixtures"
        fixtures.mkdir(exist_ok=True)
        for n, (text, files) in enumerate(TURNS, 1):
            args = [a.python, str(HARNESS / "run.py"), "say", str(ws), text]
            if files:
                args += ["--files", *[str(mats / f) for f in files]]
            r = subprocess.run(args, env=env, capture_output=True, text=True, cwd=ws)
            if r.returncode:
                print(r.stderr[-2000:], file=sys.stderr)
            for ln in r.stdout.splitlines():
                try:
                    ev = json.loads(ln)
                except ValueError:
                    continue
                for f in ev.get("files", []):
                    rel = Path(f).relative_to(ws.resolve())
                    (fixtures / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(f, fixtures / rel)
                ev = json.loads(json.dumps(ev, ensure_ascii=False).replace(str(ws.resolve()), "{WS}"))
                out.append({"turn": n, "say": text, "files": files, "event": ev})
                print(n, json.dumps(ev, ensure_ascii=False)[:160])
        with open(HERE / "recorded.jsonl", "w", encoding="utf-8") as f:
            for rec in out:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        shutil.copyfile(mats / "logo.png", fixtures / "logo.png")
    finally:
        proxy.kill()
        gw.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


main()
