"""Пометки владельца кистью на картинке (research/20 §10): marks-*.png из «Дизайна» — строка в задание и модель со
зрением на этот ход. python -m unittest discover -s playbooks/site/harness/tests"""
import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def load_run():
    os.environ.setdefault("PI_BIN", json.dumps([sys.executable, "-c", "pass"]))
    src = (HERE / "run.py").read_text(encoding="utf-8").split('if __name__ == "__main__":')[0]
    g = {"__name__": "run_under_test", "__file__": str(HERE / "run.py")}
    exec(compile(src, str(HERE / "run.py"), "exec"), g)
    return g


class Marks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.g = load_run()

    def test_note_only_for_marks(self):
        note = self.g["marks_note"](["materials/logo.png", "materials/marks-01-candidates.png"])
        self.assertIn("materials/marks-01-candidates.png", note)
        self.assertIn("пометки владельца, не дизайн", note)
        self.assertNotIn("logo.png", note)
        self.assertEqual(self.g["marks_note"](["materials/logo.png", "materials/marks.txt"]), "")

    def test_vision_rung(self):
        ladder = ["a6p/deepseek-v4.1-flash-1017", "a6p/kimi-k3.1-pro", "a6p/qwen3.8-max", "a6p/claude-opus-5-5"]
        vm = self.g["vision_model"]
        self.assertEqual(vm(ladder, 0), "a6p/kimi-k3.1-pro")
        self.assertEqual(vm(ladder, 2), "a6p/claude-opus-5-5")          # qwen не видит картинки
        self.assertEqual(vm(ladder, 3), "a6p/claude-opus-5-5")
        self.assertEqual(vm(["a6p/qwen3.8-max", "a6p/kimi-k3.1-pro"], 1), "a6p/kimi-k3.1-pro")
        self.assertEqual(vm(["a6p/qwen3.8-max"], 0), "a6p/qwen3.8-max")   # без зрения в лестнице — как было


    def test_the_real_ladder_with_kimi_in_the_gateway(self):
        # 2026-10-25 12:54: kimi-k3.1-pro is in the gateway's /v1/models again — marks go to Kimi, not Opus
        cfg = json.loads((HERE / "stages.json").read_text(encoding="utf-8"))
        cfg = self.g["fit_ladder"](cfg, ["deepseek-v4.1-flash-1017", "kimi-k3.1-pro", "qwen3.8-max", "claude-opus-5-5"])
        start = cfg["defaults"].get("start", 0)
        self.assertEqual(self.g["vision_model"](cfg["ladder"], start), "a6p/kimi-k3.1-pro")
        # without Kimi in the gateway: Opus
        cfg = json.loads((HERE / "stages.json").read_text(encoding="utf-8"))
        cfg = self.g["fit_ladder"](cfg, ["qwen3.8-max", "claude-opus-5-5"])
        self.assertEqual(self.g["vision_model"](cfg["ladder"], 0), "a6p/claude-opus-5-5")


if __name__ == "__main__":
    unittest.main()
