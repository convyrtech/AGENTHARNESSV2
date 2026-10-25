"""Вызов инструмента, пришедший текстом (E9 A/B: DeepSeek, разметка DSML), не кончает шаг: харнесс продолжает ту же
сессию просьбой повторить вызов. python -m unittest discover -s playbooks/site/harness/tests"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
FAKE = r'''
import json, os
f = os.environ["FAKE_N"]
n = int(open(f).read()) if os.path.exists(f) else 0
open(f, "w").write(str(n + 1))
mode = os.environ["FAKE_MODE"]
think = "Let me check motion.js for a resize handler. " * 30
leak = [{"type": "thinking", "thinking": think},
        {"type": "text", "text": think + "</｜ DSML｜ parameter>\n</｜ DSML｜ invoke>\n</｜ DSML｜ calls>"}]
if mode == "always" or n == 0:
    content = leak
else:
    print(json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "toolUse",
          "content": [{"type": "toolCall", "name": "bash", "arguments": {"command": "ls"}}]}}))
    content = [{"type": "text", "text": "Готово.\nЭТАП ГОТОВ"}]
print(json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": content}}))
'''


def load_run(pi_bin):
    os.environ["PI_BIN"] = json.dumps(pi_bin)
    src = (HERE / "run.py").read_text(encoding="utf-8").split('if __name__ == "__main__":')[0]
    g = {"__name__": "run_under_test", "__file__": str(HERE / "run.py")}
    exec(compile(src, str(HERE / "run.py"), "exec"), g)
    return g


class Leak(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "fakepi.py").write_text(FAKE, encoding="utf-8")
        (self.tmp / "ws").mkdir()
        os.environ["FAKE_N"] = str(self.tmp / "n")
        self.g = load_run([sys.executable, str(self.tmp / "fakepi.py")])
        self.cfg = {"max_minutes": 5, "same_call_limit": 3, "max_calls": 50}

        class W:
            root = self.tmp / "ws"

            def env(self):
                return dict(os.environ)
        self.ws = W()

    def run_stage(self, mode):
        os.environ["FAKE_MODE"] = mode
        return self.g["run_stage"](self.ws, "7", "задание", "m", self.cfg, self.tmp / "7-1.jsonl")

    def test_patterns(self):
        leaked = self.g["leaked"]
        for s in ["x</｜DSML｜ invoke>", "<｜DSML｜calls>", "<｜tool▁calls▁begin｜>", "<｜tool▁sep｜>", "a</tool_call>",
                  "<|tool_calls_section_begin|>", "<|tool_call_begin|>"]:
            self.assertTrue(leaked(s, ""), s)
        self.assertFalse(leaked("Обычный ответ. ЭТАП ГОТОВ", ""))
        self.assertTrue(leaked("а" * 1200, "а" * 1200))        # текст дословно повторяет рассуждение
        self.assertFalse(leaked("а" * 200, "а" * 200))

    def test_retry_same_session(self):
        final, st = self.run_stage("once")
        self.assertTrue(final.endswith("ЭТАП ГОТОВ"))
        self.assertEqual((st["leaks"], st["calls"]), (1, 1))
        self.assertEqual(len(list(self.tmp.glob("7-1-*.brief.md"))), 2)

    def test_gives_up_without_garbage(self):
        final, st = self.run_stage("always")
        self.assertEqual(final, "")                             # разметку не показываем владельцу
        self.assertEqual(st["leaks"], self.g["LEAK_RETRIES"])


if __name__ == "__main__":
    unittest.main()
