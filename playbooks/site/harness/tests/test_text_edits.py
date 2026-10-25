"""The owner's own text edits (owner/text-edits.jsonl) in the pipeline's text checks, via pipeline-fixes.patch.

  DESIGN_PIPELINE=<design-pipeline copy> python -m unittest discover -s playbooks/site/harness/tests

The pipeline is private: without DESIGN_PIPELINE the tests are skipped. Its tools are copied to a temp folder, the patch
is applied the way run.py init does, and slop_lint / text_diff read plain text files (no browser).
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
PIPELINE = os.environ.get("DESIGN_PIPELINE", "")


@unittest.skipUnless(PIPELINE and (Path(PIPELINE) / "tools" / "slop_lint.py").exists(),
                     "DESIGN_PIPELINE (a design-pipeline copy) is not given")
class TextEdits(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        pipe = cls.tmp / "pipe"
        shutil.copytree(Path(PIPELINE) / "tools", pipe / "tools", ignore=shutil.ignore_patterns("__pycache__", "tests"))
        env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(cls.tmp)}
        r = subprocess.run(["git", "apply", "-p1", str(HARNESS / "pipeline-fixes.patch")], cwd=pipe, env=env,
                           capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        cls.tools = pipe / "tools"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def ws(self, edits, files):
        root = Path(tempfile.mkdtemp(dir=self.tmp))
        (root / "owner").mkdir()
        (root / "owner" / "text-edits.jsonl").write_text(
            "".join(json.dumps({"t": i, "file": "site/p/index.html", **e}, ensure_ascii=False) + "\n"
                    for i, e in enumerate(edits)), encoding="utf-8")
        for name, text in files.items():
            (root / name).write_text(text, encoding="utf-8")
        return root

    def tool(self, root, name, *args):
        env = {k: v for k, v in os.environ.items() if k != "DP_TEXT_EDITS"}
        r = subprocess.run([sys.executable, "-I", str(self.tools / name), *args, "--out", "out"], cwd=root, env=env,
                           capture_output=True, text=True, encoding="utf-8")
        report = next((root / "out").glob("*.json"))
        return r.returncode, json.loads(report.read_text(encoding="utf-8"))

    def test_slop_lint_spares_owner_words_only(self):
        root = self.ws([{"before": "Обжариваем сами.", "after": "Обжариваем сами — с рассветом!"},
                        {"before": "Кофе для своих", "after": "Мощь, магия и токены"}],
                       {"page.txt": "Обжариваем сами — с рассветом!\nМощь, магия и токены\nНаш кофе — лучший!\n"})
        code, rep = self.tool(root, "slop_lint.py", "--file", "page.txt", "--beginner")
        self.assertEqual(rep["ownerTextEdits"], 2)
        hits = {(f["rule"], f["selector"]) for f in rep["findings"]}
        self.assertEqual(hits, {("DASH", "строка 3"), ("EXCLAIM", "строка 3")})   # the model's line is still judged
        self.assertEqual(code, 1)

    def test_slop_lint_part_of_a_block(self):
        root = self.ws([{"before": "Обжариваем сами.", "after": "Обжариваем сами — с рассветом!"}],
                       {"page.txt": "Мы рядом. Обжариваем сами — с рассветом!\n"})
        code, rep = self.tool(root, "slop_lint.py", "--file", "page.txt")
        self.assertEqual((code, rep["findings"]), (0, []))

    def test_text_diff_reads_source_with_edits(self):
        root = self.ws([{"before": "Обжариваем сами.", "after": "Обжариваем сами, с рассветом."},
                        {"before": "Кофе для своих", "after": "Кофе для соседей"}],
                       {"source.txt": "Кофе для своих.\nОбжариваем сами.\nДоставка по городу за час.\n",
                        "page.txt": "Кофе для соседей\nОбжариваем сами, с рассветом.\nДоставка по городу за час.\n"})
        code, rep = self.tool(root, "text_diff.py", "--page-file", "page.txt", "--source", "source.txt")
        self.assertEqual((code, rep["missing"], rep["extraWordCount"]), (0, [], 0))

    def test_text_diff_owner_text_must_stay(self):
        # the model put the old words back: the owner's edit is missing, the old words are extra
        root = self.ws([{"before": "Кофе для своих", "after": "Кофе для соседей"}],
                       {"source.txt": "Кофе для своих.\nДоставка по городу за час.\n",
                        "page.txt": "Кофе для своих\nДоставка по городу за час.\n"})
        code, rep = self.tool(root, "text_diff.py", "--page-file", "page.txt", "--source", "source.txt")
        self.assertEqual(code, 1)
        self.assertEqual(rep["missing"][0]["sentence"], "кофе для соседей")

    def test_text_diff_passage_over_two_sentences(self):
        root = self.ws([{"before": "Кофе для своих. Обжариваем сами.", "after": "Свой кофе, своя обжарка."}],
                       {"source.txt": "Кофе для своих.\nОбжариваем сами.\nДоставка по городу за час.\n",
                        "page.txt": "Свой кофе, своя обжарка.\nДоставка по городу за час.\n"})
        code, rep = self.tool(root, "text_diff.py", "--page-file", "page.txt", "--source", "source.txt")
        self.assertEqual((code, rep["foundSentences"], rep["sourceSentences"]), (0, 2, 2))

    def test_no_edits_file_changes_nothing(self):
        root = Path(tempfile.mkdtemp(dir=self.tmp))
        (root / "page.txt").write_text("Наш кофе — лучший!\n", encoding="utf-8")
        code, rep = self.tool(root, "slop_lint.py", "--file", "page.txt")
        self.assertEqual((code, rep["ownerTextEdits"], len(rep["findings"])), (1, 0, 2))


if __name__ == "__main__":
    unittest.main()
