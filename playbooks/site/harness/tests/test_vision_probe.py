"""DIARY 6a / research/28 §4.4: the vision probe — same pictures and questions for every model, answers known by code.
python -m unittest discover -s playbooks/site/harness/tests   (BRAND_PYTHON=<python with Playwright> for the pictures)"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
sys.path.insert(0, str(HARNESS))
import vision_probe as V  # noqa: E402

PY = os.environ.get("BRAND_PYTHON", "")


def items():
    out = [{"id": f"read-{k}", "kind": "read", "want": ["Повседнев", "47 128 ₽"]} for k in (1, 2)]
    out += [{"id": f"same-{k:02d}", "kind": "phantom", "want": "НЕТ"} for k in range(20)]
    out += [{"id": f"diff-{k:02d}", "kind": "phantom", "want": "ЕСТЬ"} for k in range(10)]
    for k in range(10):
        out += [{"id": f"pick-{k:02d}-gb", "kind": "pick", "pair": f"pick-{k:02d}", "defect": f"d{k}", "want": "1"},
                {"id": f"pick-{k:02d}-bg", "kind": "pick", "pair": f"pick-{k:02d}", "defect": f"d{k}", "want": "2"}]
    out += [{"id": f"defect-bad-{k}", "kind": "defect", "want": "ДА"} for k in range(6)]
    out += [{"id": f"defect-clean-{k}", "kind": "defect", "want": "НЕТ"} for k in range(4)]
    return out


def rows(it_list, phantom=0, left=False, cost=0.01, extra_prompt=False):
    """A model: perfect except `phantom` invented differences; `left` always picks «1» (position bias)."""
    out = {}
    for it in it_list:
        k = it["kind"]
        if k == "read":
            ans = 1.0
        elif k == "phantom":
            ans = it["want"]
            if it["want"] == "НЕТ" and phantom > 0:
                ans, phantom = "ЕСТЬ", phantom - 1
        elif k == "pick":
            ans = "1" if left else it["want"]
        else:
            ans = it["want"]
        pt = 1500 + (9000 if extra_prompt and it["id"] == "same-00" else 0)
        out[it["id"]] = {"answer": ans, "seconds": 4.0, "cost": cost, "prompt_tokens": pt}
    return out


class Score(unittest.TestCase):
    def test_perfect_model_qualifies(self):
        s = V.summarize(items(), rows(items()))
        self.assertEqual((s["read"], s["phantom"], s["sensitivity"]), (1.0, "0/20", "10/10"))
        self.assertEqual((s["pick_right"], s["pick_inconsistent"]), (10, 0))
        self.assertEqual((s["defect_found"], s["defect_false_alarm"]), ("6/6", "0/4"))
        self.assertAlmostEqual(s["cost"], 0.01 * len(items()), places=4)
        self.assertTrue(V.qualifies(s))

    def test_position_bias_is_inconsistent_not_right(self):
        s = V.summarize(items(), rows(items(), left=True))
        self.assertEqual((s["pick_right"], s["pick_wrong"], s["pick_inconsistent"]), (0, 0, 10))
        self.assertFalse(V.qualifies(s))

    def test_phantoms_hidden_prompt_and_errors(self):
        r = rows(items(), phantom=3, extra_prompt=True)
        r["defect-bad-0"] = {"error": "HTTPError: 400 image not supported"}
        s = V.summarize(items(), r)
        self.assertEqual(s["phantom"], "3/20")
        self.assertEqual(s["hidden_prompt_calls"], 1)
        self.assertEqual(s["errors"], 1)
        self.assertEqual(s["defect_found"], "5/5")
        self.assertFalse(V.qualifies(s))

    def test_proposal_names_fable_and_kimi_from_the_numbers(self):
        it = items()
        summary = {"claude-opus-5-5": V.summarize(it, rows(it, phantom=0)),
                   "claude-fable-5": V.summarize(it, rows(it, phantom=1, cost=None)),
                   "kimi-k3.1-pro": V.summarize(it, rows(it, phantom=5))}
        text = "\n".join(V.propose(summary))
        self.assertIn("VISUAL_CLASS: добавить claude-fable-5", text)
        self.assertIn("claude-fable-5 на верх лестницы рядом с Opus: да (цены у шлюза нет", text)
        self.assertIn("kimi-k3.1-pro как запасной судья: нет (выдуманных различий 5/20 против 0/20 у Opus)", text)
        self.assertIn("kimi-k3.1-pro", V.table(summary))

    def test_answer_parsing_takes_the_last_line(self):
        self.assertEqual(V.answer_of({"kind": "phantom"}, "РАЗЛИЧИЯ: ЕСТЬ? нет.\nРАЗЛИЧИЯ: НЕТ"), "НЕТ")
        self.assertEqual(V.answer_of({"kind": "pick"}, "Второй хуже.\nВЫБОР: 1"), "1")
        self.assertIsNone(V.answer_of({"kind": "defect"}, "не знаю"))
        self.assertEqual(V.answer_of({"kind": "read", "want": ["Повседнев", "47 128 ₽"]},
                                     "Повседнев — дневник\n47 128 ₽"), 1.0)


class Gateway(BaseHTTPRequestHandler):
    """Fake /v1/chat/completions: «Opus» answers right by the picture name in nothing — it always says «нет
    различий», «ВЫБОР: 1», «ДЕФЕКТ: НЕТ» and reads «Повседнев»; enough to drive the whole run."""
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Gateway.seen.append(body["model"])
        assert body["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
        text = "Повседнев — дневник привычек\nРАЗЛИЧИЯ: НЕТ\nВЫБОР: 1\nДЕФЕКТ: НЕТ"
        if body["model"] == "no-vision":
            self.send_response(400)
            self.end_headers()
            return
        data = {"choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 1200, "cost": 0.002}}
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


@unittest.skipUnless(PY, "BRAND_PYTHON: a python with Playwright and Chromium")
class Run(unittest.TestCase):
    def test_whole_run_two_models_then_resume_asks_nothing(self):
        srv = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_port}"
        try:
            with tempfile.TemporaryDirectory() as t:
                cmd = [PY, "-I", str(HARNESS / "vision_probe.py"), "--out", t, "--proxy", url,
                       "--model", "m-ok", "--model", "no-vision", "--jobs", "8"]
                r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=600)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                rep = json.loads((Path(t) / "report.json").read_text(encoding="utf-8"))
                ok, bad = rep["summary"]["m-ok"], rep["summary"]["no-vision"]
                self.assertEqual(ok["calls"], 63)
                self.assertEqual(ok["phantom"], "0/20")
                self.assertEqual(ok["sensitivity"], "0/10")          # «always no» is caught by the controls
                self.assertEqual(ok["pick_inconsistent"], 10)        # «always 1» is position, not choice
                self.assertEqual(ok["defect_found"], "0/6")
                self.assertEqual(bad["errors"], 63)
                self.assertIn("m-ok", r.stdout)
                n = len(Gateway.seen)
                subprocess.run(cmd[:-6] + ["--model", "m-ok"], capture_output=True, text=True, encoding="utf-8",
                               timeout=600)
                self.assertEqual(len(Gateway.seen), n)               # answered calls are not asked again
        finally:
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
