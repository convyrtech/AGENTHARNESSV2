import unittest

from stats import average_check


class AverageCheckTest(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(average_check([100, 200, 300]), 200)

    def test_two(self):
        self.assertEqual(average_check([100, 150]), 125)

    def test_half(self):
        self.assertEqual(average_check([99, 100]), 99.5)

    def test_empty(self):
        self.assertEqual(average_check([]), 0)

    def test_four(self):
        self.assertEqual(average_check([10, 20, 30, 40]), 26)


if __name__ == "__main__":
    unittest.main()
