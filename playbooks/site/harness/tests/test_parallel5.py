"""Step 5 behind stages.json → 5.parallel: prototypes from 2–3 one-shot calls at once (research/20, question 3).

  python -m unittest discover -s playbooks/site/harness/tests
  PI_CLI=<pi's cli.js>   + one call through the real Pi (no tools) against a fake model server

A stub Pi stands for the model: it answers a one-shot call (--no-tools) with a whole index.html after a pause, so the
calls running at once show in the wall time; a model named …/broken answers with no page.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
PY = sys.executable
sys.path.insert(0, str(HERE))
from test_ask_owner import FakeModel, NORMAL, load_run, pi_cli  # noqa: E402

PAGE = ("<!doctype html><html lang=ru><head><meta charset=utf-8><title>Зерно</title><style>body{margin:0}"
        + "p{margin:0 0 1em}" * 60 + "</style></head><body><main data-signature>"
        "<h1>Зерно — {model}</h1>" + "<p>Обжариваем сами, каждое утро.</p>" * 10 + "</main></body></html>")

STUB_PI = r'''import json, os, sys, time
for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
a = sys.argv[1:]
model = a[a.index("--model") + 1]
brief = Path(next(x for x in a if x.startswith("@"))[1:]).read_text(encoding="utf-8")
# one file per call: on Windows appends to one file from parallel processes are not atomic (a call went missing)
log = Path(__file__).with_name("calls")
log.mkdir(exist_ok=True)
(log / f"{time.time_ns():020d}-{os.getpid()}.json").write_text(
    json.dumps({"model": model, "one_shot": "--no-tools" in a, "brief": brief[:4000]}, ensure_ascii=False), encoding="utf-8")
def end(content, cost=0.01):
    print(json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": content,
          "usage": {"input": 5000, "output": 3000, "cost": {"total": cost}}}}, ensure_ascii=False))
if "--no-tools" in a:                       # a one-shot prototype call
    time.sleep(1.0)
    if model.endswith("broken"):
        end([{"type": "text", "text": "Извините, не могу."}])
    else:
        end([{"type": "text", "text": "```html\n" + PAGE.replace("{model}", model) + "\n```"}])
    sys.exit(0)
# the step session after the prototypes: looks at the sheet and asks the owner with the tool
ask = json.loads(Path(__file__).with_name("ask.json").read_text(encoding="utf-8"))
end([{"type": "toolCall", "name": "ask_owner", "arguments": {}}])
print(json.dumps({"type": "tool_execution_end", "toolName": "ask_owner", "isError": False,
                  "result": {"content": [], "details": ask, "terminate": True}}, ensure_ascii=False))
'''.replace("PAGE", repr(PAGE))

def read_calls(tmp):
    """The stub's calls in the order they started (file names are nanosecond stamps)."""
    d = tmp / "calls"
    return [json.loads(f.read_text(encoding="utf-8")) for f in sorted(d.glob("*.json"))] if d.exists() else []


STUB_FLOW = r'''import json, sys
for _s in (sys.stdout, sys.stderr):
    _s.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
a = sys.argv[1:]
page = Path(a[a.index("--page") + 1])
if "--init" in a:
    page.mkdir(parents=True, exist_ok=True)
    (page / "STATUS.md").write_text("# STATUS\n", encoding="utf-8")
    sys.exit(0)
probs = [f"нет 05-proto/{x}/index.html" for x in "ab" if not (page / "05-proto" / x / "index.html").exists()]
if not probs and not (page / "05-compare.png").exists():
    probs = ["нет 05-compare.png"]
probs = probs or ["нет строки выбора владельца: «ВЫБОР 5: …»"]
print(json.dumps({"exit": 1, "next": {"gate": "5", "title": "Прототипы", "problems": probs}}, ensure_ascii=False))
sys.exit(1)
'''

STUB_SHEET = r'''import sys
from pathlib import Path
a = sys.argv[1:]
assert a.count("--variant") == 2, a
Path(a[a.index("--out") + 1]).write_bytes(b"\x89PNG sheet")
'''


class Ws:
    """What parallel_protos needs of run.py's WS."""

    def __init__(self, root):
        self.root = root
        self.page = root / "design" / "landing"
        self.pipe = root / "design-pipeline"
        self.h = root / "state"
        for d in (self.page, self.pipe / "tools", self.h):
            d.mkdir(parents=True, exist_ok=True)
        (self.pipe / "tools" / "compare_sheet.py").write_text(STUB_SHEET, encoding="utf-8")
        (self.page / "02-brand.md").write_text("## Токены\n| --ink | #2b211b |\n| --paper | #f4ede1 |\n", encoding="utf-8")
        (self.page / "FACTS.md").write_text("Обжариваем сами, каждое утро. 180 ₽ за чашку.\n", encoding="utf-8")
        (self.root / "materials").mkdir()
        (self.root / "materials" / "brand.json").write_text(json.dumps({"colors": {"accent": "#b4532a"}}),
                                                            encoding="utf-8")
        self.records = []

    def env(self):
        return dict(os.environ)

    def ledger(self, **rec):
        self.records.append(rec)


