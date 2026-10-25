"""python3 -m unittest experiments/research/test_score.py — оценка набора «Исследовать» без сети."""
import json, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score  # noqa: E402

QUESTIONS = json.loads((Path(__file__).resolve().parent / "questions.json").read_text(encoding="utf-8"))["questions"]


class Normalize(unittest.TestCase):
    def test_answer(self):
        self.assertEqual(score.norm_answer("МРОТ — 27 093 ₽, ставка 0,65 ₽; Ёлка"), "мрот — 27093 ₽, ставка 0.65 ₽; елка")
        self.assertEqual(score.norm_answer("1 000 000 рублей"), "1000000 рублей")

    def test_quote(self):
        page = "Налоговая ставка устанавливается в размере **25 процентов**, если иное не установлено"
        q = "«налоговая ставка устанавливается в размере 25 процентов»"
        self.assertIn(score.norm_quote(q), score.norm_quote(page))
        self.assertFalse(score.quote_long_enough("25 %"))
        self.assertTrue(score.quote_long_enough("ставка 25 процентов"))


class Check(unittest.TestCase):
    def test_number_tolerance(self):
        ref = {"number": 80.5381, "tol": 0.06}
        self.assertTrue(score.check(ref, "Курс — 80,54 ₽ за доллар")[0])
        self.assertFalse(score.check(ref, "Курс — 92,1 ₽")[0])

    def test_frozen_references_accept_their_own_answer_and_refuse_stale(self):
        byid = {q["id"]: q for q in QUESTIONS}
        for q in QUESTIONS:
            if "ref" in q:
                self.assertTrue(score.check(q["ref"], q["answer"])[0], q["id"])
        self.assertFalse(score.check(byid["r06"]["ref"], "Ставка НДС — 20%.")[0])
        self.assertFalse(score.check(byid["r04"]["ref"], "МРОТ в 2026 году — 22 440 ₽.")[0])
        self.assertFalse(score.check(byid["r05"]["ref"], "С 2027 года МРОТ составит 28 935 ₽.")[0])   # не сказал, что это проект
        self.assertFalse(score.check(byid["i07"]["ref"], "GPT Researcher распространяется по лицензии MIT.")[0])

    def test_empty(self):
        self.assertEqual(score.check({"must": ["x"]}, ""), (False, "пустой ответ"))


class Metrics(unittest.TestCase):
    def test_past_year_queries(self):
        bad = score.past_year_queries("Какой МРОТ в 2026 году?", ["МРОТ 2026", "МРОТ 2024 сколько", "мрот"], 2026)
        self.assertEqual(bad, ["МРОТ 2024 сколько"])
        self.assertEqual(score.past_year_queries("Налог на имущество за 2025 год", ["налог 2025"], 2026), [])

    def test_percentiles(self):
        self.assertEqual(score.pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5.5)
        self.assertEqual(score.pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1)
        self.assertIsNone(score.pct([None], 0.5))

    def test_report_without_network(self):
        results = [{"id": "r04", "answer": "27 093 ₽", "sources": [{"url": "https://x", "quote": "q q q", "date": "2026-10-01"}],
                    "queries": ["мрот 2024"], "cost_usd": 0.02, "seconds": 30},
                   {"id": "r06", "answer": "20%", "sources": [], "cost_usd": 0.01, "seconds": 10}]
        out = Path(tempfile.mkdtemp())
        s, rows = score.score(results, [q for q in QUESTIONS if q["id"] in ("r04", "r06")], out, fetch=False)
        self.assertEqual(s["accuracy"], 0.5)
        self.assertEqual(s["sources_dated_share"], 1.0)
        self.assertEqual([x["query"] for x in s["past_year_queries"]], ["мрот 2024"])
        self.assertTrue((out / "report.md").read_text(encoding="utf-8").startswith("# Набор «Исследовать»"))


if __name__ == "__main__":
    unittest.main()
