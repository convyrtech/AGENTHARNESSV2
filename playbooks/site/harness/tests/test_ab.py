"""Tests for the A/B tools: simulate.py, baseline.py, abreport.py. No network, no model.

  python -m unittest discover -s playbooks/site/harness/tests

The harness is copied to a temp folder with stubs: pi (PI_BIN) walks a fixed list of steps and asks the owner where a
step needs him, flow.py reports that list, judge.py always answers «round limit» (exit 3), second_opinion.py passes.
The a6 log is a local HTTP server. With DESIGN_PIPELINE (a design-pipeline copy) and AB_PYTHON (a Python with
Playwright and Chromium) the blind sheet is shot for real.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
PY = sys.executable

# step list shared by the stubs: (flow gate, simulate key or None when the step needs no owner)
STEPS = '[("0a", "0a"), ("1", "1"), ("2a", "2a"), ("3", "3"), ("5", "5s"), ("5", "5"), ("6", None), ("7", None), ("8", "8")]'

STUB_FLOW = '''import json, sys
for _s in (sys.stdout, sys.stderr):  # Windows: cp1252 pipe under -I
    _s.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
STEPS = %s
a = sys.argv[1:]
page = Path(a[a.index("--page") + 1])
if "--init" in a:
    page.mkdir(parents=True, exist_ok=True)
    (page / "STATUS.md").write_text("# STATUS\\n- Канал владельца: ?\\n- Решения: ?\\n- Текст владельца: ?\\n"
                                    "- Материалы владельца: ?\\n- Эталон:\\n", encoding="utf-8")
    print("flow: init")
    sys.exit(0)
st = json.loads((page / "stub.json").read_text(encoding="utf-8")) if (page / "stub.json").exists() else {"idx": 0}
i = st["idx"]
if i >= len(STEPS):
    res = {"exit": 0, "done": [g for g, _ in STEPS]}
else:
    g, key = STEPS[i]
    probs = (["нет 05-storyboard.png (раскадровка всей страницы)"] if key == "5s" else
             ["нет вердикта судьи (artifacts/judge/JUDGE.md)"] if g == "7" else ["шаг %%s не сделан" %% g])
    res = {"exit": 1, "next": {"gate": g, "title": "шаг " + g, "problems": probs, "do": "сделай шаг"}}
print(json.dumps(res, ensure_ascii=False))
sys.exit(res["exit"])
''' % STEPS

STUB_PI = '''import json, sys
for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
STEPS = %s
a = sys.argv[1:]
session = Path(a[a.index("--session") + 1])
model = a[a.index("--model") + 1]
text = Path(next(x for x in a if x.startswith("@"))[1:]).read_text(encoding="utf-8")
with open(session, "a", encoding="utf-8") as f:
    f.write(json.dumps({"model": model, "prompt": text[:300]}, ensure_ascii=False) + "\\n")
page = Path.cwd() / "design" / "landing"
stf = page / "stub.json"
st = json.loads(stf.read_text(encoding="utf-8")) if stf.exists() else {"idx": 0}
st.setdefault("asked", -1); st.setdefault("asked_n", 0); st.setdefault("repeated", [])
n = len((Path.cwd() / "owner" / "messages.jsonl").read_text(encoding="utf-8").splitlines())
rf = Path(__file__).with_name("repeat.txt")
repeat = rf.read_text(encoding="utf-8").strip() if rf.exists() else ""
final = ""
while st["idx"] < len(STEPS):
    i = st["idx"]
    g, key = STEPS[i]
    if key:
        if st["asked"] == i and n > st["asked_n"]:
            if key == repeat and key not in st["repeated"]:     # asks the same step again
                st["repeated"].append(key)
            else:
                st["idx"] += 1
                st["asked"] = -1
                continue
        st["asked"], st["asked_n"] = i, n
        final = "ВЛАДЕЛЬЦУ:\\n1. Как вам шаг %%s?\\nА. Да (рекомендую)\\nБ. Нет" %% key
        break
    if g == "7" and "после лимита судьи" not in text:
        final = "гейт зелёный, осталась судья\\nЭТАП ГОТОВ"
        break
    st["idx"] += 1
stf.write_text(json.dumps(st), encoding="utf-8")
call = {"type": "toolCall", "name": "bash", "arguments": {"command": "python3 -I design-pipeline/tools/flow.py #%%d" %% st["idx"]}}
msg = {"role": "assistant", "content": [call, {"type": "text", "text": final}],
       "usage": {"input": 1000, "output": 100, "cacheRead": 0, "cost": {"total": 0.002}}}
print(json.dumps({"type": "message_end", "message": msg}, ensure_ascii=False))
''' % STEPS

STUB_JUDGE = '''import sys
for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
a = sys.argv[1:]
page = Path(a[a.index("--page") + 1])
(page / "artifacts" / "judge").mkdir(parents=True, exist_ok=True)
(page / "artifacts" / "judge" / "JUDGE.md").write_text(
    "| Серьёзность | Что | Где | Статус |\\n|---|---|---|---|\\n| Critical | пусто | 390 | |\\n| Minor | шрифт | 1440 | |\\n",
    encoding="utf-8")
print("судья: лимит раундов")
sys.exit(3)
'''

STUB_SECOND = 'import json; print(json.dumps({"verdict": "PASS", "items": []}))\n'

E8P = json.loads((HARNESS / "owner-e8p.json").read_text(encoding="utf-8"))
ANSWERS = [E8P["answers"][k] for k in ("0a", "1", "2a", "3", "5s", "5", "7j")]


def lab(root):
    """Harness copy with stubs + stub pipeline + materials."""
    h = root / "playbooks" / "site" / "harness"
    h.mkdir(parents=True)
    (root / "playbooks" / "site" / "motion").mkdir()
    for f in ("run.py", "baseline.py", "simulate.py", "abreport.py", "stages.json", "AGENTS.md", "check.py", "moves.py",
              "owner-e8p.json"):
        shutil.copyfile(HARNESS / f, h / f)
    (h / "judge.py").write_text(STUB_JUDGE, encoding="utf-8")
    (h / "second_opinion.py").write_text(STUB_SECOND, encoding="utf-8")
    pipe = root / "pipeline"
    (pipe / "tools").mkdir(parents=True)
    (pipe / "tools" / "flow.py").write_text(STUB_FLOW, encoding="utf-8")
    (pipe / "PIPELINE.md").write_text("# PIPELINE\n\n## Шаг 0a. Настроение\nвыбор\n", encoding="utf-8")
    (root / "stub_pi.py").write_text(STUB_PI, encoding="utf-8")
    mats = root / "материалы"
    mats.mkdir()
    (mats / "kabinet.png").write_bytes(b"\x89PNG fake")
    return h, pipe, mats


def simulate(h, pipe, mats, root, driver, name, *extra):
    ws, rec = root / name / "сайт", root / f"{name}-record"
    env = {**os.environ, "PI_BIN": json.dumps([PY, str(root / "stub_pi.py")]), "PYTHONUTF8": "1"}
    env.pop("HARNESS_STATE_DIR", None)
    r = subprocess.run([PY, str(h / "simulate.py"), "--driver", driver, "--ws", str(ws), "--record", str(rec),
                        "--pipeline", str(pipe), "--materials", str(mats), *extra], env=env, capture_output=True,
                       text=True, encoding="utf-8", timeout=300)
    return ws, rec, r


def turns(rec):
    return [json.loads(x) for x in (rec / "turns.jsonl").read_text(encoding="utf-8").splitlines()]


class AB(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="ab-")
        cls.root = Path(cls.tmp.name)
        cls.h, cls.pipe, cls.mats = lab(cls.root)
        cls.run_ws, cls.run_rec, r1 = simulate(cls.h, cls.pipe, cls.mats, cls.root, "run", "дирижёр")
        assert r1.returncode == 0, r1.stdout + r1.stderr
        cls.base_ws, cls.base_rec, r2 = simulate(cls.h, cls.pipe, cls.mats, cls.root, "baseline", "база")
        assert r2.returncode == 0, r2.stdout + r2.stderr

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    # ---------- simulate.py ----------
    def check_run(self, ws, rec, driver):
        ts = turns(rec)
        self.assertEqual([t["key"] for t in ts if t["end"] == "owner"], ["0a", "1", "2a", "3", "5s", "5", "7j", "8"])
        sent = [t["sent"] for t in ts if t["sent"]]
        self.assertEqual(sent[0], E8P["first"] + "\n" + E8P["materials_text"])
        self.assertEqual(sent[1:], ANSWERS)
        self.assertEqual(ts[0]["files"], ["kabinet.png"])
        self.assertTrue((ws / "materials" / "kabinet.png").exists())
        self.assertTrue(all(t.get("scripted") for t in ts[1:] if t["sent"]))
        run = json.loads((rec / "run.json").read_text(encoding="utf-8"))
        self.assertEqual((run["driver"], run["reached_gate"], run["owner_messages"]), (driver, "8", 8))
        self.assertIn("шаг 8", run["stop"])
        # harness state in the record, nothing of it in or next to the agent's folder
        self.assertTrue((rec / "state" / "state.json").exists())
        self.assertFalse((ws / "harness" / "state.json").exists())
        self.assertEqual([p.name for p in ws.parent.iterdir()], ["сайт"])
        msgs = (ws / "owner" / "messages.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(msgs), 8)
        return ts

    def test_orchestrator_run_follows_the_script(self):
        self.check_run(self.run_ws, self.run_rec, "run")
        ledger = [json.loads(x) for x in (self.run_rec / "state" / "ledger.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertIn("judge", {r["kind"] for r in ledger})
        sessions = list((self.run_rec / "state" / "sessions").glob("*.jsonl"))
        self.assertGreater(len([s for s in sessions if not s.name.endswith(".events.jsonl")]), 5)  # fresh session per step

    def test_baseline_keeps_one_session(self):
        self.check_run(self.base_ws, self.base_rec, "baseline")
        sess = self.base_rec / "state" / "sessions"
        self.assertEqual(sorted(p.name for p in sess.glob("*.jsonl")), ["baseline.events.jsonl", "baseline.jsonl"])
        runs = [json.loads(x) for x in (sess / "baseline.jsonl").read_text(encoding="utf-8").splitlines()]
        ledger = [json.loads(x) for x in (self.base_rec / "state" / "ledger.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(runs), sum(1 for r in ledger if r["kind"] in ("stage", "fix")))
        self.assertEqual({r["model"] for r in runs}, {"a6p/kimi-k3.1-pro"})
        self.assertIn("Ты ведёшь страницу design/landing целиком в этой сессии", runs[0]["prompt"])
        agents = (self.base_ws / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("Ты ведёшь всю страницу в одной\nсессии", agents)
        self.assertNotIn("Каждый твой запуск", agents)
        self.assertIn("## Судья", agents)                             # the rest of the rules stays

    def test_repeat_and_unscripted(self):
        (self.root / "repeat.txt").write_text("2a")
        try:
            sc = self.root / "script.json"
            sc.write_text(json.dumps({**E8P, "answers": {k: v for k, v in E8P["answers"].items() if k != "3"}},
                                     ensure_ascii=False), encoding="utf-8")
            ws, rec, r = simulate(self.h, self.pipe, self.mats, self.root, "baseline", "повтор", "--script", str(sc),
                                  "--materials-with", "ask")
        finally:
            (self.root / "repeat.txt").unlink()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        ts = turns(rec)
        self.assertEqual([t["key"] for t in ts if t["end"] == "owner"],
                         ["0a", "1", "2a", "2a", "3", "5s", "5", "7j", "8"])
        self.assertEqual(ts[0]["files"], [])                       # «ask»: materials go with the first answer
        self.assertEqual(ts[1]["files"], ["kabinet.png"])
        self.assertEqual(ts[1]["sent"], E8P["materials_text"] + "\n" + E8P["answers"]["0a"])
        three = next(t for t in ts if t.get("answers") == "3")
        self.assertEqual((three["sent"], three["scripted"]), (E8P["answers"]["*"], False))
        m = self.report(self.run_rec, rec)["B"]
        self.assertEqual((m["repeats"], m["repeated_keys"], m["unscripted_answers"]), (1, ["2a"], 1))

    def test_max_turns_and_record_outside_ws(self):
        ws, rec, r = simulate(self.h, self.pipe, self.mats, self.root, "run", "коротко", "--max-turns", "3")
        self.assertEqual(r.returncode, 0, r.stderr)
        run = json.loads((rec / "run.json").read_text(encoding="utf-8"))
        self.assertEqual((run["stop"], run["turns"]), ("лимит ходов 3", 3))
        bad = subprocess.run([PY, str(self.h / "simulate.py"), "--driver", "run", "--ws", str(ws), "--record",
                              str(ws / "rec"), "--pipeline", str(self.pipe)], capture_output=True, text=True,
                             encoding="utf-8")
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("агент увидит", bad.stderr)

    # ---------- abreport.py ----------
    def report(self, a, b, *extra):
        out = Path(tempfile.mkdtemp(dir=self.root))
        r = subprocess.run([PY, str(self.h / "abreport.py"), "compare", str(a), str(b), "--out", str(out), *extra],
                           capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.out = out
        return json.loads((out / "report.json").read_text(encoding="utf-8"))

    def test_report_metrics(self):
        rep = self.report(self.run_rec, self.base_rec, "--pipeline", str(self.pipe))
        a, b = rep["A"], rep["B"]
        self.assertEqual((a["driver"], b["driver"]), ("run", "baseline"))
        for m in (a, b):
            self.assertEqual((m["reached_gate"], m["owner_messages"], m["questions"], m["repeats"]), ("8", 8, 8, 0))
            self.assertIsNone(m["a6"])
            self.assertGreater(m["tool_calls"], 0)
            self.assertEqual(m["judge_calls"], 1)
        self.assertEqual(b["sessions"], 1)
        self.assertGreater(a["sessions"], 5)
        self.assertGreaterEqual(b["launches"], b["sessions"])
        md = (self.out / "report.md").read_text(encoding="utf-8")
        self.assertIn("| Дошёл до шага | 8 | 8 |", md)
        self.assertIn("не забран", md)
        self.assertIn("нет страницы", rep["blind"]["error"])          # no site/ in the stub runs yet

    def test_cost_from_the_a6_log(self):
        ts = turns(self.run_rec)
        inside = int(ts[2]["t0"]) + 1
        rows = [{"created_at": inside, "quota": 250000, "model_name": "kimi-k3.1-pro", "use_time": 3},
                {"created_at": inside, "quota": 50000, "model_name": "claude-opus-5-5", "use_time": 9},
                {"created_at": int(ts[0]["t0"]) - 3600, "quota": 999999, "model_name": "kimi-k3.1-pro", "use_time": 1}]
        seen = []

        class Log(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization")))
                body = json.dumps({"data": rows}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", 0), Log)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        key = self.root / "a6.key"
        key.write_text("sk-test\n")
        rec = self.root / "cost-record"
        shutil.copytree(self.run_rec, rec)
        try:
            r = subprocess.run([PY, str(self.h / "abreport.py"), "cost", "--record", str(rec), "--key-file", str(key),
                                "--a6-url", f"http://127.0.0.1:{srv.server_port}"], capture_output=True, text=True,
                               encoding="utf-8")
        finally:
            srv.shutdown()
            srv.server_close()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(seen, [("/api/log/token", "Bearer sk-test")])
        self.assertNotIn("sk-test", r.stdout)
        saved = json.loads((rec / "a6-rows.json").read_text(encoding="utf-8"))
        self.assertTrue(saved["covered"])
        self.assertEqual(len(saved["rows"]), 2)
        m = self.report(rec, self.base_rec)["A"]["a6"]
        self.assertEqual((m["usd"], m["calls"]), (0.6, 2))
        self.assertEqual(m["by_model"]["kimi-k3.1-pro"], {"calls": 1, "usd": 0.5})
        self.assertIn("$0.6000 (2 выз.)", (self.out / "report.md").read_text(encoding="utf-8"))

    def test_cost_flags_a_log_that_starts_after_the_run(self):
        sys.path.insert(0, str(self.h))
        try:
            import abreport
        finally:
            sys.path.pop(0)
        start = turns(self.run_rec)[0]["t0"]
        rows = [{"created_at": start + 10_000 + i, "quota": 1, "model_name": "m"} for i in range(1000)]
        orig = abreport.fetch_rows
        abreport.fetch_rows = lambda url, key: rows
        rec = self.root / "late-record"
        shutil.copytree(self.run_rec, rec)
        key = self.root / "k2"
        key.write_text("k")
        try:
            abreport.main(["cost", "--record", str(rec), "--key-file", str(key)])
        finally:
            abreport.fetch_rows = orig
        self.assertFalse(json.loads((rec / "a6-rows.json").read_text(encoding="utf-8"))["covered"])

    @unittest.skipUnless(os.environ.get("DESIGN_PIPELINE") and os.environ.get("AB_PYTHON"),
                         "DESIGN_PIPELINE + AB_PYTHON (Python with Playwright): the blind sheet is shot for real")
    def test_blind_sheet(self):
        for ws, color, word in ((self.run_ws, "#f3eee3", "Дирижёр"), (self.base_ws, "#1e2a3b", "Сессия")):
            (ws / "site" / "landing").mkdir(parents=True, exist_ok=True)
            (ws / "site" / "landing" / "index.html").write_text(
                f"<!doctype html><meta charset=utf-8><body style='margin:0;background:{color}'><h1>{word}</h1>",
                encoding="utf-8")
        self.addCleanup(lambda: [(ws / "site" / "landing" / "index.html").unlink() for ws in (self.run_ws, self.base_ws)])
        labels = set()
        for seed in range(6):
            rep = self.report(self.run_rec, self.base_rec, "--pipeline", os.environ["DESIGN_PIPELINE"], "--python",
                              os.environ["AB_PYTHON"], "--seed", str(seed))
            self.assertIn("sheet", rep["blind"], rep["blind"])
            self.assertEqual(sorted(p.name for p in (self.out / "blind").iterdir()), ["sheet.png"])
            key = json.loads((self.out / "blind-key.json").read_text(encoding="utf-8"))
            self.assertEqual(sorted(key), ["А", "Б"])
            self.assertEqual(sorted(v["driver"] for v in key.values()), ["baseline", "run"])
            labels.add(key["А"]["driver"])
            md = (self.out / "report.md").read_text(encoding="utf-8")
            self.assertNotIn("А:", md)
        self.assertEqual(labels, {"run", "baseline"})                 # the order really changes


if __name__ == "__main__":
    unittest.main()