class Parallel(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "stub_pi.py").write_text(STUB_PI, encoding="utf-8")
        os.environ["PI_BIN"] = json.dumps([PY, str(self.tmp / "stub_pi.py")])
        self.g = load_run()
        self.ws = Ws(self.tmp / "ws")

    def run_protos(self, ladder):
        self.g["CFG"]["ladder"] = ladder
        t0 = time.time()
        calls = self.g["parallel_protos"](self.ws, {"start": 0, "parallel_variants": 3, "parallel_minutes": 1})
        return calls, time.time() - t0

    def proto(self, letter):
        f = self.ws.page / "05-proto" / letter / "index.html"
        return f.read_text(encoding="utf-8") if f.exists() else None

    def test_three_at_once_two_into_work_and_the_sheet(self):
        calls, took = self.run_protos(["a6p/deepseek", "a6p/kimi", "a6p/opus"])
        self.assertEqual(calls, 3)
        self.assertLess(took, 2.6)                             # three 1 s calls at once, not one after another
        self.assertIn("Зерно — a6p/deepseek", self.proto("a"))
        self.assertIn("Зерно — a6p/kimi", self.proto("b"))
        self.assertIsNone(self.proto("c"))                     # step 5 takes A, B or a hybrid
        self.assertTrue((self.ws.page / "05-compare.png").exists())
        protos = [r for r in self.ws.records if r["kind"] == "proto"]
        self.assertEqual([(r["variant"], r["model"], r["ok"]) for r in protos],
                         [("A", "a6p/deepseek", True), ("B", "a6p/kimi", True), ("C", "a6p/opus", True)])
        for r in protos:                                       # time and price of every variant
            self.assertGreaterEqual(r["seconds"], 1)
            self.assertAlmostEqual(r["cost"], 0.01)
        briefs = [c["brief"] for c in read_calls(self.tmp)]
        for b in briefs:
            self.assertIn("побеждает дизайн-система", b)
            self.assertIn("| --ink | #2b211b |", b)
            self.assertIn("#b4532a", b)
            self.assertIn("180 ₽ за чашку", b)
        self.assertEqual(len({b.split("Характер этого варианта: ")[1].split("\n")[0] for b in briefs}), 3)

    def test_one_broken_call_does_not_fail_the_step(self):
        calls, _ = self.run_protos(["a6p/deepseek", "a6p/broken", "a6p/opus"])
        self.assertEqual(calls, 3)
        self.assertIn("a6p/deepseek", self.proto("a"))
        self.assertIn("a6p/opus", self.proto("b"))
        bad = [r for r in self.ws.records if r["kind"] == "proto" and not r["ok"]]
        self.assertEqual([(r["variant"], r["error"]) for r in bad], [("B", "в ответе нет целого index.html")])

    def test_fewer_than_two_falls_back_to_the_old_way(self):
        calls, _ = self.run_protos(["a6p/broken", "a6p/opus", "a6p/broken"])
        self.assertEqual(calls, 0)
        self.assertIsNone(self.proto("a"))
        self.assertFalse((self.ws.page / "05-compare.png").exists())
        self.assertEqual(self.ws.records[-1], {"kind": "proto_fallback", "gate": "5", "ok": 1})

    def test_a_slow_call_times_out(self):
        self.g["CFG"]["ladder"] = ["a6p/deepseek", "a6p/kimi"]
        calls = self.g["parallel_protos"](self.ws, {"start": 0, "parallel_variants": 2, "parallel_minutes": 0.01})
        self.assertEqual(calls, 0)
        self.assertTrue(all(r["error"].startswith("время вышло") for r in self.ws.records if r["kind"] == "proto"))

    def test_extract_html(self):
        x = self.g["extract_html"]
        page = PAGE.replace("{model}", "m")
        self.assertEqual(x("Вот:\n```html\n" + page + "\n```\nГотово."), page)
        self.assertEqual(x("пояснение\n" + page), page)
        self.assertIsNone(x("```html\n<html><body>мало</body></html>\n```"))
        self.assertIsNone(x("Не могу."))


