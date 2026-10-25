"""Уроки шагов дизайна по моделям и журнал событий без текстов (research/18 §8, S0b + S2).
python -m unittest discover -s playbooks/site/harness/tests"""
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def load_run():
    src = (HERE / "run.py").read_text(encoding="utf-8").split('if __name__ == "__main__":')[0]
    g = {"__name__": "run_under_test", "__file__": str(HERE / "run.py")}
    exec(compile(src, str(HERE / "run.py"), "exec"), g)
    return g


class Lessons(unittest.TestCase):
    def setUp(self):
        os.environ.pop("HARNESS_LESSONS", None)
        os.environ.pop("HARNESS_LEARN_DIR", None)
        self.g = load_run()

    def ids(self, gate, model):
        return [x["id"] for x in self.g["lessons_for"](gate, model)]

    def test_only_active_and_trial_for_that_model(self):
        self.assertEqual(self.ids("3", "a6p/qwen3.8-max"), ["L-d3-qwen-refs-catalog"])
        self.assertEqual(self.ids("3", "a6p/kimi-k3.1-pro"), [])          # урок не для Kimi
        self.assertEqual(self.ids("7", "a6p/deepseek-v4.1-flash-1017"), [])  # candidate не показывается
        self.assertEqual(self.ids("8", "a6p/qwen3.8-max"), [])           # retired не показывается

    def test_switch_off(self):
        os.environ["HARNESS_LESSONS"] = "0"
        self.assertEqual(self.ids("3", "a6p/qwen3.8-max"), [])

    def test_caps(self):
        many = [{"id": f"x{i}", "gate": "*", "models": ["*"], "status": "active", "text": "у" * 150} for i in range(9)]
        self.g["LESSONS"][:] = many
        got = self.g["lessons_for"]("1", "m")
        self.assertLessEqual(len(got), 5)
        self.assertLessEqual(sum(len(x["text"]) for x in got), 900)

    def test_events_have_no_texts(self):
        d = tempfile.mkdtemp()
        os.environ["HARNESS_LEARN_DIR"] = d
        self.g["learn_event"]({"kind": "stage", "gate": "7", "model": "a6p/deepseek", "calls": 40,
                               "killed": "петля: один и тот же вызов 3 раза (read {\"path\": \"C:/Users/Иван/x.png\"})",
                               "error": "секретный текст ошибки", "why": ["«Откат: нет» не конкретен"],
                               "out": "ответ судьи с текстом", "end": "other", "ts": 1.0})
        line = (Path(d) / "design-events.jsonl").read_text(encoding="utf-8")
        ev = json.loads(line)
        self.assertEqual(ev["killed"], "loop")
        self.assertRegex(ev["session"], r"^[0-9a-f]{12}$")              # сессия для рефлектора (S7)
        self.assertIs(ev["error"], True)
        for bad in ("Иван", "секрет", "Откат", "судьи", "why", "out"):
            self.assertNotIn(bad, line)

    def test_no_dir_no_events(self):
        self.g["learn_event"]({"kind": "stage"})           # без HARNESS_LEARN_DIR — тихо ничего


if __name__ == "__main__":
    unittest.main()


class FitLadder(unittest.TestCase):
    """Лестница по моделям шлюза (HARNESS_MODELS): живой PRSLOY 2026-10-25 отдавал qwen, opus, gpt, grok, fable."""

    def cfg(self):
        return {"ladder": ["a6p/deepseek-v4.1-flash-1017", "a6p/kimi-k3.1-pro", "a6p/qwen3.8-max", "a6p/claude-opus-5-5"],
                "judge": {"model": "claude-opus-5-5"}, "defaults": {"start": 0},
                "stages": {"1": {"start": 1}, "7": {"start": 0}, "2": {}}}

    def test_prsloy_today(self):
        g = load_run()
        c = g["fit_ladder"](self.cfg(), {"qwen3.8-max", "claude-opus-5-5", "gpt-6.1-sol"})
        self.assertEqual(c["ladder"], ["a6p/qwen3.8-max", "a6p/claude-opus-5-5"])
        self.assertEqual(c["defaults"]["start"], 0)        # deepseek → qwen
        self.assertEqual(c["stages"]["1"]["start"], 0)     # kimi → ближайшая выше: qwen
        self.assertEqual(c["judge"]["model"], "claude-opus-5-5")

    def test_judge_falls_back_to_strongest(self):
        g = load_run()
        c = g["fit_ladder"](self.cfg(), {"deepseek-v4.1-flash-1017", "kimi-k3.1-pro"})
        self.assertEqual(c["judge"]["model"], "kimi-k3.1-pro")

    def test_nothing_known_keeps_config(self):
        g = load_run()
        self.assertEqual(g["fit_ladder"](self.cfg(), {"grok-4.7"})["ladder"][0], "a6p/deepseek-v4.1-flash-1017")
        self.assertEqual(g["fit_ladder"](self.cfg(), set())["ladder"][0], "a6p/deepseek-v4.1-flash-1017")
