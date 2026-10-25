"""research/28 §4.2: calibrating the judge on the owner's labels — a blind sheet, two judge runs per page, FPR/κ/stability.
python -m unittest discover -s playbooks/site/harness/tests   (BRAND_PYTHON=<python with Playwright> for the sheet)"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
sys.path.insert(0, str(HARNESS))
sys.path.insert(0, str(HERE))
import calib as C  # noqa: E402
import judge_questions as Q  # noqa: E402
from test_judge import FLOW, Model, answer  # noqa: E402

PY = os.environ.get("BRAND_PYTHON", "")


def workspace(root, name, body="Сайт", stub=False):
    """<root>/<name>/design/landing with a contact sheet and <root>/<name>/site/landing/index.html."""
    from PIL import Image
    ws = Path(root) / name
    page = ws / "design" / "landing"
    (page / "artifacts" / "visual-gate").mkdir(parents=True)
    (page / "index.html").write_text("<h1>src</h1>", encoding="utf-8")
    os.utime(page / "index.html", (1, 1))
    (page / "FACTS.md").write_text("| 50 ₽ | есть | счёт |\n", encoding="utf-8")
    Image.new("RGB", (40, 80), "white").save(page / "artifacts" / "visual-gate" / "contact-chromium-390.png")
    site = ws / "site" / "landing"
    site.mkdir(parents=True)
    filler = "" if stub else "<p>" + "Текст страницы. " * 400 + "</p>"
    (site / "index.html").write_text(f"<!doctype html><meta charset=utf-8><h1>{body}</h1>{filler}", encoding="utf-8")
    os.utime(site / "index.html", (1, 1))                                # the build predates its contact sheet
    pipe = ws / "design-pipeline"
    (pipe / "tools").mkdir(parents=True)
    (pipe / "tools" / "flow.py").write_text(FLOW, encoding="utf-8")
    (pipe / "templates").mkdir()
    (pipe / "templates" / "JUDGE-PROMPT.md").write_text("шапка\nJUDGE-PROMPT v2\nСуди.\n", encoding="utf-8")
    return page


class Score(unittest.TestCase):
    def test_kappa_and_fpr_on_known_numbers(self):
        owner = [True, True, False, False, True, False]
        judge = [True, True, True, False, True, False]                  # passes one page the owner failed
        r = C.compare(owner, [judge, judge])
        self.assertEqual(r["owner_no"], 3)
        self.assertAlmostEqual(r["fpr"], 1 / 3, places=3)
        self.assertEqual(r["false_alarm"], 0.0)
        self.assertAlmostEqual(r["kappa"][0], 0.667, places=3)           # po 5/6, pe 0.5
        self.assertEqual(r["stable"], 1.0)
        self.assertIsNone(C.kappa([True, True], [True, True]))           # no variance: undefined, not 1

    def test_stability_counts_pages_where_runs_disagree(self):
        r = C.compare([True] * 4, [[True, True, False, False], [True, False, False, True]])
        self.assertEqual(r["stable"], 0.5)
        self.assertIsNone(r["fpr"])                                      # owner never said «нет»

    def test_score_per_model_question_and_verdict(self):
        labels = {"sheet": "x", "pages": {
            "p01": {"answers": {q: True for q in Q.IDS}, "ship": True},
            "p02": {"answers": {**{q: True for q in Q.IDS}, "Q5": False}, "ship": False},
            "p03": {"answers": {"Q1": False}, "ship": None}}}            # half-labelled: Q1 only, no verdict

        def run(yes, verdict):
            return {"answers": {q: q in yes for q in Q.IDS}, "verdict": verdict}
        everything = set(Q.IDS)
        runs = {"m": {"p01": [run(everything, "PASS"), run(everything, "PASS")],
                      "p02": [run(everything, "PASS"), run(everything - {"Q5"}, "FAIL")],
                      "p03": [run(set(), "FAIL"), run(set(), "FAIL")]}}
        r = C.score(labels, runs)["m"]
        self.assertEqual(r["questions"]["Q5"]["fpr"], 1.0)               # run 1 said «да» where the owner said «нет»
        self.assertEqual(r["questions"]["Q5"]["stable"], 0.5)
        self.assertEqual(r["questions"]["Q1"]["n"], 3)
        self.assertEqual(r["questions"]["Q2"]["n"], 2)
        self.assertEqual(r["verdict"]["n"], 2)
        self.assertEqual(r["verdict"]["fpr"], 1.0)
        self.assertFalse(r["targets"]["fpr<=0.2"])
        self.assertIn("Q5", C.table({"m": r}))


class Find(unittest.TestCase):
    def test_skips_stubs_copies_and_test_stands(self):
        with tempfile.TemporaryDirectory() as t:
            a = workspace(t, "e8")
            workspace(t, "e8-copy")                                     # same page copied: counted once
            workspace(t, "e9", body="Другая")
            workspace(t, "e2e", stub=True)
            workspace(t, "dp-tests-x", body="Стенд")
            found = C.find_pages([t])
            self.assertEqual(len(found), 2)
            self.assertIn(a.resolve(), found)
            self.assertEqual(len(C.choose(found * 30, 40, 1)), 40)


class Judge(unittest.TestCase):
    def test_two_fresh_round_one_runs_per_page_and_the_original_is_untouched(self):
        with tempfile.TemporaryDirectory() as t:
            page = workspace(t, "e8")
            out = Path(t) / "calib"
            out.mkdir()
            (out / "manifest.json").write_text(json.dumps({"sheet": "s", "pages": {"p01": {"page": str(page)}}}),
                                               encoding="utf-8")
            first = answer(1, yes=Q.IDS[:-1], no=[Q.IDS[-1]])
            model = Model([first, answer(1, yes=Q.IDS, verdict="PASS")])
            try:
                r = subprocess.run([sys.executable, str(HARNESS / "calib.py"), "judge", "--out", str(out),
                                    "--proxy", model.url, "--model", "m"], capture_output=True, text=True,
                                   encoding="utf-8", timeout=120)
            finally:
                model.close()
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            runs = json.loads((out / "judge-runs.json").read_text(encoding="utf-8"))["m"]["p01"]
            self.assertEqual(len(runs), 2)
            self.assertFalse(runs[0]["answers"]["Q12"])
            self.assertTrue(runs[1]["answers"]["Q12"])
            self.assertEqual(runs[1]["verdict"], "PASS")
            self.assertTrue(all("РАУНД: 1" in m["messages"][0]["content"][0]["text"] for m in model.requests))
            self.assertFalse((page / "artifacts" / "judge").exists())


# the owner's clicks in the real sheet: «нет» on Q5, the rest «да», «не показал бы»; then the export
CLICK = r"""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(accept_downloads=True)
    pg.goto(Path(sys.argv[1]).as_uri())
    pg.click('#p01 button[data-q="Q5"][data-v="0"]')
    pg.click('#p01 button[data-act="rest"]')
    pg.click('#p01 button[data-q="ship"][data-v="0"]')
    progress = pg.text_content("#progress")
    with pg.expect_download() as d:
        pg.click("text=Скачать разметку")
    got = json.loads(Path(d.value.path()).read_text(encoding="utf-8"))
    b.close()