class Say(unittest.TestCase):
    """run.py say with the flag: prototypes at once, then the step session asks the owner with the tool."""

    def lab(self, parallel):
        tmp = Path(tempfile.mkdtemp())
        h = tmp / "playbooks" / "site" / "harness"
        h.mkdir(parents=True)
        (tmp / "playbooks" / "site" / "motion").mkdir()
        for f in ("run.py", "stages.json", "AGENTS.md", "check.py", "brand_check.py", "moves.py", "ask_owner.ts"):
            shutil.copyfile(HARNESS / f, h / f)
        (h / "second_opinion.py").write_text('import json; print(json.dumps({"verdict": "PASS", "items": []}))\n',
                                             encoding="utf-8")
        (tmp / "stub_pi.py").write_text(STUB_PI, encoding="utf-8")
        (tmp / "ask.json").write_text(json.dumps(NORMAL, ensure_ascii=False), encoding="utf-8")
        pipe = tmp / "pipeline"
        (pipe / "tools").mkdir(parents=True)
        (pipe / "tools" / "flow.py").write_text(STUB_FLOW, encoding="utf-8")
        (pipe / "tools" / "compare_sheet.py").write_text(STUB_SHEET, encoding="utf-8")
        (pipe / "PIPELINE.md").write_text("# PIPELINE\n", encoding="utf-8")
        env = {**os.environ, "PI_BIN": json.dumps([PY, str(tmp / "stub_pi.py")]), "PYTHONUTF8": "1",
               "HARNESS_STATE_DIR": str(tmp / "state"), "HARNESS_PARALLEL5": "1" if parallel else "0"}
        ws = tmp / "сайт"
        run = lambda *a: subprocess.run([PY, "-I", str(h / "run.py"), *a], env=env, capture_output=True, text=True,
                                        encoding="utf-8", timeout=120)
        r = run("init", str(ws), "--page", "landing", "--pipeline", str(pipe))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return tmp, ws, run

    def calls(self, tmp):
        return read_calls(tmp)

    def test_flag_on(self):
        tmp, ws, run = self.lab(parallel=True)
        r = run("say", str(ws), "Сделай лендинг")
        ev = [json.loads(x) for x in r.stdout.splitlines() if x.startswith("{")]
        self.assertEqual([e["ev"] for e in ev if e["ev"] == "owner"], ["owner"], r.stdout[-1500:] + r.stderr[-800:])
        calls = self.calls(tmp)
        self.assertEqual([c["one_shot"] for c in calls], [True, True, True, False])
        self.assertIn("собрал харнесс параллельно", calls[-1]["brief"])
        self.assertTrue((ws / "design" / "landing" / "05-proto" / "b" / "index.html").exists())
        ledger = [json.loads(x) for x in (tmp / "state" / "ledger.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len([x for x in ledger if x["kind"] == "proto"]), 3)
        state = json.loads((tmp / "state" / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["parallel5"], {"calls": 3})

    def test_flag_off_is_the_old_way(self):
        tmp, ws, run = self.lab(parallel=False)
        run("say", str(ws), "Сделай лендинг")
        self.assertEqual([c["one_shot"] for c in self.calls(tmp)], [False])


class Report(unittest.TestCase):
    def test_step5_time_counts_a_batch_by_its_longest_call(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("abreport", HARNESS / "abreport.py")
        ab = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ab)
        rec = Path(tempfile.mkdtemp())
        (rec / "state").mkdir()
        (rec / "run.json").write_text(json.dumps({"driver": "run", "ws": "w", "page": "landing"}), encoding="utf-8")
        (rec / "turns.jsonl").write_text("", encoding="utf-8")
        rows = [{"kind": "proto", "gate": "5", "batch": "b1", "seconds": s, "ok": ok, "cost": 0.02}
                for s, ok in ((100, True), (160, True), (40, False))]
        rows += [{"kind": "stage", "gate": "5", "seconds": 80, "calls": 6}, {"kind": "stage", "gate": "6", "seconds": 600}]
        (rec / "state" / "ledger.jsonl").write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
        m = ab.metrics(rec)
        self.assertEqual(m["step5_minutes"], 4.0)            # 160 s of the batch + 80 s of the session
        self.assertEqual(m["protos"], {"ok": 2, "all": 3, "cost_usd": 0.06})


@unittest.skipUnless(pi_cli(), "the real Pi (PI_CLI, or app/node_modules with node) is not here")
class RealPi(unittest.TestCase):
    def test_one_shot_through_pi_without_tools(self):
        tmp = Path(tempfile.mkdtemp())
        model = FakeModel(tmp, [{"text": "```html\n" + PAGE.replace("{model}", "fake") + "\n```"}])
        self.addCleanup(model.close)
        os.environ["PI_BIN"] = json.dumps(["node", pi_cli()])
        g = load_run()
        ws = Ws(tmp / "ws")
        ws.env = lambda: {**os.environ, "PI_CODING_AGENT_DIR": str(model.agent)}
        html, st = g["one_shot"](ws, "fake/m", g["proto_brief"](ws, "спокойный"), tmp / "one", 60)
        self.assertIn("Зерно — fake", html)
        self.assertIsNone(st["error"])
        req = model.requests()[0]
        self.assertEqual(req.get("tools") or [], [])            # no tools: one answer, one call
        self.assertIn("побеждает дизайн-система", json.dumps(req["messages"], ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
