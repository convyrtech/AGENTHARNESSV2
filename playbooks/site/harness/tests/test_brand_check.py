"""Tests for harness/brand_check.py.

  python -m unittest discover -s playbooks/site/harness/tests        colour maths, tokens, CSS-slop rules
  BRAND_PYTHON=<python with Playwright + Chromium> python -m unittest …   + real pages through the browser
"""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("brand_check", HARNESS / "brand_check.py")
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)

BRAND_MD = """# Бренд — Зерно

## Токены
| Токен | Значение | Откуда | Где применять |
|---|---|---|---|
| --paper | #f4ede1 | сайт | фон |
| --ink | #2b211b | сайт | текст |
| --accent | #b4532a | логотип | акцент |

## Запрещено
| что | пример |
|---|---|
| фиолетовый | #7c3aed |
- никакого #000000
"""

CLEAN = """<!doctype html><html lang=ru><head><meta charset=utf-8><title>Зерно</title><style>
:root{--paper:#f4ede1;--ink:#2b211b;--accent:#b4532a;--line:color-mix(in srgb,var(--ink) 30%,var(--paper))}
body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.5 Georgia,serif}
.k{text-transform:uppercase;letter-spacing:.2em;color:var(--accent)}
.card{border:1px solid var(--line);border-radius:12px;padding:24px}
.cta{background:var(--accent);color:var(--paper);padding:12px 20px;border-radius:8px}
</style></head><body><main><p class=k>Кофейня</p><h1>Зерно</h1>
<div class=card><p>Обжариваем сами, каждое утро.</p></div><a class=cta href=#>Заказать</a>
<svg width=80 height=80><circle cx=40 cy=40 r=40 fill="#00ff00"/></svg></main></body></html>"""

SLOPPY = """<!doctype html><html lang=ru><head><meta charset=utf-8><title>Зерно</title><style>
:root{--paper:#f4ede1;--ink:#2b211b;--accent:#b4532a}
body{margin:0;background:var(--paper);color:var(--ink)}
.hero{background:linear-gradient(135deg,#8b5cf6,#ec4899);min-height:300px}
.tag{text-transform:uppercase;color:#6366f1}
.note{border-left:4px solid var(--accent);border-radius:12px;padding:16px}
</style></head><body><section class=hero><h1>Зерно</h1></section><p class=tag>Новинка</p>
<div class=note><p>🚀 Быстро ☕ вкусно</p></div><p style="color:#1d4ed8">Синий абзац текста, которого нет в бренде,
довольно длинный, чтобы занять заметную площадь на странице.</p></body></html>"""


def site_with(html, brand_md=BRAND_MD, brand_json=None):
    root = Path(tempfile.mkdtemp())
    (root / "site" / "landing").mkdir(parents=True)
    (root / "site" / "landing" / "index.html").write_text(html, encoding="utf-8")
    (root / "design" / "landing").mkdir(parents=True)
    if brand_md is not None:
        (root / "design" / "landing" / "02-brand.md").write_text(brand_md, encoding="utf-8")
    (root / "materials").mkdir()
    if brand_json is not None:
        (root / "materials" / "brand.json").write_text(json.dumps(brand_json), encoding="utf-8")
    return root


class ColourMaths(unittest.TestCase):
    def test_ciede2000_reference_pairs(self):
        # Sharma, Wu, Dalal (2005), table 1, pairs 1 and 7
        self.assertAlmostEqual(bc.de2000((50, 2.6772, -79.7751), (50, 0, -82.7485)), 2.0425, places=3)
        self.assertAlmostEqual(bc.de2000((50, 0, 0), (50, -1, 2)), 2.3669, places=3)

    def test_tokens_from_brand_md_and_brand_json_without_the_forbidden(self):
        root = site_with(CLEAN, brand_json={"colors": {"background": "#F3EEE3", "text": "#3b2a1e", "accent": None},
                                            "palette": [{"hex": "#a4472c", "weight": 0.2}],
                                            "css_variables": {"--brand": "#fff", "--font": "Georgia"}})
        tokens = bc.brand_tokens(root / "design" / "landing", root / "materials")
        self.assertEqual(tokens, ["#f4ede1", "#2b211b", "#b4532a", "#f3eee3", "#3b2a1e", "#a4472c", "#ffffff"])
        self.assertNotIn("#7c3aed", tokens)
        self.assertNotIn("#000000", tokens)

    def test_mixes_of_two_tokens_are_the_brand(self):
        tokens = ["#f4ede1", "#2b211b", "#b4532a"]
        line = tuple(0.3 * a + 0.7 * b for a, b in zip(bc.rgb_of("#2b211b"), bc.rgb_of("#f4ede1")))
        d, via = bc.nearest(line, tokens)
        self.assertLess(d, 2)
        self.assertEqual(via, "#f4ede1")  # the mix passes; the message names the nearest single colour
        d, _ = bc.nearest(bc.rgb_of("#1d4ed8"), tokens)
        self.assertGreater(d, bc.DE_FAIL)

    def test_judge_colors_counts_area_and_names_the_place(self):
        tokens = ["#f4ede1", "#2b211b", "#b4532a"]
        samples = [{"kind": "background", "rgb": [29, 78, 216], "area": 1000, "sel": "main > div.a"},
                   {"kind": "background", "rgb": [29, 78, 216], "area": 800, "sel": "main > div.b"},
                   {"kind": "border", "rgb": [29, 78, 216], "area": 40, "sel": "hr"},
                   {"kind": "text", "rgb": [43, 33, 27], "area": 9000, "sel": "p"}]
        out = bc.judge_colors(samples, tokens)
        self.assertEqual([(c["hex"], c["kind"], c["sel"]) for c in out], [("#1d4ed8", "background", "main > div.a")])
        self.assertEqual(out[0]["area"], 1800)


