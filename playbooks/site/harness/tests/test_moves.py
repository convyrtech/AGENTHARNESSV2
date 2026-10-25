"""Tests for harness/moves.py.

  python -m unittest discover -s playbooks/site/harness/tests            unit tests (stdlib only)
  MOVES_PIPELINE=<patched design-pipeline copy> python -m unittest …     + the whole step 1 on a sample page:
      run.py init → words → candidates → owner answer → ВЫБОР 1 → pick → flow.py gate 1 passes with «Эталон: нет»
      (needs Pillow, Playwright with a browser, ffmpeg via imageio-ffmpeg/PATH)
"""
import datetime as dt
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
MOTION = HARNESS.parent / "motion"
spec = importlib.util.spec_from_file_location("moves", HARNESS / "moves.py")
moves = importlib.util.module_from_spec(spec)
spec.loader.exec_module(moves)
KNOWN = {m["component"]: m for m in json.loads((MOTION / "vocab.json").read_text(encoding="utf-8"))["moves"]
         if m.get("component")}


def pack(*mv, name="n", rule="r"):
    return {"name": name, "rule": rule, "moves": list(mv)}


class Packs(unittest.TestCase):
    def test_defaults_follow_the_vocabulary_rules(self):
        self.assertEqual(moves.validate_packs(moves.DEFAULT_PACKS, KNOWN), [])

    def test_rules(self):
        ok = {"A": pack("ringHead", "odometer"), "B": pack("lineWord", "stamp"), "C": pack("trailDot", "morph")}
        self.assertEqual(moves.validate_packs(ok, KNOWN), [])
        cases = {
            "делят 2": {**ok, "B": pack("lineWord", "ringHead", "odometer")},
            "тропа и рельс": {**ok, "C": pack("trailDot", "stepsRail")},
            "ни одного": {**ok, "B": pack("slotLift", "stamp", "morph")},
            "ровно один": {**ok, "C": pack("trailDot", "director")},
            "нет готовых компонентов": {**ok, "A": pack("ringHead", "plateRings")},
            "приёмов 4": {**ok, "A": pack("ringHead", "odometer", "stamp", "slotLift")},
            "пустое поле rule": {**ok, "A": pack("ringHead", "odometer", rule=" ")},
            "нужны наборы": {"A": ok["A"], "B": ok["B"]},
        }
        for needle, packs in cases.items():
            with self.subTest(needle):
                self.assertTrue(any(needle in p for p in moves.validate_packs(packs, KNOWN)),
                                moves.validate_packs(packs, KNOWN))


class Words(unittest.TestCase):
    def test_keys_match_the_demo(self):
        html = (MOTION / "demo" / "index.html").read_text(encoding="utf-8")
        self.assertEqual(sorted(set(re.findall(r'data-w="([^"]+)"', html))), sorted(moves.WORD_KEYS))

    def test_validation(self):
        self.assertEqual(moves.validate_words({"num": "180 ₽", "step1": "Закажите"})[0], [])
        for words, needle in (({"price": "1"}, "неизвестный ключ"), ({"num": "много"}, "нет цифр"),
                              ({"step1": ""}, "непустой"), ({"step1": "я" * 81}, "длиннее 80"),
                              ({"stamp": "TODO"}, "заглушку"), ([], "объект")):
            with self.subTest(needle):
                self.assertTrue(any(needle in p for p in moves.validate_words(words)[0]))


class Tokens(unittest.TestCase):
    def test_from_palette(self):
        t, notes = moves.tokens_from_palette([{"hex": "#f3eee3"}, {"hex": "#3b2a1e"}, {"hex": "#a4472c"},
                                              {"hex": "#7a6352"}])
        self.assertEqual((t["paper"], t["ink"], t["accent"]), ("#f3eee3", "#3b2a1e", "#a4472c"))
        self.assertGreaterEqual(moves.contrast(t["ink"], t["paper"]), 7)
        self.assertEqual(notes, [])

    def test_dark_or_grey_materials_stay_readable(self):
        t, notes = moves.tokens_from_palette([{"hex": "#555555"}, {"hex": "#444444"}, {"hex": "#666666"}])
        self.assertGreater(moves.lightness(t["paper"]), 85)
        self.assertGreaterEqual(moves.contrast(t["ink"], t["paper"]), 7)
        self.assertGreaterEqual(moves.contrast(t["accent"], t["paper"]), 3)
        self.assertEqual(len(notes), 3)
        self.assertEqual(moves.tokens_from_palette([])[0], moves.DEFAULT_TOKENS)

    def test_from_brand_md(self):
        md = "| --ink | #3B2A1E | лого | текст |\n| --accent | #a4472c | | |\n:root { --paper: #f3eee3; }\n"
        self.assertEqual(moves.tokens_from_brand(md), {"ink": "#3b2a1e", "accent": "#a4472c", "paper": "#f3eee3"})


