"""Правка владельца на готовой странице: run.py say --edit (research/20 §1–2). Снимки «до/после» требуют Playwright с
Chromium — без него тест пропускается."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
FAKE = r'''
import json, sys
from pathlib import Path
mode, n_file = sys.argv[1], Path(sys.argv[2])
n = int(n_file.read_text()) if n_file.exists() else 0
n_file.write_text(str(n + 1))
html = Path("site/landing/index.html"); s = html.read_text(encoding="utf-8")
if n == 0:
    s = s.replace("Старый заголовок", "Новый заголовок")
    if mode == "stray":
        s = s.replace("Нижний текст", "Нижний текст!")
    say = "Поменял заголовок."
else:
    s = s.replace("Нижний текст!", "Нижний текст")
    say = "Вернул лишнее."
html.write_text(s, encoding="utf-8")
print(json.dumps({"type": "message_end", "message": {"role": "assistant", "stopReason": "stop",
      "content": [{"type": "text", "text": say + "\nЭТАП ГОТОВ"}]}}))
'''
PAGE = """<!doctype html><html lang="ru"><meta charset="utf-8"><body style="margin:0;font:20px sans-serif">
<header><h1 data-signature>Старый заголовок</h1></header><section><p>Нижний текст</p></section></body></html>"""


def has_browser():
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.launch().close()
        return True
    except Exception:
        return False


@unittest.skipUnless(has_browser(), "нет Playwright с Chromium")
class EditTurn(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        ws = self.tmp / "ws"
        (ws / "site" / "landing").mkdir(parents=True)
        (ws / "design" / "landing").mkdir(parents=True)
        (ws / "owner").mkdir()
        (ws / "site" / "landing" / "index.html").write_text(PAGE, encoding="utf-8")
        # страница до правки проходит check.py: правка отвечает только за новые провалы
        (ws / "design" / "landing" / "04-motion.md").write_text(
            "# Движение\n\n## Фирменный приём\nКадр эталона 0:03 → заголовок проявляется линией.\n", encoding="utf-8")
        st = self.tmp / "state"
        st.mkdir()
        (st / "state.json").write_text(json.dumps({"page": "landing", "turn": 1}), encoding="utf-8")
        shutil.copy(HERE / "check.py", st / "check.py")
        (self.tmp / "fakepi.py").write_text(FAKE, encoding="utf-8")
        self.ws, self.st = ws, st

    def say(self, *args, mode="clean"):
        env = {"HARNESS_STATE_DIR": str(self.st), "PATH": "/usr/bin:/bin",
               "PI_BIN": json.dumps([sys.executable, str(self.tmp / "fakepi.py"), mode, str(self.tmp / "n")])}
        import os
        env = {**os.environ, **env}
        r = subprocess.run([sys.executable, "-I", str(HERE / "run.py"), "say", str(self.ws), *args], env=env,
                           capture_output=True, text=True, encoding="utf-8", timeout=300)
        return [json.loads(x) for x in r.stdout.splitlines() if x.startswith("{")]

    def html(self):
        return (self.ws / "site" / "landing" / "index.html").read_text(encoding="utf-8")

    def pins(self):
        return json.dumps({"pins": [{"selector": "h1", "nth": 1, "text": "Старый заголовок", "request": "новый",
                                     "width": 800}]}, ensure_ascii=False)

    def test_clean_edit_one_session_keep_recommended(self):
        ev = self.say("--edit", self.pins())
        owner = [e for e in ev if e.get("ev") == "owner"][-1]
        self.assertIn("Поменял заголовок.", owner["text"])
        opts = owner["options"][0]["options"]
        self.assertEqual((opts[0]["key"], opts[0]["recommended"]), ("edit:keep:1", True))
        self.assertEqual((self.tmp / "n").read_text(), "1")
        self.assertIn("Новый заголовок", self.html())

    def test_stray_change_is_sent_back(self):
        self.say("--edit", self.pins(), mode="stray")
        self.assertEqual((self.tmp / "n").read_text(), "2")      # второй заход — исправление лишнего
        self.assertNotIn("Нижний текст!", self.html())

    def test_revert(self):
        self.say("--edit", self.pins())
        ev = self.say("edit:revert:1")
        self.assertEqual(ev[-1]["ev"], "done")
        self.assertIn("Старый заголовок", self.html())
        self.assertFalse((self.ws / "owner" / "messages.jsonl").exists())   # служебный ответ не в переписке


if __name__ == "__main__":
    unittest.main()
