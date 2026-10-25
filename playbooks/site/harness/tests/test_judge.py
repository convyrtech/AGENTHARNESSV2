"""Судья с вопросами «да/нет» (research/20 §9): вердикт кодом, раунд 2+ перепроверяет только «нет», формат JUDGE.md
для flow.py прежний. judge.py идёт целиком против поддельной модели (поток SSE) и заглушки flow.py с теми же
функциями, что зовёт судья. python -m unittest discover -s playbooks/site/harness/tests"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import judge_questions as Q  # noqa: E402

# Заглушка flow.py: только то, что зовёт judge.py, по смыслу правил пайплайна (таблица находок с «Где» и «Статус»).
FLOW = r'''
import re
from pathlib import Path
JUDGE_MARK = "JUDGE-PROMPT v2"
WHERE = re.compile(r"`[^`]+`|\d{3,4}\s*,\s*y\s*=")
class Page:
    def __init__(self, d, t):
        self.root = Path(d).parent.parent
    def f(self, name):
        return ""
def source_files(root, spec):
    return [p for p in Path(root).rglob("*.html")]
def newest_mtime(files):
    return max([f.stat().st_mtime for f in files] or [0])
def judge_lines(text):
    rows = []
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if line.lstrip().startswith("|") and len(cells) >= 4 and re.match(r"(blocker|critical|major|minor)", cells[0], re.I):
            if not re.search(r"исправ|fixed", cells[3], re.I):
                rows.append((cells[0] + " " + cells[1], cells[2]))
    return rows, []
def meaningful(s):
    return bool(s and re.search(r"(?m)^\s*-\s+\S", s))
def section(text, pat):
    m = re.search(r"(?msi)^##[^\n]*" + pat + r"[^\n]*\n(.*?)(?=^## |\Z)", text)
    return m.group(1) if m else None
'''

ROW = "| {sev} | {what} | `main > h1` | открыто |"
TABLE = "| Серьёзность | Находка | Где | Статус |\n|---|---|---|---|\n"


def answer(rnd, yes=(), no=(), rows=(), verdict="FAIL", block=True):
    lines = [f"JUDGE-VERDICT: {verdict}", f"РАУНД: {rnd}", "", "## Находки", TABLE + "\n".join(rows), "",
             "## Что я НЕ проверила", "- звук", ""]
    if block:
        lines += [Q.HEADING, "```"] + [f"{q} ДА — видно на снимке" for q in yes] + \
                 [f"{q} НЕТ — не так. Где: 390, y=400" for q in no] + ["```"]
    return "\n".join(lines) + "\n"


class Model:
    """Поддельный /v1/chat/completions: отдаёт ответы по очереди потоком, запоминает запросы."""

    def __init__(self, replies):
        self.replies, self.requests = list(replies), []
        model = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model.requests.append(body)
                text = model.replies.pop(0) if model.replies else ""
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                chunk = {"choices": [{"delta": {"content": text}}]}
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                usage = {"usage": {"prompt_tokens": 1000, "completion_tokens": 200, "cost": 0.01}, "choices": []}
                self.wfile.write(f"data: {json.dumps(usage)}\n\ndata: [DONE]\n\n".encode())

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def prompt_text(self, i):
        return self.requests[i]["messages"][0]["content"][0]["text"]

    def close(self):
        self.server.shutdown()


class Stand:
    def __init__(self):
        from PIL import Image
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        pipe = root / "design-pipeline"
        (pipe / "tools").mkdir(parents=True)
        (pipe / "tools" / "flow.py").write_text(FLOW, encoding="utf-8")
        (pipe / "templates").mkdir()
        (pipe / "templates" / "JUDGE-PROMPT.md").write_text("шапка\nJUDGE-PROMPT v2\nСуди страницу.\n", encoding="utf-8")
        self.page = root / "design" / "landing"
        (self.page / "artifacts" / "visual-gate").mkdir(parents=True)
        (self.page / "index.html").write_text("<h1>Сайт</h1>", encoding="utf-8")
        os.utime(self.page / "index.html", (1, 1))
        Image.new("RGB", (40, 80), "white").save(self.page / "artifacts" / "visual-gate" / "contact-chromium-390.png")
        self.tdir = root / "harness-state"

    def run(self, model, *extra):
        r = subprocess.run([sys.executable, str(HERE / "judge.py"), "--page", str(self.page), "--transcripts",
                            str(self.tdir), "--proxy", model.url, *extra], capture_output=True, text=True,
                           encoding="utf-8", timeout=60)
        out = r.stdout.strip().splitlines()
        return r.returncode, (json.loads(out[-1]) if r.returncode == 0 and out else r.stdout + r.stderr)

    def judge_md(self):
        return (self.page / "artifacts" / "judge" / "JUDGE.md").read_text(encoding="utf-8")

    def close(self):
        self.tmp.cleanup()


class Questions(unittest.TestCase):
    def test_list_is_12_from_real_findings(self):
        self.assertEqual(len(Q.QUESTIONS), 12)
        for q, text, sev, src in Q.QUESTIONS:
            self.assertIn(sev, ("Major", "Minor"))
            self.assertTrue(text.endswith("?") and src, q)

    def test_parse_only_in_the_section(self):
        text = "Q1 ДА — до раздела\n" + Q.HEADING + "\n```\nQ1 НЕТ — нет кнопки. Где: 390, y=10\nq2 да — ok\nQ99 ДА — x\n```"
        self.assertEqual(Q.parse(text), {"Q1": {"yes": False, "reason": "нет кнопки. Где: 390, y=10"},
                                         "Q2": {"yes": True, "reason": "ok"}})

    def test_verdict(self):
        all_yes = {q: {"yes": True} for q in Q.IDS}
        self.assertEqual(Q.verdict(all_yes)[0], "PASS")
        self.assertEqual(Q.verdict(all_yes, blockers=1)[0], "FAIL")
        minor = dict(all_yes, Q3={"yes": False})
        self.assertEqual(Q.verdict(minor), ("PASS", ["Q3"]))
        self.assertEqual(Q.verdict(dict(minor, Q11={"yes": False}))[0], "FAIL")
        self.assertEqual(Q.verdict(dict(all_yes, Q5={"yes": False}))[0], "FAIL")

    def test_merge_keeps_yes_and_unanswered_is_no(self):
        prev = Q.merge(None, {"Q1": {"yes": True, "reason": "a"}, "Q2": {"yes": False, "reason": "b"}}, 1)
        self.assertEqual(prev["Q3"], {"yes": False, "reason": "судья не ответил", "round": 1})
        cur = Q.merge(prev, {"Q1": {"yes": False, "reason": "передумал"}, "Q2": {"yes": True, "reason": "есть"}}, 2)
        self.assertEqual(cur["Q1"], {"yes": True, "reason": "a", "round": 1})
        self.assertEqual(cur["Q2"], {"yes": True, "reason": "есть", "round": 2})

    def test_round_two_asks_only_previous_no(self):
        prev = Q.merge(None, {q: {"yes": q != "Q5", "reason": "x"} for q in Q.IDS}, 1)
        text = Q.block_prompt(2, prev)
        self.assertIn("- Q5. ", text)
        self.assertNotIn("- Q1. ", text)
        self.assertIn("Новых находок не добавляй, кроме Blocker", text)


class JudgeRun(unittest.TestCase):
    def setUp(self):
        self.s = Stand()

    def tearDown(self):
        self.s.close()

    def test_converges_round_two_rechecks_only_no(self):
        r1 = answer(1, yes=[q for q in Q.IDS if q not in ("Q5", "Q7")], no=["Q5", "Q7"],
                    rows=[ROW.format(sev="Major", what="число не из FACTS")])
        # раунд 2: модель «передумывает» по Q1 и находит новое Major — не считается
        r2 = answer(2, yes=["Q5", "Q7"], no=["Q1"], rows=[ROW.format(sev="Major", what="новая мелочь")], verdict="FAIL")
        m = Model([r1, r2])
        try:
            code, out = self.s.run(m)
            self.assertEqual(code, 0, out)
            self.assertEqual((out["verdict"], out["model_verdict"], out["yes"], out["no"]), ("FAIL", "FAIL", 10, ["Q5", "Q7"]))
            self.assertEqual(out["cost"], 0.01)
            self.assertIn("- Q1. Смысл понятен", m.prompt_text(0))
            code, out = self.s.run(m)
            self.assertEqual(code, 0, out)
            self.assertEqual((out["verdict"], out["yes"], out["asked"]), ("PASS", 12, ["Q5", "Q7"]))
            p2 = m.prompt_text(1)
            self.assertIn("- Q5. ", p2)
            self.assertNotIn("- Q1. ", p2)
            self.assertIn("Новых находок не ищи, кроме Blocker", p2)
            md = self.s.judge_md()
            self.assertTrue(md.startswith("JUDGE-VERDICT: PASS"))
            self.assertIn("РАУНД: 2", md)
            self.assertIn("ДА: 12/12", md)
            self.assertIn("Q1 ДА — видно на снимке (раунд 1)", md)
            self.assertIn("## Что я НЕ проверила", md)
            # переписка для flow.py — тот же текст, что JUDGE.md
            recs = [json.loads(x) for x in (self.s.tdir / "judge.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(recs[-1]["message"]["content"][0]["content"][0]["text"], md)
        finally:
            m.close()

    def test_open_blocker_keeps_fail_even_with_all_yes(self):
        m = Model([answer(1, yes=Q.IDS, rows=[ROW.format(sev="Blocker", what="страница пустая")], verdict="PASS")])
        try:
            code, out = self.s.run(m)
            self.assertEqual((code, out["verdict"], out["model_verdict"]), (0, "FAIL", "PASS"))
            self.assertTrue(self.s.judge_md().startswith("JUDGE-VERDICT: FAIL"))
        finally:
            m.close()

    def test_missing_answers_get_one_retry_then_count_as_no(self):
        part = answer(1, yes=Q.IDS[:10])
        m = Model([part, part])
        try:
            code, out = self.s.run(m)
            self.assertEqual(code, 0, out)
            # формат просят поправить (до двух раз), потом неотвеченное считается «нет»
            self.assertGreaterEqual(len(m.requests), 2)
            self.assertIn("для Q11, Q12", m.requests[1]["messages"][-1]["content"])
            self.assertEqual((out["verdict"], out["no"]), ("FAIL", ["Q11", "Q12"]))
            self.assertIn("Q12 НЕТ — судья не ответил", self.s.judge_md())
        finally:
            m.close()

    def test_questions_off_is_the_old_judge(self):
        m = Model([answer(1, rows=[ROW.format(sev="Minor", what="x")], verdict="PASS", block=False)])
        try:
            code, out = self.s.run(m, "--questions", "off")
            self.assertEqual((code, out["verdict"], out["yes"]), (0, "PASS", None))
            self.assertNotIn(Q.HEADING, m.prompt_text(0))
            self.assertNotIn(Q.HEADING, self.s.judge_md())
        finally:
            m.close()

    def test_round_limit_stays(self):
        m = Model([answer(r, yes=Q.IDS, no=[]) for r in (1, 2, 3)])
        try:
            for _ in range(3):
                self.assertEqual(self.s.run(m)[0], 0)
            self.assertEqual(self.s.run(m)[0], 3)
        finally:
            m.close()


class AB(unittest.TestCase):
    def test_ab_runs_both_judges_on_a_copy_and_prints_the_table(self):
        s = Stand()
        # прежний судья: FAIL три раунда подряд с растущими находками; новый: 11 «да» и одно Minor «нет» — PASS сразу
        old = [answer(r, rows=[ROW.format(sev="Major", what=f"н{i}") for i in range(r * 2)], block=False) for r in (1, 2, 3)]
        new = [answer(1, yes=[q for q in Q.IDS if q != "Q3"], no=["Q3"])]
        m = Model(old + new)
        try:
            out = Path(s.tmp.name) / "ab.json"
            r = subprocess.run([sys.executable, str(HERE / "judge_ab.py"), "--page", str(s.page), "--proxy", m.url,
                                "--out", str(out)], capture_output=True, text=True, encoding="utf-8", timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            rep = json.loads(out.read_text(encoding="utf-8"))[str(s.page)]
            self.assertEqual(rep["off"]["summary"]["pass_round"], None)
            self.assertEqual(rep["off"]["summary"]["findings_by_round"], [2, 4, 6])
            self.assertEqual(rep["on"]["summary"]["pass_round"], 1)
            self.assertEqual(rep["on"]["summary"]["yes_by_round"], [11])
            self.assertEqual(rep["on"]["summary"]["cost"], 0.01)
            self.assertIn("| прежний | — | 2 → 4 → 6 |", r.stdout)
            self.assertIn("| да/нет | 1 | 0 | 11 |", r.stdout)
            # оригинал не тронут: судья писал в копию
            self.assertFalse((s.page / "artifacts" / "judge").exists())
        finally:
            m.close()
            s.close()


if __name__ == "__main__":
    unittest.main()
