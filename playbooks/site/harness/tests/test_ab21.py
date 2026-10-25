"""A/B of the parallel step 5 (#21): the arm in the run record, quality from the judge, the blind step-5 sheet.

  python -m unittest discover -s playbooks/site/harness/tests
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parent
sys.path.insert(0, str(HERE))
from test_ab import lab, simulate  # noqa: E402
from test_ask_owner import load_run  # noqa: E402


def abreport():
    spec = importlib.util.spec_from_file_location("abreport", HARNESS / "abreport.py")
    ab = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ab)
    return ab


class Quality(unittest.TestCase):
    def test_judge_quality_from_fields_and_from_old_output(self):
        ab = abreport()
        ledger = [
            {"kind": "judge", "exit": 0, "round": 1, "verdict": "FAIL", "findings": {"Blocker": 1, "Major": 2}},
            # an old record: only the tail of judge.py's output
            {"kind": "judge", "exit": 0, "out": "заметка\n" + json.dumps({"round": 2, "verdict": "FAIL",
                                                                           "findings": {"Critical": 1}})},
            {"kind": "judge", "exit": 0, "round": 3, "verdict": "PASS", "findings": {"Minor": 1}},
        ]
        self.assertEqual(ab.judge_quality(ledger), {
            "rounds": ["1:FAIL", "2:FAIL", "3:PASS"], "first": "FAIL", "first_heavy": 1, "final": "PASS",
            "final_heavy": 0, "rounds_to_pass": 3, "cap": False})
        capped = ab.judge_quality([{"kind": "judge", "exit": 0, "round": 1, "verdict": "FAIL", "findings": {}},
                                   {"kind": "judge", "exit": 3, "out": "лимит"}])
        self.assertEqual((capped["rounds_to_pass"], capped["cap"], capped["final"]), (None, True, "FAIL"))
        self.assertEqual(ab.judge_quality([])["first"], None)

    def test_run_judge_keeps_the_verdict_when_the_output_is_long(self):
        g = load_run()
        long = {"round": 1, "verdict": "PASS", "findings": {"Minor": 2}, "yes": 12, "no": [],
                "images": [f"contact-chromium-{i:04d}.png" for i in range(60)]}
        self.assertGreater(len(json.dumps(long)), 400)
        g["subprocess"] = types.SimpleNamespace(
            run=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="заметка\n" + json.dumps(long)))
        rows = []
        ws = types.SimpleNamespace(page=Path("p"), h=Path("h"), pipe=Path("pipe"), root=Path("."), state={},
                                   ledger=lambda **r: rows.append(r))
        g["run_judge"](ws)
        self.assertEqual({k: rows[0][k] for k in ("verdict", "round", "findings", "yes")},
                         {"verdict": "PASS", "round": 1, "findings": {"Minor": 2}, "yes": 12})

    def test_step5_items_are_every_prototype_of_both_runs(self):
        ab = abreport()
        root = Path(tempfile.mkdtemp())
        for arm, letters in (("on", "ab"), ("off", "a")):
            for x in letters:
                d = root / arm / "design" / "landing" / "05-proto" / x
                d.mkdir(parents=True)
                (d / "index.html").write_text("<p>x</p>", encoding="utf-8")
        items = ab.step5_items({"ws": str(root / "on"), "page": "landing"}, "A") + \
            ab.step5_items({"ws": str(root / "off"), "page": "landing"}, "B")
        self.assertEqual([(w, p.parent.name) for w, p in items], [("A", "a"), ("A", "b"), ("B", "a")])
        self.assertEqual(ab.step5_items({"ws": str(root / "none"), "page": "landing"}, "A"), [])


class Arm(unittest.TestCase):
    def test_simulate_records_the_arm_and_the_report_names_it(self):
        tmp = tempfile.TemporaryDirectory(prefix="ab21-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        h, pipe, mats = lab(root)
        recs = {}
        for arm in ("on", "off"):
            _ws, rec, r = simulate(h, pipe, mats, root, "run", f"плечо-{arm}", "--parallel5", arm, "--max-turns", "2")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            recs[arm] = rec
            run = json.loads((rec / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(run["parallel5"], arm == "on")
        out = root / "report"
        r = subprocess.run([sys.executable, str(h / "abreport.py"), "compare", str(recs["off"]), str(recs["on"]),
                            "--out", str(out)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        md = (out / "report.md").read_text(encoding="utf-8")
        self.assertIn("шаг 5 обычный", md)
        self.assertIn("шаг 5 параллельно", md)
        self.assertIn("| Шаг 5 параллельно (#21) | выкл | вкл |", md)
        self.assertIn("Судья, раунд 1", md)
        rep = json.loads((out / "report.json").read_text(encoding="utf-8"))
        self.assertIn("error", rep["blind_step5"])                   # stub runs have no prototypes


if __name__ == "__main__":
    unittest.main()
