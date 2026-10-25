"""research/28 §4.4: a model's pick between prototypes A and B counts only when both orders agree."""
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
sys.path.insert(0, str(HERE))
import pair_pick as P  # noqa: E402
from test_ask_owner import load_run  # noqa: E402

PIPE = os.environ.get("DESIGN_PIPELINE", "")
PY = os.environ.get("BRAND_PYTHON", "")


class Consistency(unittest.TestCase):
    def test_both_orders_must_point_at_the_same_prototype(self):
        orders = [["a", "b"], ["b", "a"]]
        self.assertEqual(P.consistent(["1", "2"], orders), "a")       # 1 = a, then 2 = a
        self.assertEqual(P.consistent(["2", "1"], orders), "b")
        self.assertIsNone(P.consistent(["1", "1"], orders))           # «always the left one»: position, not choice
        self.assertIsNone(P.consistent(["2", None], orders))


class Card(unittest.TestCase):
    TEXT = "Два прототипа: 05-compare.png\nA. Спокойный (рекомендую)\nB. Смелый\nВ. Гибрид"

    def opts(self):
        return [{"q": "", "options": [{"key": "A", "label": "Спокойный", "recommended": True},
                                      {"key": "B", "label": "Смелый", "recommended": False},
                                      {"key": "В", "label": "Гибрид", "recommended": False}]}]

    def test_agreed_pick_moves_the_recommendation(self):
        g = load_run()
        text, opts = g["apply_pair_pick"](self.TEXT, self.opts(), {"winner": "b"})
        self.assertIn("A. Спокойный\n", text + "\n")
        self.assertIn("B. Смелый (рекомендую)", text)
        self.assertEqual([o["recommended"] for o in opts[0]["options"]], [False, True, False])
        self.assertNotIn("выберите сами", text)

    def test_disagreement_leaves_no_recommendation_and_says_so(self):
        g = load_run()
        text, opts = g["apply_pair_pick"](self.TEXT, self.opts(), {"winner": None})
        self.assertNotIn("рекомендую", text)
        self.assertIn("В. Гибрид", text)
        self.assertIn("проверка не решила: выберите сами", text)
        self.assertEqual([o["recommended"] for o in opts[0]["options"]], [False, False, False])
        # nothing to compare (no two prototypes): the card stays
        self.assertEqual(g["apply_pair_pick"](self.TEXT, None, None), (self.TEXT, None))


class FakeModel:
    """Answers each call with the next «ВЫБОР: …» line."""

    def __init__(self, picks):
        picks = list(picks)
        self.calls = []

        class H(BaseHTTPRequestHandler):
            def do_POST(h):
                body = json.loads(h.rfile.read(int(h.headers["Content-Length"])))
                self.calls.append(body)
                out = json.dumps({"choices": [{"message": {"content": "Разбор.\nВЫБОР: " + picks.pop(0)}}]})
                h.send_response(200)
                h.send_header("Content-Type", "application/json")
                h.end_headers()
                h.wfile.write(out.encode())

            def log_message(h, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def close(self):
        self.srv.shutdown()


@unittest.skipUnless(PIPE and PY, "DESIGN_PIPELINE and BRAND_PYTHON")
class EndToEnd(unittest.TestCase):
    def run_pick(self, picks):
        tmp = Path(tempfile.mkdtemp())
        for x, color in (("a", "#f3eee3"), ("b", "#1e2a3b")):
            (tmp / x).mkdir()
            (tmp / x / "index.html").write_text(f"<!doctype html><body style='margin:0;background:{color}'><h1>{x}</h1>",
                                                encoding="utf-8")
        (tmp / "MESSAGE.md").write_text("Лендинг кофейни «Зерно»: заказать завтрак.", encoding="utf-8")
        m = FakeModel(picks)
        try:
            r = subprocess.run([PY, "-I", str(HARNESS / "pair_pick.py"), "--a", str(tmp / "a" / "index.html"),
                                "--b", str(tmp / "b" / "index.html"), "--brief", str(tmp / "MESSAGE.md"),
                                "--pipeline", PIPE, "--out", str(tmp / "out"), "--proxy", m.url],
                               capture_output=True, text=True, encoding="utf-8", timeout=240)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            return json.loads(r.stdout.strip().splitlines()[-1]), m.calls
        finally:
            m.close()

    def test_two_calls_one_image_each_and_the_position_bias_is_caught(self):
        res, calls = self.run_pick(["1", "1"])                   # always the left one
        self.assertIsNone(res["winner"])
        self.assertEqual(len(calls), 2)
        for c in calls:
            imgs = [p for p in c["messages"][0]["content"] if p["type"] == "image_url"]
            self.assertEqual(len(imgs), 1)
            self.assertIn("Зерно", c["messages"][0]["content"][0]["text"])
        res, _ = self.run_pick(["1", "2"])                       # «a» on the left, then «a» on the right
        self.assertEqual((res["winner"], res["answers"]), ("a", ["1", "2"]))


if __name__ == "__main__":
    unittest.main()
