"""Tests for harness/brand_probe.py.

  python -m unittest discover -s playbooks/site/harness/tests        summarize() on a synthetic measurement
  BRAND_PYTHON=<python with Playwright + Chromium> python -m unittest …   + a real page from a local server
"""
import importlib.util
import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("brand_probe", HARNESS / "brand_probe.py")
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)

PAGE = """<!doctype html><html lang=ru><head><meta charset=utf-8><title>Кофейня Зерно</title>
<style>:root{--paper:#f3eee3;--ink:#3b2a1e;--accent:#a4472c}
body{margin:0;background:#f3eee3;color:#3b2a1e;font:18px/1.5 Georgia,serif}
h1{font:700 56px/1.1 "Trebuchet MS",sans-serif}
.cta{display:inline-block;background:#a4472c;color:#fff;border-radius:10px;padding:12px 20px}
a{color:#a4472c}</style></head>
<body><header><h1>Зерно</h1></header><main><p>Обжариваем сами, каждое утро. Свежий кофе в центре города,
завтраки и выпечка. Приходите!</p><p><a class=cta href=#>Заказать</a> <a href=#>Меню</a> <a href=#>Адрес</a></p>
<button class=cta>Позвонить</button></main></body></html>"""


class Summarize(unittest.TestCase):
    def test_roles_from_weights(self):
        raw = {"bg": {"#f3eee3": 1_000_000, "#f4efe4": 5000, "#a4472c": 3000},
               "text": {"#3b2a1e": 400, "#ffffff": 30, "#a4472c": 20},
               "action": {"#a4472c": 9, "#ffffff": 3},
               "fonts": {"body": {"family": "Georgia"}}, "radii": {"10px": 3, "4px": 1}, "vars": {"--x": "1"},
               "faces": [], "title": "t"}
        d = bp.summarize(raw, "https://zerno.ru/")
        self.assertEqual(d["colors"], {"background": "#f3eee3", "text": "#3b2a1e", "accent": "#a4472c"})
        self.assertEqual(d["radius"], "10px")
        self.assertEqual(d["palette"][0]["hex"], "#f3eee3")                # near shades merged into one
        self.assertEqual(len([p for p in d["palette"] if bp.near(p["hex"], "#f3eee3")]), 1)

    def test_no_saturated_action_falls_back_to_background_blocks(self):
        raw = {"bg": {"#ffffff": 100, "#1a73e8": 10}, "text": {"#111111": 50}, "action": {"#111111": 2},
               "fonts": {}, "radii": {}, "vars": {}, "faces": []}
        d = bp.summarize(raw, "u")
        self.assertEqual(d["colors"]["accent"], "#1a73e8")
        self.assertIsNone(d["radius"])


@unittest.skipUnless(os.environ.get("BRAND_PYTHON"), "BRAND_PYTHON: a Python with Playwright and Chromium")
class LivePage(unittest.TestCase):
    def test_reads_the_brand_of_a_real_page(self):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                body = PAGE.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory(prefix="brand-") as tmp:
                out = Path(tmp) / "материалы" / "brand.json"
                r = subprocess.run([os.environ["BRAND_PYTHON"], "-I", str(HARNESS / "brand_probe.py"), "--url",
                                    f"http://127.0.0.1:{srv.server_port}/", "--out", str(out), "--shot",
                                    str(out.with_name("brand-site.png"))], capture_output=True, text=True,
                                   encoding="utf-8", timeout=120)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                d = json.loads(out.read_text(encoding="utf-8"))
                self.assertEqual(d["colors"], {"background": "#f3eee3", "text": "#3b2a1e", "accent": "#a4472c"})
                self.assertEqual(d["fonts"]["body"]["family"], "Georgia")
                self.assertEqual(d["fonts"]["heading"]["family"], "Trebuchet MS")
                self.assertEqual(d["radius"], "10px")
                self.assertEqual(d["css_variables"]["--accent"], "#a4472c")
                self.assertTrue(out.with_name("brand-site.png").stat().st_size > 1000)
                bad = subprocess.run([os.environ["BRAND_PYTHON"], "-I", str(HARNESS / "brand_probe.py"), "--url",
                                      "http://127.0.0.1:9/", "--out", str(Path(tmp) / "x.json"), "--timeout", "5"],
                                     capture_output=True, text=True, encoding="utf-8", timeout=60)
                self.assertEqual(bad.returncode, 2)
                self.assertIn("error", json.loads(bad.stdout))
                self.assertFalse((Path(tmp) / "x.json").exists())
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