print(json.dumps({**got, "progress": progress}, ensure_ascii=False))
"""


@unittest.skipUnless(PY, "BRAND_PYTHON: a python with Playwright and Chromium")
class Sheet(unittest.TestCase):
    def test_blind_sheet_with_both_widths_questions_and_export(self):
        with tempfile.TemporaryDirectory() as t:
            workspace(t, "e8")
            workspace(t, "e9", body="Другая")
            out = Path(t) / "calib"
            r = subprocess.run([PY, "-I", str(HARNESS / "calib.py"), "sheet", "--root", t, "--out", str(out)],
                               capture_output=True, text=True, encoding="utf-8", timeout=300)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            html = (out / "sheet.html").read_text(encoding="utf-8")
            man = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(sorted(man["pages"]), ["p01", "p02"])
            self.assertEqual(html.count("data:image/jpeg;base64,"), 4)
            self.assertEqual(html.count('data-q="Q7"'), 4)               # да + нет on each page
            self.assertNotIn(t, html)                                    # blind: no paths
            self.assertIn("50 ₽", html)                                  # FACTS.md under the shots
            r = subprocess.run([PY, "-I", "-c", CLICK, str(out / "sheet.html")], capture_output=True, text=True,
                               encoding="utf-8", timeout=120)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            got = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertIn("1 из 2", got.pop("progress"))
            self.assertEqual(got["sheet"], man["sheet"])
            self.assertFalse(got["pages"]["p01"]["answers"]["Q5"])
            self.assertTrue(got["pages"]["p01"]["answers"]["Q1"])
            self.assertFalse(got["pages"]["p01"]["ship"])


if __name__ == "__main__":
    unittest.main()
