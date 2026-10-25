import unittest

from delivery import delivery_cost


class DeliveryTest(unittest.TestCase):
    def test_paid(self):
        self.assertEqual(delivery_cost(1000), 300)

    def test_free(self):
        self.assertEqual(delivery_cost(3000), 0)

    def test_just_below(self):
        self.assertEqual(delivery_cost(2999), 300)

    def test_middle(self):
        self.assertEqual(delivery_cost(2600), 300)


if __name__ == "__main__":
    unittest.main()
