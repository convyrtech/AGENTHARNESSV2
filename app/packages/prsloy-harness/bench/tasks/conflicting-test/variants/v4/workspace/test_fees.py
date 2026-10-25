from fees import late_fee


def test_no_delay():
    assert late_fee(0) == 0


def test_few_days():
    assert late_fee(7) == 70


def test_cap():
    assert late_fee(60) == 500


def test_long_delay():
    assert late_fee(60) == 600
