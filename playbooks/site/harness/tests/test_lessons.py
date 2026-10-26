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
                               "out": "ответ судьи с текстом", "end": "other", "ts": 1.0}, "0123456789ab")
        line = (Path(d) / "design-events.jsonl").read_text(encoding="utf-8")
        ev = json.loads(line)
        self.assertEqual(ev["killed"], "loop")
        self.assertEqual(ev["session"], "0123456789ab")                 # сессия для рефлектора (S7)
        self.assertIs(ev["error"], True)
        for bad in ("Иван", "секрет", "Откат", "судьи", "why", "out"):
            self.assertNotIn(bad, line)

    def test_session_is_the_project_not_the_process(self):
        # run.py запускается на каждое сообщение владельца: сессия журнала — из состояния проекта
        d, root = tempfile.mkdtemp(), Path(tempfile.mkdtemp()) / "сайт"
        root.mkdir()
        os.environ["HARNESS_LEARN_DIR"] = d
        os.environ.pop("HARNESS_STATE_DIR", None)
        for _turn in range(2):
            ws = self.g["WS"](root)
            ws.h.mkdir(parents=True, exist_ok=True)
            ws.ledger(kind="stage", gate="1", model="m")
        evs = [json.loads(x) for x in (Path(d) / "design-events.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len({e["session"] for e in evs}), 1)
        self.assertRegex(evs[0]["session"], r"^[0-9a-f]{12}$")

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

    def test_prsloy_catalog_2026_10_26_taste_on_kimi_mechanics_on_deepseek_opus_on_top(self):
        g = load_run()
        cat = set(["claude-fable-5", "claude-opus-5-5", "deepseek-v4.1-flash-1017", "gpt-6.1-sol", "gpt-image-2", "gpt-image-2.5", "grok-4.7", "kimi-k3.1-pro", "nano-banana-2.1", "nano-banana-pro", "qwen3.8-max"])                                # GET /v1/models on PRSLOY, 2026-10-26
        real = json.loads((HERE / "stages.json").read_text(encoding="utf-8"))
        c = g["fit_ladder"](real, cat, "prsloy")
        self.assertEqual(c["ladder"], ["a6p/deepseek-v4.1-flash-1017", "a6p/kimi-k3.1-pro", "a6p/claude-opus-5-5"])
        self.assertEqual(c["defaults"]["start"], 0)                   # mechanics: deepseek
        self.assertEqual({k: v["start"] for k, v in c["stages"].items() if k in ("1", "2", "5", "6")},
                         {"1": 1, "2": 1, "5": 1, "6": 1})            # taste: kimi
        self.assertEqual(c["judge"]["model"], "claude-opus-5-5")

    def test_prsloy_drops_qwen_its_channel_loses_system_messages_and_images(self):
        g = load_run()
        cfg = dict(self.cfg(), gateway_skip={"prsloy": ["qwen"]})
        cfg["stages"]["5"] = {"start": 2}
        c = g["fit_ladder"](json.loads(json.dumps(cfg)), {"qwen3.8-max", "claude-opus-5-5", "gpt-6.1-sol"}, "prsloy")
        self.assertEqual(c["ladder"], ["a6p/claude-opus-5-5"])
        self.assertEqual((c["defaults"]["start"], c["stages"]["1"]["start"]), (0, 0))
        self.assertEqual(c["judge"]["model"], "claude-opus-5-5")
        # the model list did not load: qwen still goes, the rest of the ladder stays
        c = g["fit_ladder"](json.loads(json.dumps(cfg)), set(), "prsloy")
        self.assertEqual(c["ladder"], ["a6p/deepseek-v4.1-flash-1017", "a6p/kimi-k3.1-pro", "a6p/claude-opus-5-5"])
        self.assertEqual((c["stages"]["1"]["start"], c["stages"]["5"]["start"]), (1, 2))   # qwen's rung → opus
        # a6 (no gateway label): the ladder as written
        c = g["fit_ladder"](json.loads(json.dumps(cfg)), set(), "")
        self.assertIn("a6p/qwen3.8-max", c["ladder"])
        # the shipped stages.json says the same
        real = json.loads((HERE / "stages.json").read_text(encoding="utf-8"))
        self.assertNotIn("a6p/qwen3.8-max", g["fit_ladder"](real, set(), "prsloy")["ladder"])

    def test_judge_falls_back_only_to_a_visual_class_model(self):
        g = load_run()
        # research/28 §4.4: no Opus-class model — no judge (the owner is told), never Kimi
        c = g["fit_ladder"](self.cfg(), {"deepseek-v4.1-flash-1017", "kimi-k3.1-pro"})
        self.assertIsNone(c["judge"]["model"])
        # outside the ladder but served: gpt-6.1-sol judges
        c = g["fit_ladder"](self.cfg(), {"qwen3.8-max", "gpt-6.1-sol"})
        self.assertEqual(c["judge"]["model"], "gpt-6.1-sol")

    def test_no_visual_model_stops_with_plain_words(self):
        import types
        g = load_run()
        g["CFG"]["judge"]["model"] = None
        rows = []
        ws = types.SimpleNamespace(ledger=lambda **r: rows.append(r))
        code, out = g["run_judge"](ws)
        self.assertEqual((code, rows[0]["exit"]), (5, 5))
        self.assertIn("Opus", out)

    def test_judge_gets_three_images(self):
        import types
        g = load_run()
        g["CFG"]["judge"]["model"] = "claude-opus-5-5"
        seen = {}
        g["subprocess"] = types.SimpleNamespace(
            run=lambda args, **k: seen.setdefault("args", args) and types.SimpleNamespace(returncode=1, stdout=""))
        ws = types.SimpleNamespace(page=Path("p"), h=Path("h"), pipe=Path("pipe"), root=Path("."), state={},
                                   ledger=lambda **r: None)
        g["run_judge"](ws)
        a = seen["args"]
        self.assertEqual(a[a.index("--max-images") + 1], "3")

    def test_nothing_known_keeps_config(self):
        g = load_run()
        self.assertEqual(g["fit_ladder"](self.cfg(), {"grok-4.7"})["ladder"][0], "a6p/deepseek-v4.1-flash-1017")
        self.assertEqual(g["fit_ladder"](self.cfg(), set())["ladder"][0], "a6p/deepseek-v4.1-flash-1017")