@unittest.skipUnless(os.environ.get("MOVES_PIPELINE"), "MOVES_PIPELINE: copy of design-pipeline with the fixes applied")
class StepOne(unittest.TestCase):
    def test_candidates_pick_and_gate_1(self):
        py = sys.executable
        with tempfile.TemporaryDirectory(prefix="moves-") as tmp:
            tmp = Path(tmp)
            mats = tmp / "материалы"
            mats.mkdir()
            from PIL import Image, ImageDraw
            im = Image.new("RGB", (400, 300), "#f3eee3")
            d = ImageDraw.Draw(im)
            d.rectangle((0, 0, 400, 60), fill="#3b2a1e")
            d.ellipse((150, 100, 250, 200), fill="#a4472c")
            im.save(mats / "logo.png")
            ws = tmp / "Иван Петров" / "сайт"
            env = {**os.environ, "PYTHONUTF8": "1"}
            r = subprocess.run([py, str(HARNESS / "run.py"), "init", str(ws), "--page", "landing", "--pipeline",
                                os.environ["MOVES_PIPELINE"], "--materials", str(mats)], env=env,
                               capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            page = ws / "design" / "landing"
            (page / "01-cands").mkdir()
            (page / "01-cands" / "words.json").write_text(json.dumps(
                {"num": "180 ₽", "step1": "Закажите", "step2": "Мы обжарим", "step3": "Заберите",
                 "limitLabel": "чашек за утро", "limit": "1 240", "stamp": "ГОТОВО", "sloganRise": "с утра"},
                ensure_ascii=False), encoding="utf-8")
            run = lambda *a: subprocess.run([py, "-I", str(ws / "harness" / "moves.py"), *a], cwd=ws, env=env,
                                            capture_output=True, text=True, encoding="utf-8")
            r = run("candidates", "--page", "design/landing")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            out = json.loads(r.stdout[r.stdout.index("{"):])
            self.assertEqual(sorted(out["packs"]), ["A", "B", "C"])
            for k in "ABC":
                self.assertTrue((page / "01-cands" / f"{k}.mp4").stat().st_size > 2000)
            side = json.loads((page / "01-candidates.json").read_text(encoding="utf-8"))
            self.assertEqual([v["label"] for v in side["variants"]], ["A", "B", "C"])
            self.assertRegex((page / "STATUS.md").read_text(encoding="utf-8"), r"(?m)^- Эталон: нет$")
            css = (ws / "design-pipeline" / "motion" / "brands" / "landing.css").read_text(encoding="utf-8")
            self.assertIn("--accent: #a4472c", css)

            now = dt.datetime.now()
            with open(ws / "owner" / "messages.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"id": 1, "date": now.strftime("%Y%m%d-%H%M%S"), "text": "Берём A, с кольцом",
                                    "forward_from": None, "files": []}, ensure_ascii=False) + "\n")
            st = page / "STATUS.md"
            st.write_text(st.read_text(encoding="utf-8").rstrip("\n") +
                          f"\n- ВЫБОР 1: A · «Берём A, с кольцом» · {now:%Y-%m-%d}\n", encoding="utf-8")
            r = run("pick", "--page", "design/landing", "--pack", "A")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertGreaterEqual(len(list((page / "01-frames").glob("*.png"))), 12)
            pk = json.loads((page / "01-pack.json").read_text(encoding="utf-8"))
            self.assertEqual([m["component"] for m in pk["moves"]], moves.DEFAULT_PACKS["A"]["moves"])
            self.assertTrue(all(m["markup"] for m in pk["moves"]))
            probe = ("import sys, json; sys.path.insert(0, 'design-pipeline/tools'); import flow as F; "
                     "p = F.Page('design/landing'); pr, h = F.g1(p); print(json.dumps({'pr': pr, 'un': p.unverified}))")
            r = subprocess.run([py, "-I", "-c", probe], cwd=ws, env=env, capture_output=True, text=True,
                               encoding="utf-8")
            self.assertEqual(json.loads(r.stdout.strip().splitlines()[-1]), {"pr": [], "un": []}, r.stderr)


if __name__ == "__main__":
    unittest.main()
