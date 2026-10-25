"""The owner is asked through the Pi tool ask_owner (research/20 §8).

  python -m unittest discover -s playbooks/site/harness/tests
  PI_CLI=<pi's cli.js>                         + the real Pi with ask_owner.ts against a fake model server
                                                 (found by itself in app/node_modules when the app is installed)
  DESIGN_PIPELINE=<design-pipeline copy>        + the pipeline's flow.py reads the answer as the owner's words

Without the tool's call the old «ВЛАДЕЛЬЦУ:» text still makes the card.
"""
import datetime as dt
import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
PY = sys.executable
REPO = HARNESS.parents[2]


def load_run():
    os.environ.setdefault("PI_BIN", json.dumps([PY, "-c", "pass"]))
    src = (HARNESS / "run.py").read_text(encoding="utf-8").split('if __name__ == "__main__":')[0]
    g = {"__name__": "run_under_test", "__file__": str(HARNESS / "run.py")}
    exec(compile(src, str(HARNESS / "run.py"), "exec"), g)
    return g


def pi_cli():
    if os.environ.get("PI_CLI"):
        return os.environ["PI_CLI"]
    found = glob.glob(str(REPO / "app" / "node_modules" / ".pnpm" / "@earendil-works+pi-coding-agent@*" / "node_modules"
                          / "@earendil-works" / "pi-coding-agent" / "dist" / "bundle" / "cli.js"))
    return found[0] if found and shutil.which("node") else ""


ASK = {"message": "Собрал три варианта настроения: design/landing/00-moods.png",
       "questions": [{"type": "text-options", "prompt": "Для кого страница?",
                      "options": ["A. Для кофейни", "Для обжарщиков (рекомендую)"], "recommended": "Для обжарщиков"},
                     {"type": "text-options", "prompt": "Какой тон?", "options": ["Тёплый", "Строгий", "Весёлый"],
                      "recommended": "Тёплый"}]}
NORMAL = {"message": ASK["message"], "questions": [
    {"type": "text-options", "prompt": "Для кого страница?", "options": [
        {"key": "A", "label": "Для кофейни", "recommended": False},
        {"key": "B", "label": "Для обжарщиков", "recommended": True}]},
    {"type": "text-options", "prompt": "Какой тон?", "options": [
        {"key": "A", "label": "Тёплый", "recommended": True}, {"key": "B", "label": "Строгий", "recommended": False},
        {"key": "C", "label": "Весёлый", "recommended": False}]}]}


