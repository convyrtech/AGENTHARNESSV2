import unittest

from shipping import shipping_cost


class ShippingTest(unittest.TestCase):
    def test_light(self):
        self.assertEqual(shipping_cost(0.5), 200)

    def test_one_kilo(self):
        self.assertEqual(shipping_cost(1), 200)

    def test_heavy(self):
        self.assertEqual(shipping_cost(2.5), 300)

    def test_exactly_one_kilo_counts_as_started(self):
        self.assertEqual(shipping_cost(1), 250)


if __name__ == "__main__":
    unittest.main()
