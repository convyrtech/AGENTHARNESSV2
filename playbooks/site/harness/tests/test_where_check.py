"""research/28 §4.4: a judge finding counts only if code finds its place («Где») on the built page."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
sys.path.insert(0, str(HARNESS))
sys.path.insert(0, str(HERE))
import judge_questions as Q  # noqa: E402
import where_check as W  # noqa: E402
from test_judge import ROW, Model, Stand, answer  # noqa: E402

BROWSER_PY = os.environ.get("BRAND_PYTHON", "")


class Targets(unittest.TestCase):
    def test_what_a_where_cell_names(self):
        self.assertEqual(W.targets("`main > h1`"), [("css", "main > h1")])
        self.assertEqual(W.targets("390, y=1200"), [("region", 390, 1200)])
        self.assertEqual(W.targets("`.hero .cta` на 1440"), [("css", ".hero .cta")])
        self.assertEqual(W.targets("кнопка .cta в шапке"), [("css", ".cta")])
        self.assertEqual(W.targets("где-то внизу"), [])

    def test_unconfirmed_rows_leave_the_table_for_their_own_section(self):
        text = answer(1, yes=Q.IDS, rows=[ROW.format(sev="Blocker", what="бледный текст").replace("`main > h1`", "`.ghost`"),
                                          ROW.format(sev="Minor", what="мелочь")], verdict="FAIL")
        rows = [("Blocker бледный текст", "`.ghost`"), ("Minor мелочь", "`main > h1`")]
        out, bad = W.split_unconfirmed(text, rows, [False, True])
        self.assertEqual(bad, [("Blocker бледный текст", "`.ghost`")])
        self.assertNotIn("| Blocker | бледный текст |", out)
        self.assertIn("| Minor | мелочь |", out)
        self.assertIn("## Не подтверждено кодом", out)
        self.assertIn("- Blocker бледный текст — «Где»: `.ghost`", out)
        self.assertEqual(W.split_unconfirmed(text, rows, [True, True]), (text, []))

    def test_no_page_means_nothing_to_check(self):
        self.assertIsNone(W.check(Path("/nonexistent/site/landing/index.html"), ["`h1`"]))


class BrowserStand(Stand):
    """The judge on a real built page, in a Python with Playwright."""

    def __init__(self):
        super().__init__()
        site = self.page.parent.parent / "site" / "landing"
        site.mkdir(parents=True)
        (site / "index.html").write_text("<!doctype html><meta charset=utf-8><main><h1>Сайт</h1></main>"
                                         "<div style='height:2000px'></div>", encoding="utf-8")
        os.utime(site / "index.html", (1, 1))          # older than the contact sheet: the judge does not refuse

    def run(self, model, *extra):
        r = subprocess.run([BROWSER_PY, str(HARNESS / "judge.py"), "--page", str(self.page), "--transcripts",
                            str(self.tdir), "--proxy", model.url, *extra], capture_output=True, text=True,
                           encoding="utf-8", timeout=120)
        out = r.stdout.strip().splitlines()
        return r.returncode, (json.loads(out[-1]) if r.returncode == 0 and out else r.stdout + r.stderr)


@unittest.skipUnless(BROWSER_PY, "BRAND_PYTHON: a Python with Playwright and Chromium")
class JudgeOnThePage(unittest.TestCase):
    def setUp(self):
        self.s = BrowserStand()

    def tearDown(self):
        self.s.close()

    def test_a_blocker_with_no_place_on_the_page_does_not_hold_the_verdict(self):
        ghost = ROW.format(sev="Blocker", what="бледный текст на кадре").replace("`main > h1`", "`.fade-in .ghost`")
        far = ROW.format(sev="Critical", what="наложение").replace("`main > h1`", "390, y=99999")
        m = Model([answer(1, yes=Q.IDS, rows=[ghost, far], verdict="FAIL")])
        try:
            code, out = self.s.run(m)
            self.assertEqual(code, 0, out)
            self.assertEqual((out["verdict"], out["unconfirmed"]), ("PASS", 2))
            md = self.s.judge_md()
            self.assertIn("## Не подтверждено кодом", md)
            self.assertNotIn("| Blocker |", md)
            # the transcript flow.py compares is the same text
            recs = [json.loads(x) for x in (self.s.tdir / "judge.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(recs[-1]["message"]["content"][0]["content"][0]["text"], md)
        finally:
            m.close()

    def test_a_blocker_on_a_real_element_still_holds_fail(self):
        real = ROW.format(sev="Blocker", what="заголовок не виден")
        region = ROW.format(sev="Critical", what="наложение").replace("`main > h1`", "390, y=1200")
        m = Model([answer(1, yes=Q.IDS, rows=[real, region], verdict="PASS")])
        try:
            code, out = self.s.run(m)
            self.assertEqual((code, out["verdict"], out["unconfirmed"]), (0, "FAIL", 0))
        finally:
            m.close()


if __name__ == "__main__":
    unittest.main()