class Card(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.g = load_run()

    def test_card_from_the_tool_in_the_template_shape(self):
        text, groups = self.g["ask_card"](NORMAL)
        self.assertEqual(text.splitlines(), [
            "Собрал три варианта настроения: design/landing/00-moods.png",
            "1. Для кого страница?", "A. Для кофейни", "B. Для обжарщиков (рекомендую)",
            "2. Какой тон?", "A. Тёплый (рекомендую)", "B. Строгий", "C. Весёлый"])
        self.assertEqual([g["q"] for g in groups], ["Для кого страница?", "Какой тон?"])
        self.assertEqual(groups[0]["options"][1], {"key": "B", "label": "Для обжарщиков", "recommended": True})
        # the old reading of the same text gives the same keys and recommendations: one shape for both paths
        flat = lambda gs: [(g["q"], [(o["key"], o["recommended"]) for o in g["options"]]) for g in gs]
        self.assertEqual(flat(self.g["options_of"](text)), flat(groups))

    def test_freeform_has_no_buttons(self):
        text, groups = self.g["ask_card"]({"message": "", "questions": [
            {"type": "freeform", "prompt": "Как называется кофейня?", "options": []}]})
        self.assertEqual((text, groups), ("Как называется кофейня?", []))
        self.assertIsNone(self.g["ask_card"](None))
        self.assertIsNone(self.g["ask_card"]({"questions": [{"prompt": ""}]}))


class FakeModel:
    """fake_openai.py on a free port and a Pi agent dir whose only provider points at it."""

    def __init__(self, tmp, replies):
        self.tmp = Path(tmp)
        (self.tmp / "script.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in replies),
                                               encoding="utf-8")
        self.log = self.tmp / "requests.log"
        self.proc = subprocess.Popen([PY, str(HERE / "fake_openai.py"), str(self.tmp / "script.jsonl"), str(self.log)],
                                     stdout=subprocess.PIPE, text=True)
        port = self.proc.stdout.readline().strip()
        agent = self.tmp / "agent"
        agent.mkdir()
        (agent / "models.json").write_text(json.dumps({"providers": {"fake": {
            "name": "F", "baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions", "apiKey": "local",
            "models": [{"id": "m", "name": "m", "reasoning": False, "input": ["text"], "contextWindow": 100000,
                        "maxTokens": 1000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}),
            encoding="utf-8")
        self.agent = agent

    def requests(self):
        return [json.loads(x) for x in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def close(self):
        self.proc.kill()
        self.proc.wait()


@unittest.skipUnless(pi_cli(), "the real Pi (PI_CLI, or app/node_modules with node) is not here")
class RealPi(unittest.TestCase):
    def stage(self, replies):
        tmp = Path(tempfile.mkdtemp())
        model = FakeModel(tmp, replies)
        self.addCleanup(model.close)
        os.environ["PI_BIN"] = json.dumps(["node", pi_cli()])
        g = load_run()
        (tmp / "ws").mkdir()

        class W:
            root = tmp / "ws"

            def env(self):
                return {**os.environ, "PI_CODING_AGENT_DIR": str(model.agent)}

        cfg = {"max_minutes": 2, "same_call_limit": 5, "max_calls": 20}
        final, st = g["run_stage"](W(), "0a", "задание", "fake/m", cfg, tmp / "s" / "0a-1.jsonl")
        return final, st, model.requests()

    def test_a_broken_call_is_an_error_the_model_fixes(self):
        bad = [
            {**ASK, "questions": ASK["questions"] * 2},                                       # 4 questions
            {**ASK, "questions": [{**ASK["questions"][0], "recommended": "Для всех"}]},       # no recommendation
            {**ASK, "questions": [{"type": "text-options", "prompt": "Цвет?", "options": ["а", "б", "в", "г", "д"],
                                   "recommended": "а"}]},                                      # 5 options
            {**ASK, "questions": [{"type": "freeform", "prompt": "Название?"}, ASK["questions"][0]]},
        ]
        final, st, reqs = self.stage([{"tool": "ask_owner", "args": a} for a in bad] +
                                     [{"tool": "ask_owner", "args": ASK}, {"text": "лишний ход"}])
        self.assertEqual(st["ask_errors"], 4)
        self.assertEqual(st["ask"], NORMAL)
        self.assertEqual(len(reqs), 5)                    # the good call ended the session: no request after it
        said = [json.dumps(r["messages"][-1], ensure_ascii=False) for r in reqs[1:]]
        for reason in ("вопросов 4, за раз не больше 3", "нет рекомендации", "вариантов 5, нужно от 2 до 4",
                       "freeform) задаётся один"):
            self.assertTrue(any(reason in s for s in said), reason)

    def test_without_the_tool_the_old_text_still_works(self):
        final, st, reqs = self.stage([{"text": "ВЛАДЕЛЬЦУ:\nВыкладываем?\nA. Да (рекомендую)\nB. Нет"}])
        self.assertIsNone(st["ask"])
        self.assertIn("ВЛАДЕЛЬЦУ:", final)
        tools = [t["function"]["name"] for t in reqs[0].get("tools", [])]
        self.assertIn("ask_owner", tools)                 # run.py gave Pi the tool


STUB_PI = r'''import json, sys
from pathlib import Path
a = sys.argv[1:]
assert "-e" in a and a[a.index("-e") + 1].endswith("ask_owner.ts"), a
n = len((Path.cwd() / "owner" / "messages.jsonl").read_text(encoding="utf-8").splitlines())
if n < 2:   # asks: the call goes out, the tool accepts it (like Pi with ask_owner.ts), the session ends
    ask = json.loads(Path(__file__).with_name("ask.json").read_text(encoding="utf-8"))
    print(json.dumps({"type": "message_end", "message": {"role": "assistant", "content": [
        {"type": "toolCall", "name": "ask_owner", "arguments": {}}], "usage": {}}}, ensure_ascii=False))
    print(json.dumps({"type": "tool_execution_end", "toolName": "ask_owner", "isError": False,
                      "result": {"content": [], "details": ask, "terminate": True}}, ensure_ascii=False))
else:
    print(json.dumps({"type": "message_end", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "Готово.\nЭТАП ГОТОВ"}], "usage": {}}}, ensure_ascii=False))
'''

STUB_FLOW = r'''import json, sys
from pathlib import Path
a = sys.argv[1:]
page = Path(a[a.index("--page") + 1])
if "--init" in a:
    page.mkdir(parents=True, exist_ok=True)
    (page / "STATUS.md").write_text("# STATUS\n", encoding="utf-8")
    sys.exit(0)
print(json.dumps({"exit": 1, "next": {"gate": "0a", "title": "Вопросы", "problems": ["нет ответов"]}}, ensure_ascii=False))
sys.exit(1)
'''


class Say(unittest.TestCase):
    """run.py say end to end with a stub Pi: the card's buttons come from the tool, the answer is written as before."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        h = self.tmp / "playbooks" / "site" / "harness"
        h.mkdir(parents=True)
        (self.tmp / "playbooks" / "site" / "motion").mkdir()
        for f in ("run.py", "stages.json", "AGENTS.md", "check.py", "brand_check.py", "moves.py", "ask_owner.ts"):
            shutil.copyfile(HARNESS / f, h / f)
        (h / "second_opinion.py").write_text('import json; print(json.dumps({"verdict": "PASS", "items": []}))\n',
                                             encoding="utf-8")
        (self.tmp / "stub_pi.py").write_text(STUB_PI, encoding="utf-8")
        (self.tmp / "ask.json").write_text(json.dumps(NORMAL, ensure_ascii=False), encoding="utf-8")
        pipe = self.tmp / "pipeline"
        (pipe / "tools").mkdir(parents=True)
        (pipe / "tools" / "flow.py").write_text(STUB_FLOW, encoding="utf-8")
        (pipe / "PIPELINE.md").write_text("# PIPELINE\n", encoding="utf-8")
        self.h, self.ws = h, self.tmp / "сайт"
        self.env = {**os.environ, "PI_BIN": json.dumps([PY, str(self.tmp / "stub_pi.py")]), "PYTHONUTF8": "1",
                    "HARNESS_STATE_DIR": str(self.tmp / "state")}
        r = self.run_py("init", str(self.ws), "--page", "landing", "--pipeline", str(pipe))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def run_py(self, *args):
        return subprocess.run([PY, "-I", str(self.h / "run.py"), *args], env=self.env, capture_output=True, text=True,
                              encoding="utf-8", timeout=120)

    def events(self, r):
        return [json.loads(x) for x in r.stdout.splitlines() if x.startswith("{")]

    def test_card_from_the_tool_and_the_answer_as_before(self):
        ev = self.events(self.run_py("say", str(self.ws), "Сделай лендинг для обжарщиков"))
        owner = [e for e in ev if e.get("ev") == "owner"]
        self.assertEqual(len(owner), 1)
        self.assertEqual(owner[0]["options"], self.load()["ask_card"](NORMAL)[1])
        self.assertIn("B. Для обжарщиков (рекомендую)", owner[0]["text"])
        # the app answers with the button's text, as it does now; run.py writes it as before
        shown = dt.datetime.now().astimezone() - dt.timedelta(seconds=2)   # when the card appeared
        self.run_py("say", str(self.ws), "1B 2A")
        msgs = [json.loads(x) for x in (self.ws / "owner" / "messages.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([m["text"] for m in msgs], ["Сделай лендинг для обжарщиков", "1B 2A"])
        self.assertEqual(set(msgs[1]), {"id", "date", "text", "forward_from", "files"})
        sent = sorted((self.tmp / "state" / "sent").glob("*.md"))
        self.assertIn("2. Какой тон?", sent[0].read_text(encoding="utf-8"))
        self.flow_accepts(self.ws / "owner" / "messages.jsonl", "1B 2A", shown)

    def load(self):
        return load_run()

    def flow_accepts(self, channel, quote, after):
        """The pipeline's own check of a «ВЫБОР» quote: a short answer is the whole message, after the card."""
        pipeline = os.environ.get("DESIGN_PIPELINE", "")
        if not (pipeline and (Path(pipeline) / "tools" / "flow.py").exists()):
            return
        spec = importlib.util.spec_from_file_location("flow_under_test", Path(pipeline) / "tools" / "flow.py")
        sys.path.insert(0, str(Path(pipeline) / "tools"))
        flow = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(flow)
        owner = flow.Owner(self.ws, channel=channel)
        self.assertTrue(owner.said(quote, dt.date.today().isoformat(), after), "flow.py does not find the owner's answer")


if __name__ == "__main__":
    unittest.main()
