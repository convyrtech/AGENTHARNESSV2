"""Кнопки ответа владельцу из сообщений без строк «А. …» (просьба ui, этап 9) и человеческое название действия.
Тексты — настоящие сообщения A/B-прогона 2026-10-25 (app/apps/desktop/e2e/design/fixtures/ab-run-2026-10-25/sent)."""
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def load_run():
    src = (HERE / "run.py").read_text(encoding="utf-8").split('if __name__ == "__main__":')[0]
    g = {"__name__": "run_under_test", "__file__": str(HERE / "run.py")}
    exec(compile(src, str(HERE / "run.py"), "exec"), g)
    return g


G = load_run()


def opts(text):
    return [[(x["key"], x["label"], x["recommended"]) for x in g["options"]] for g in G["options_of"](text)]


class OwnerOptions(unittest.TestCase):
    def test_letters_inline_with_captions(self):
        t = ("design/landing/01-candidates.png\nA: прибор и три шага. B: выдача ключа со штампом. C: точка ведёт к подключению.\n"
             "Рекомендую A: он ближе к приборам PRSLOY. Какой ближе: A, B или C?")
        self.assertEqual(opts(t), [[("A", "A — прибор и три шага", True), ("B", "B — выдача ключа со штампом", False),
                                    ("C", "C — точка ведёт к подключению", False)]])

    def test_letters_or_word(self):
        t = "design/landing/05-compare.png\nРекомендую A: сразу видны расход и вход.\nБерём A, B или смешать?"
        self.assertEqual(opts(t), [[("A", "A", True), ("B", "B", False), ("смешать", "Смешать", False)]])

    def test_yes_no(self):
        t = "Лист: design/landing/08-preview.png\nРекомендую выложить на prsloy.online/landing/.\nВыкладываем?"
        self.assertEqual(opts(t), [[("да", "Да", True), ("нет", "Нет, поправить", False)]])

    def test_this_or_that(self):
        t = "design/landing/05-storyboard.png\nРекомендую ключевым первый экран.\nБерём его или экран с тремя шагами?"
        self.assertEqual(opts(t), [[("Берём его", "Берём его", True),
                                    ("экран с тремя шагами", "Экран с тремя шагами", False)]])

    def test_freeform_alternative_is_left_to_the_text_field(self):
        t = "design/landing/03-references.png\nРекомендую основу A + B + C.\nБерём эту комбинацию или назовёте другие буквы?"
        self.assertEqual(opts(t), [[("Берём эту комбинацию", "Берём эту комбинацию", True)]])

    def test_lettered_lines_win(self):
        t = "1. Для кого страница?\nА. Гости с телефона (рекомендую)\nБ. Компании на банкет"
        self.assertEqual(opts(t), [[("А", "Гости с телефона (рекомендую)", True), ("Б", "Компании на банкет", False)]])

    def test_no_question_no_buttons(self):
        self.assertEqual(opts("Пришлите, что есть: скрины, логотип."), [])


class Doing(unittest.TestCase):
    def test_known_actions(self):
        d = G["doing_of"]
        self.assertEqual(d("bash", "python3 -I design-pipeline/tools/gate.py --page design/x"),
                         "Проверяю страницу на телефоне и компьютере")
        self.assertEqual(d("read", '{"path": "design/landing/05-compare.png"}'), "Смотрю снимки")
        self.assertEqual(d("edit", '{"path": "site/landing/styles.css"}'), "Пишу страницу")
        self.assertIsNone(d("bash", "ls -la"))


if __name__ == "__main__":
    unittest.main()