class CssSlop(unittest.TestCase):
    def test_clean_page_has_no_findings(self):
        root = site_with(CLEAN)
        self.assertEqual(bc.css_slop(root / "site", ["#f4ede1", "#2b211b", "#b4532a"]), [])

    def test_each_rule_fires_on_its_pattern(self):
        root = site_with(SLOPPY)
        rules = [f["rule"] for f in bc.css_slop(root / "site", ["#f4ede1", "#2b211b", "#b4532a"])]
        for rule in ("purple-gradient", "ai-default-indigo", "emoji-icon", "raw-hex", "all-caps-no-tracking",
                     "left-accent-card"):
            self.assertIn(rule, rules)

    def test_raw_hex_only_for_a_page_with_its_own_variables(self):
        root = site_with("<html><body style='background:#f4ede1;color:#2b211b'><p>Зерно</p></body></html>")
        self.assertEqual(bc.css_slop(root / "site", []), [])

    def test_a_brand_colour_is_not_ai_indigo(self):
        root = site_with("<html><style>.a{color:#6366f1}</style><body><p class=a>x</p></body></html>")
        self.assertEqual(bc.css_slop(root / "site", ["#6366f1"]), [])


class InCheckPy(unittest.TestCase):
    def test_check_py_reports_brand_check_findings_and_a_missing_script(self):
        import shutil, sys
        root = site_with(SLOPPY)
        tools = root / "harness"
        tools.mkdir()
        shutil.copyfile(HARNESS / "check.py", tools / "check.py")
        run = lambda: subprocess.run([sys.executable, "-I", str(tools / "check.py"), "site", "design/landing"],
                                     cwd=root, capture_output=True, text=True, encoding="utf-8", timeout=240)
        r = run()
        self.assertIn("нет brand_check.py", r.stdout)
        self.assertNotIn("заглавные без разрядки", r.stdout)
        shutil.copyfile(HARNESS / "brand_check.py", tools / "brand_check.py")
        r = run()
        self.assertEqual(r.returncode, 1)
        self.assertIn("FAIL landing/index.html: «.tag» — заглавные без разрядки", r.stdout)


@unittest.skipUnless(os.environ.get("BRAND_PYTHON"), "BRAND_PYTHON: a python with Playwright and Chromium")
class LivePage(unittest.TestCase):
    def run_check(self, root):
        out = root / "result.json"
        r = subprocess.run([os.environ["BRAND_PYTHON"], "-I", str(HARNESS / "brand_check.py"),
                            str(root / "site"), str(root / "design" / "landing"), "--json", str(out)],
                           capture_output=True, text=True, encoding="utf-8", timeout=180)
        return r, json.loads(out.read_text(encoding="utf-8"))

    def test_brand_page_passes(self):
        r, data = self.run_check(site_with(CLEAN))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(data["colors"], [])

    def test_foreign_colours_fail_with_their_place(self):
        r, data = self.run_check(site_with(SLOPPY))
        self.assertEqual(r.returncode, 1)
        hexes = {c["hex"]: c for c in data["colors"]}
        self.assertIn("#1d4ed8", hexes)
        self.assertEqual(hexes["#1d4ed8"]["kind"], "text")
        self.assertIn("p", hexes["#1d4ed8"]["sel"])
        self.assertTrue(any(c["kind"] == "gradient" for c in data["colors"]))
        self.assertIn("чужой цвет #1d4ed8", r.stdout)

    def test_no_brand_colours_means_no_colour_check(self):
        r, data = self.run_check(site_with(SLOPPY, brand_md=None))
        self.assertIn("цвета не проверены", r.stdout)
        self.assertEqual(data["colors"], [])


if __name__ == "__main__":
    unittest.main()
